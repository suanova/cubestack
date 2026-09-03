import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import InferenceServicesPage from "./page";
import { inferenceServiceList } from "@/test/fixtures/inferenceservices";

// The test files avoid JSX because tsconfig sets jsx: "preserve" (for Next),
// which vitest's import-analysis can't transform.
vi.mock("@/lib/perses/theme", () => ({
  platformPalette: {
    light: { accent: "#1677ff", bg: "#ffffff", surface: "#f7f8fa", fg: "#111111", muted: "#6b7280", border: "#d9dee7" },
    dark: { accent: "#1677ff", bg: "#111111", surface: "#1f1f1f", fg: "#ffffff", muted: "#9ca3af", border: "#34373c" },
  },
  usePlatformTheme: () => "light",
}));

describe("inference services page", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function renderPage() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(InferenceServicesPage));
    });
    return { container, root };
  }

  function stubData(items: unknown[], ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => (ok ? { items } : { error: "boom" }) })),
    );
  }

  it("shows a loading state until the cluster request resolves", () => {
    stubData([]);
    const { container, root } = renderPage();
    expect(container.querySelector('[data-od-id="infsvc-loading"]')).not.toBeNull();
    expect(container.textContent).toContain("加载中…");
    act(() => root.unmount());
  });

  it("renders the service table and defaults to the first service's detail", async () => {
    stubData(inferenceServiceList());
    const { container, root } = renderPage();
    await act(async () => {});

    // Service rows from real data.
    const rows = container.querySelectorAll('[data-od-id^="svc-row-"]');
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("dsv4-pro-pd");
    expect(container.textContent).toContain("dsv4-flash-pd");
    expect(container.textContent).toContain("sglang");
    expect(container.textContent).toContain("8 × MXC500");
    // Replicas render multi-line (decode / prefill / group each on its own row).
    expect(container.textContent).toContain("decode 2");
    expect(container.textContent).toContain("prefill 1");
    expect(container.textContent).toContain("group 1");
    // Both services are pending (no status yet from the controller).
    expect(container.textContent).toContain("Pending");

    // First in the list is selected (newest): its engine/value params show.
    expect(container.textContent).toContain("访问端点");
    expect(container.textContent).toContain("dsv4-pro");
    // No controller status -> metrics and conditions show their empty states.
    expect(container.querySelector('[data-od-id="metrics-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("扩缩容");
    expect(container.textContent).toContain("引擎参数");

    act(() => root.unmount());
  });

  it("switches the selected service when a row is clicked", async () => {
    stubData(inferenceServiceList());
    const { container, root } = renderPage();
    await act(async () => {});

    // Click the flash row -> its detail (internal endpoint placeholder) appears.
    const flashRow = container.querySelector('[data-od-id="svc-row-dsv4-flash-pd"]');
    expect(flashRow).not.toBeNull();
    await act(async () => {
      (flashRow as HTMLElement).click();
    });
    // The selected row is highlighted via accent background (assert by route marker).
    expect((flashRow as HTMLElement).style.background).toBe("var(--accent-soft)");

    act(() => root.unmount());
  });

  it("filters the table by status", async () => {
    stubData(inferenceServiceList());
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelectorAll('[data-od-id^="svc-row-"]')).toHaveLength(2);
    // "Ready" filter: no service is ready -> table empty state.
    const tabs = container.querySelectorAll('[role="tab"]');
    await act(async () => {
      (tabs[1] as HTMLElement).click(); // Ready
    });
    expect(container.querySelectorAll('[data-od-id^="svc-row-"]')).toHaveLength(0);
    expect(container.textContent).toContain("当前筛选条件下没有服务");

    act(() => root.unmount());
  });

  it("renders metrics values when Prometheus data is present", async () => {
    const list = inferenceServiceList();
    list[0].metrics = { qps: 42, p95: 412, tps: 1204, spark: [28, 31, 35, 33, 38, 44, 41, 46, 42, 48, 45, 42] };
    stubData(list);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="metrics-empty"]')).toBeNull();
    // QPS value renders in the metrics grid.
    const match = Array.from(container.querySelectorAll("div")).some((el) => el.textContent === "42");
    expect(match).toBe(true);

    act(() => root.unmount());
  });

  it("shows an error with a retry button when the cluster request fails", async () => {
    stubData([], false);
    const { container, root } = renderPage();
    await act(async () => {});
    expect(container.querySelector('[data-od-id="infsvc-error"]')).not.toBeNull();
    expect(container.textContent).toContain("重试");
    act(() => root.unmount());
  });
});
const OPTIONS = {
  namespaces: [{ name: "project-a" }, { name: "default" }],
  profiles: [
    {
      name: "metax-sglang-dsv4-pd",
      engine: "sglang",
      engineVersion: "vendor-0.5.12-rc1",
      vendor: "metax",
      models: ["MXC500"],
      architectures: ["deepseek_v4"],
      quantizations: ["w8a8"],
      gpuPerPod: 8,
      overrides: [
        { name: "decodeReplicas", type: "integer", min: 1, max: 16, enum: null, default: 1, description: null },
        { name: "prefillReplicas", type: "integer", min: 1, max: 8, enum: null, default: 1, description: null },
        { name: "groupSize", type: "integer", min: null, max: null, enum: [1, 2, 4], default: 1, description: null },
      ],
    },
  ],
  modelversions: [
    { name: "deepseek-v4-flash-w8a8-v1", model: "deepseek-v4-flash", version: "w8a8-v1", architecture: "deepseek_v4", quantization: "w8a8" },
  ],
};

describe("deploy wizard", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function renderWithBoth() {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/options")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => OPTIONS });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: inferenceServiceList() }) });
      }),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(InferenceServicesPage));
    });
    return { container, root };
  }

  it("opens the wizard, loads options and reaches step 2 with override inputs", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});

    // Open the deploy dialog.
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]');
    expect(deployBtn).not.toBeNull();
    await act(async () => {
      (deployBtn as HTMLElement).click();
    });
    await act(async () => {});

    // Dialog rendered into body; step 1 present, option data loaded (default profile).
    expect(document.body.textContent).toContain("部署推理服务");
    expect(document.body.textContent).toContain("基本信息");

    // Fill a valid name, then advance to step 2.
    const input = document.body.querySelector('input[placeholder="e.g. dsv4-flash-serve"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-serve");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});

    // Click Next
    const nextBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步");
    expect(nextBtn).not.toBeNull();
    await act(async () => {
      (nextBtn as HTMLElement).click();
    });
    await act(async () => {});

    // Step 2: override fields rendered from the profile.
    expect(document.body.textContent).toContain("引擎与资源");
    expect(document.body.textContent).toContain("decodeReplicas");
    expect(document.body.textContent).toContain("prefillReplicas");

    act(() => root.unmount());
  });

  it("reopens from a fresh step 1 after cancelling on step 2", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});

    const open = () => {
      const btn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
      return act(async () => {
        btn.click();
      });
    };
    await open();
    await act(async () => {});

    // Fill a valid name and advance to step 2.
    const input = document.body.querySelector('input[placeholder="e.g. dsv4-flash-serve"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-serve");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const nextBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement;
    await act(async () => {
      nextBtn.click();
    });
    await act(async () => {});
    expect(document.body.querySelector('[data-step="2"]')).not.toBeNull();

    // Cancel.
    const cancelBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "取消") as HTMLElement;
    await act(async () => {
      cancelBtn.click();
    });
    await act(async () => {});

    // Reopen -> must come back to a fresh step 1 with a blank name.
    await open();
    await act(async () => {});
    expect(document.body.querySelector('[data-step="1"]')).not.toBeNull();
    expect(document.body.querySelector('[data-step="2"]')).toBeNull();
    const nameInput = document.body.querySelector('input[placeholder="e.g. dsv4-flash-serve"]') as HTMLInputElement;
    expect(nameInput.value).toBe("");

    act(() => root.unmount());
  });
});
