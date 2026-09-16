import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import InferenceServicesPage from "./page";
import { inferenceServiceList, inferenceServiceSummary } from "@/test/fixtures/inferenceservices";

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
    // Replicas render multi-line, one row per integer override the profile
    // declares (no hardcoded knob names).
    expect(container.textContent).toContain("decodeReplicas 2");
    expect(container.textContent).toContain("prefillReplicas 1");
    expect(container.textContent).toContain("groupSize 1");
    // Both services are pending (no status yet from the controller).
    expect(container.textContent).toContain("Pending");

    // First in the list is selected (newest): its engine/value params show.
    expect(container.textContent).toContain("访问端点");
    expect(container.textContent).toContain("dsv4-pro");
    // The public endpoint is the operator-reported value (not a hardcoded host).
    expect(container.textContent).toContain("https://gw.prod.cubestack.example/v1/models/dsv4-pro");
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

  it("switching from a service with no declared overrides keeps scale inputs controlled", async () => {
    // An unresolvable profileRef (e.g. an inline profile the cluster cannot
    // resolve) projects an empty override set. Switching from such a service to
    // one with declared overrides used to render the inputs with undefined
    // values for one frame -> React/MUI uncontrolled-to-controlled errors.
    const list = [
      inferenceServiceSummary({ name: "bare", namespace: "default", createdAt: "2026-09-01T07:00:00Z", overrides: [] }),
      inferenceServiceSummary({ name: "pd", namespace: "project-a", createdAt: "2026-09-01T06:00:00Z" }),
    ];
    stubData(list);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container, root } = renderPage();
    await act(async () => {});

    // "bare" (no overrides) is selected first; select the service with knobs.
    const pdRow = container.querySelector('[data-od-id="svc-row-pd"]');
    expect(pdRow).not.toBeNull();
    await act(async () => {
      (pdRow as HTMLElement).click();
    });
    await act(async () => {});

    const logged = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).not.toMatch(/uncontrolled|out-of-range/);

    errSpy.mockRestore();
    warnSpy.mockRestore();
    act(() => root.unmount());
  });

  it("scales the service in the selected namespace when names collide", async () => {
    // The same service name in two namespaces: selecting team-b's row and
    // applying must PATCH team-b, not the first name match (team-a).
    const list = [
      inferenceServiceSummary({ name: "api", namespace: "team-a", createdAt: "2026-09-01T07:00:00Z" }),
      inferenceServiceSummary({ name: "api", namespace: "team-b", createdAt: "2026-09-01T06:00:00Z" }),
    ];
    const patches: Array<Record<string, unknown> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: list }) };
      }),
    );
    const { container, root } = renderPage();
    await act(async () => {});

    // Select team-b's row (second row — both share the bare name "api").
    const rows = container.querySelectorAll('[data-od-id^="svc-row-"]');
    expect(rows).toHaveLength(2);
    await act(async () => {
      (rows[1] as HTMLElement).click();
    });

    // Change the first numeric knob (prefillReplicas) and apply.
    const numInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(numInput, "3");
      numInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const applyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "应用");
    expect(applyBtn).toBeDefined();
    await act(async () => {
      (applyBtn as HTMLElement).click();
    });
    await act(async () => {});

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ namespace: "team-b", name: "api" });

    act(() => root.unmount());
  });

  it("renders a declared string enum as a select, not a free-text input", async () => {
    // A string override with a declared enum is a closed set: it must render the
    // enum as a select (previously the string branch won and it was text).
    const list = [
      inferenceServiceSummary({
        name: "str-enum",
        namespace: "project-a",
        overrides: [
          { name: "quantization", type: "string", min: null, max: null, enum: ["w8a8", "fp16"], current: null },
        ],
      }),
    ];
    stubData(list);
    const { container, root } = renderPage();
    await act(async () => {});

    // The select shows the first declared entry (an enum select needs a value
    // inside the set) and renders it as text; a free-text input would show none.
    const trigger = container.querySelector('[role="combobox"]');
    expect(trigger).not.toBeNull();
    expect((trigger?.textContent ?? "").replace(/\u200b/g, "").trim()).toBe("w8a8");

    // Both declared options are offered by the select.
    await act(async () => {
      (trigger as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    const options = Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent);
    expect(options).toEqual(["w8a8", "fp16"]);

    act(() => root.unmount());
  });

  it("keeps Apply disabled while a string enum holds a value outside the enum", async () => {
    // The service's stored value is no longer in the declared enum: the numeric
    // edit alone must not enable Apply, i.e. string enums are validated too.
    const list = [
      inferenceServiceSummary({
        name: "stale-enum",
        namespace: "project-a",
        overrides: [
          { name: "quantization", type: "string", min: null, max: null, enum: ["w8a8", "fp16"], current: "int4" },
          { name: "maxModelLen", type: "integer", min: 1, max: 100, enum: null, current: 10 },
        ],
      }),
    ];
    stubData(list);
    // The out-of-enum stored value makes MUI warn; that is the state under test.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container, root } = renderPage();
    await act(async () => {});

    const numInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(numInput, "20");
      numInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const applyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "应用");
    expect((applyBtn as HTMLButtonElement).disabled).toBe(true);

    warnSpy.mockRestore();
    act(() => root.unmount());
  });

  it("still treats edits as changed when values contain the snapshot delimiters", async () => {
    // The edited-vs-service comparison used to join "name=value;" pairs, so a
    // value containing ";" or "=" could make two different states collide:
    // a="p;b=q", b="r" joins to the same string as a="p", b="q;b=r".
    const list = [
      inferenceServiceSummary({
        name: "delims",
        namespace: "project-a",
        overrides: [
          { name: "a", type: "string", min: null, max: null, enum: null, current: "p;b=q" },
          { name: "b", type: "string", min: null, max: null, enum: null, current: "r" },
        ],
      }),
    ];
    const patches: Array<Record<string, unknown> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: list }) };
      }),
    );
    const { container, root } = renderPage();
    await act(async () => {});

    const inputs = container.querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    const setValue = async (el: HTMLInputElement, v: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await setValue(inputs[0] as HTMLInputElement, "p");
    await setValue(inputs[1] as HTMLInputElement, "q;b=r");

    // Both knobs differ from the service, so Apply must be enabled.
    const applyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "应用");
    expect((applyBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (applyBtn as HTMLElement).click();
    });
    await act(async () => {});
    expect(patches[0]?.overrides).toEqual({ a: "p", b: "q;b=r" });

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
      servingMode: "pd-separation",
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

  function renderWithBoth(opts: object = OPTIONS) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/options")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => opts });
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

  // MUI Select renders a zero-width space span inside the display div.
  const selectText = (el: Element | null): string => (el?.textContent ?? "").replace(/\u200b/g, "").trim();

  async function fillNameAndGoToStep2() {
    const input = document.body.querySelector('input[placeholder="e.g. dsv4-flash-serve"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-serve");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    const nextBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement;
    await act(async () => {
      nextBtn.click();
    });
    await act(async () => {});
  }

  it("renders per-role GPU type selects for a pd-separation profile", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
    await act(async () => {
      deployBtn.click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    // pd-separation: one reserved GPU select per role (prefill / decode), both
    // fixed to the profile's vendor until the operator API supports it.
    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    expect(step2.textContent).toContain("GPU 类型");
    const prefillGpu = step2.querySelector('[data-od-id="wizard-gpu-prefill"]');
    const decodeGpu = step2.querySelector('[data-od-id="wizard-gpu-decode"]');
    expect(selectText(prefillGpu)).toBe("metax");
    expect(selectText(decodeGpu)).toBe("metax");
    expect(step2.textContent).toContain("预留能力");

    act(() => root.unmount());
  });

  it("renders a single GPU type select for a standard profile", async () => {
    const standardOptions = {
      ...OPTIONS,
      profiles: OPTIONS.profiles.map((p) => ({ ...p, servingMode: "standard" })),
    };
    const { container, root } = renderWithBoth(standardOptions);
    await act(async () => {});
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
    await act(async () => {
      deployBtn.click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    // standard: a single GPU select, no per-role selects.
    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    expect(step2.textContent).toContain("GPU 类型");
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu"]'))).toBe("metax");
    expect(step2.querySelector('[data-od-id="wizard-gpu-prefill"]')).toBeNull();
    expect(step2.querySelector('[data-od-id="wizard-gpu-decode"]')).toBeNull();

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
