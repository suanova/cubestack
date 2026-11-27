import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getBrandingSnapshot, setBranding } from "@/components/shell/brandingStore";
import { MAX_UPLOAD_BYTES } from "@/lib/settings/logo";
import SettingsPage from "./page";

const LOGO = "data:image/png;base64,iVBORw0KGgo=";

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(SettingsPage));
  });
  return { container, root };
}

/** Type into one of the page's text fields. */
function fillField(container: HTMLElement, dataOdId: string, value: string) {
  const input = container.querySelector(`[data-od-id="${dataOdId}"] input`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A fetch stub whose GET/PUT answers the test sets. */
function stubBranding(routes: {
  get?: { status: number; body?: object };
  put?: { status: number; body?: object };
}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const route = init?.method === "PUT" ? routes.put : routes.get;
    const response = route ?? { status: 200, body: {} };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body ?? {},
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Pick a file in the page's hidden input and wait for FileReader. */
async function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector('[data-od-id="logo-file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("settings page", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setBranding({ logo: null, title: null, subtitle: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("offers the upload controls to an admin", async () => {
    stubBranding({ get: { status: 200, body: { logo: null, canEdit: true } } });
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="logo-file"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="logo-save"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="settings-readonly"]')).toBeNull();

    act(() => root.unmount());
  });

  it("shows the read-only notice to a non-admin", async () => {
    stubBranding({ get: { status: 200, body: { logo: null, canEdit: false } } });
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="settings-readonly"]')?.textContent).toContain("只有管理员");
    expect(container.querySelector('[data-od-id="logo-file"]')).toBeNull();

    act(() => root.unmount());
  });

  it("renders the stored logo as the preview", async () => {
    stubBranding({ get: { status: 200, body: { logo: LOGO, canEdit: true } } });
    const { container, root } = renderPage();
    await act(async () => {});

    const preview = container.querySelector('[data-od-id="logo-preview"] img') as HTMLImageElement;
    expect(preview.getAttribute("src")).toBe(LOGO);
    expect((container.querySelector('[data-od-id="logo-reset"]') as HTMLButtonElement).disabled).toBe(false);

    act(() => root.unmount());
  });

  it("reports a failed load", async () => {
    stubBranding({ get: { status: 500, body: { error: "brandingLoadFailed" } } });
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="settings-error"]')?.textContent).toContain("加载 logo 配置失败");
    // A failed read must not be reported as "you are not an admin".
    expect(container.querySelector('[data-od-id="settings-readonly"]')).toBeNull();

    act(() => root.unmount());
  });

  it("uploads a picked image and previews it before saving", async () => {
    stubBranding({ get: { status: 200, body: { logo: null, canEdit: true } } });
    const { container, root } = renderPage();
    await act(async () => {});

    await pickFile(container, new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));

    const preview = container.querySelector('[data-od-id="logo-preview"] img') as HTMLImageElement;
    expect(preview.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    expect(container.textContent).toContain("预览(尚未保存)");
    expect((container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).disabled).toBe(false);

    act(() => root.unmount());
  });

  it("rejects a file that cannot be shrunk under the stored size cap", async () => {
    stubBranding({ get: { status: 200, body: { logo: null, canEdit: true } } });
    const { container, root } = renderPage();
    await act(async () => {});

    // jsdom cannot decode an image, so the page keeps the original and the
    // stored-size check rejects it.
    const big = new File([new Uint8Array(256 * 1024 + 1)], "big.png", { type: "image/png" });
    await pickFile(container, big);

    expect(container.querySelector('[data-od-id="settings-error"]')?.textContent).toContain("256 KB");
    expect((container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).disabled).toBe(true);

    act(() => root.unmount());
  });

  it("rejects a file above the upload cap without reading it", async () => {
    stubBranding({ get: { status: 200, body: { logo: null, canEdit: true } } });
    const { container, root } = renderPage();
    await act(async () => {});

    const huge = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "huge.png", { type: "image/png" });
    await pickFile(container, huge);

    expect(container.querySelector('[data-od-id="settings-error"]')?.textContent).toContain("10 MB");
    expect((container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).disabled).toBe(true);

    act(() => root.unmount());
  });

  it("saves the picked logo and updates the sidebar store", async () => {
    const fetchMock = stubBranding({
      get: { status: 200, body: { logo: null, canEdit: true } },
      put: { status: 200, body: { logo: LOGO, title: null, subtitle: null, canEdit: true } },
    });
    const { container, root } = renderPage();
    await act(async () => {});

    await pickFile(container, new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));
    act(() => {
      (container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).click();
    });
    await act(async () => {});

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [string, RequestInit];
    expect(JSON.parse(String(putCall[1].body))).toEqual({
      logo: "data:image/png;base64,iVBORw==",
      title: null,
      subtitle: null,
    });
    expect(getBrandingSnapshot().logo).toBe(LOGO);
    expect(container.querySelector('[data-od-id="settings-message"]')?.textContent).toContain("logo 已保存");

    act(() => root.unmount());
  });

  it("customizes the brand name and subtitle", async () => {
    const fetchMock = stubBranding({
      get: { status: 200, body: { logo: null, title: "Old", subtitle: "Sub", canEdit: true } },
      put: { status: 200, body: { logo: null, title: "Acme Cloud", subtitle: "智能算力", canEdit: true } },
    });
    const { container, root } = renderPage();
    await act(async () => {});

    // The stored text is loaded into the fields.
    expect((container.querySelector('[data-od-id="brand-title"] input') as HTMLInputElement).value).toBe("Old");
    expect((container.querySelector('[data-od-id="brand-subtitle"] input') as HTMLInputElement).value).toBe("Sub");
    // No changes yet: Save stays disabled.
    expect((container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).disabled).toBe(true);

    fillField(container, "brand-title", "Acme Cloud");
    fillField(container, "brand-subtitle", "智能算力");

    // The text lives in its own fields, separate from the logo image.
    expect((container.querySelector('[data-od-id="brand-title"] input') as HTMLInputElement).value).toBe("Acme Cloud");
    expect((container.querySelector('[data-od-id="brand-subtitle"] input') as HTMLInputElement).value).toBe("智能算力");
    expect((container.querySelector('[data-od-id="logo-preview"]') as HTMLElement).textContent).toBe("");
    expect((container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      (container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).click();
    });
    await act(async () => {});

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [string, RequestInit];
    expect(JSON.parse(String(putCall[1].body))).toEqual({
      logo: null,
      title: "Acme Cloud",
      subtitle: "智能算力",
    });
    expect(getBrandingSnapshot()).toMatchObject({ title: "Acme Cloud", subtitle: "智能算力" });
    expect(container.querySelector('[data-od-id="settings-message"]')?.textContent).toContain("logo 已保存");

    act(() => root.unmount());
  });

  it("restores the default branding", async () => {
    const fetchMock = stubBranding({
      get: { status: 200, body: { logo: LOGO, title: "Acme", subtitle: "Cloud", canEdit: true } },
      put: { status: 200, body: { logo: null, title: null, subtitle: null, canEdit: true } },
    });
    const { container, root } = renderPage();
    await act(async () => {});

    act(() => {
      (container.querySelector('[data-od-id="logo-reset"]') as HTMLButtonElement).click();
    });
    await act(async () => {});

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [string, RequestInit];
    expect(JSON.parse(String(putCall[1].body))).toEqual({ logo: null, title: null, subtitle: null });
    expect(getBrandingSnapshot()).toEqual({ logo: null, title: null, subtitle: null });
    expect(container.querySelector('[data-od-id="logo-preview"] img')).toBeNull();
    expect((container.querySelector('[data-od-id="brand-title"] input') as HTMLInputElement).value).toBe("");
    expect((container.querySelector('[data-od-id="brand-subtitle"] input') as HTMLInputElement).value).toBe("");

    act(() => root.unmount());
  });

  it("surfaces a forbidden save", async () => {
    stubBranding({
      get: { status: 200, body: { logo: null, canEdit: true } },
      put: { status: 403, body: { error: "brandingForbidden" } },
    });
    const { container, root } = renderPage();
    await act(async () => {});

    await pickFile(container, new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));
    act(() => {
      (container.querySelector('[data-od-id="logo-save"]') as HTMLButtonElement).click();
    });
    await act(async () => {});

    expect(container.querySelector('[data-od-id="settings-error"]')?.textContent).toContain("只有管理员可以修改品牌标识");

    act(() => root.unmount());
  });
});
