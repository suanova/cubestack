import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setBranding } from "@/components/shell/brandingStore";
import LoginPage from "./page";

// The login page reads window.location.search (for ?next=) and navigates via
// window.location.assign on success. jsdom's location is read-only, so we swap
// in a controllable stub.
function installLocation(search: string) {
  const assign = vi.fn();
  const location = {
    search,
    assign,
    pathname: "/login",
    href: "",
    origin: "http://localhost",
    host: "localhost",
    protocol: "http:",
  };
  Object.defineProperty(window, "location", { configurable: true, value: location });
  return assign;
}

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(LoginPage));
  });
  return { container, root };
}

function stubLogin(response: { status: number; body?: object }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body ?? {},
    })),
  );
}

function fillInput(container: HTMLElement, dataOdId: string, value: string) {
  const input = container.querySelector(`[data-od-id="${dataOdId}"] input`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// What the browser's autofill leaves behind: the value is in the DOM, but no
// input event was fired, so React state never learns about it.
function autofill(container: HTMLElement, dataOdId: string, value: string) {
  const input = container.querySelector(`[data-od-id="${dataOdId}"] input`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
  });
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement;
  act(() => form.requestSubmit());
}

describe("login page", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    setBranding({ logo: null, title: null, subtitle: null });
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders the localized login form", () => {
    installLocation("");
    const { container, root } = renderPage();
    expect(container.textContent).toContain("登录 CubeStack");
    expect(container.querySelector('[data-od-id="login-submit"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("renders a custom logo and wordmark instead of the built-in brand", () => {
    installLocation("");
    const { container, root } = renderPage();
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    act(() => setBranding({ logo, title: "Acme Cloud", subtitle: "智能算力平台" }));

    const brand = container.querySelector('[data-od-id="login-brand"]') as HTMLElement;
    const image = brand.querySelector('[data-od-id="login-brand-logo"]') as HTMLImageElement;
    expect(image.getAttribute("src")).toBe(logo);
    // The logo and the custom wordmark are shown side by side.
    expect(brand.textContent).toContain("Acme Cloud");
    expect(brand.textContent).toContain("智能算力平台");
    expect(brand.textContent).not.toContain("CubeStack");

    act(() => root.unmount());
  });

  it("renders custom text even without a logo", () => {
    installLocation("");
    const { container, root } = renderPage();
    act(() => setBranding({ logo: null, title: "Acme Cloud", subtitle: "GPU Cloud" }));

    const brand = container.querySelector('[data-od-id="login-brand"]') as HTMLElement;
    expect(brand.textContent).toContain("Acme Cloud");
    expect(brand.textContent).toContain("GPU Cloud");
    expect(brand.querySelector('[data-od-id="login-brand-logo"]')).toBeNull();
    // The card heading uses the brand name too.
    expect(container.textContent).toContain("登录 Acme Cloud");

    act(() => root.unmount());
  });

  it("requires a username and password", async () => {
    installLocation("");
    stubLogin({ status: 401 });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    submitForm(container);
    await act(async () => {});

    expect(container.textContent).toContain("请输入密码");

    // Fill the password and clear the username to show the other requirement.
    fillInput(container, "login-password", "pw");
    fillInput(container, "login-username", "");
    submitForm(container);
    await act(async () => {});
    expect(container.textContent).toContain("请输入用户名");

    act(() => root.unmount());
  });

  it("submits credentials the browser autofilled behind React's back", async () => {
    // Autofill writes into the input without firing onChange, so the box holds
    // a value React never saw — the old controlled fields read that as "" and
    // wiped it. The submit reads the form, so the box the user sees filled is
    // what goes to the server.
    const assign = installLocation("");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: "admin" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = renderPage();

    autofill(container, "login-username", "admin");
    autofill(container, "login-password", "saved-secret");
    submitForm(container);
    await act(async () => {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ username: "admin", password: "saved-secret" });
    expect(assign).toHaveBeenCalledWith("/cubestack");
    act(() => root.unmount());
  });

  it("shows a localized error on bad credentials", async () => {
    installLocation("");
    stubLogin({ status: 401, body: { error: "用户名或密码错误" } });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "wrong");
    submitForm(container);
    await act(async () => {});

    expect(container.querySelector('[data-od-id="login-error"]')?.textContent).toContain("用户名或密码错误");
    act(() => root.unmount());
  });

  it("redirects to the originally requested page on success", async () => {
    const assign = installLocation("?next=/dashboards?dashboard=x");
    stubLogin({ status: 200, body: { user: "admin" } });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "correct");
    submitForm(container);
    await act(async () => {});

    expect(assign).toHaveBeenCalledWith("/cubestack/dashboards?dashboard=x");
    act(() => root.unmount());
  });

  it("redirects to / by default when no next param is present", async () => {
    const assign = installLocation("");
    stubLogin({ status: 200, body: { user: "admin" } });
    const { container, root } = renderPage();

    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "correct");
    submitForm(container);
    await act(async () => {});

    expect(assign).toHaveBeenCalledWith("/cubestack");
    act(() => root.unmount());
  });

  it("falls back to / for a cross-origin next (open-redirect guard)", async () => {
    // Decoded to /\/evil.example: a backslash is treated as a slash by
    // navigations, so it must not become //evil.example (a foreign origin).
    for (const next of ["/%5Cevil.example", "//evil.example", "https://evil.example"]) {
      const assign = installLocation(`?next=${next}`);
      stubLogin({ status: 200, body: { user: "admin" } });
      const { container, root } = renderPage();
      fillInput(container, "login-username", "admin");
      fillInput(container, "login-password", "correct");
      submitForm(container);
      await act(async () => {});
      expect(assign).toHaveBeenCalledWith("/cubestack");
      act(() => root.unmount());
    }
  });

  it("keeps a plain same-origin path from next", async () => {
    const assign = installLocation("?next=/dev-environments");
    stubLogin({ status: 200, body: { user: "admin" } });
    const { container, root } = renderPage();
    fillInput(container, "login-username", "admin");
    fillInput(container, "login-password", "correct");
    submitForm(container);
    await act(async () => {});
    expect(assign).toHaveBeenCalledWith("/cubestack/dev-environments");
    act(() => root.unmount());
  });

  it("updates the theme toggle label after a click", async () => {
    installLocation("");
    delete document.documentElement.dataset.theme;
    const { container, root } = renderPage();

    const toggle = container.querySelector('[data-od-id="theme-toggle"]') as HTMLButtonElement;
    const before = toggle.getAttribute("aria-label");
    act(() => toggle.click());
    const after = toggle.getAttribute("aria-label");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(after).not.toBe(before);
    expect(after).toBeTruthy();

    act(() => root.unmount());
  });
})