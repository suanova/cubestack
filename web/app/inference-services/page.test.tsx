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

  /**
   * A fetch that answers the list on GET and the delete on DELETE, recording
   * every call so a test can assert on what the console actually sent — and on
   * the fact that it sent nothing while the dialog was still asking.
   */
  function stubDeleteFetch(items: unknown[], del: { ok: boolean; status?: number; body?: unknown }) {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === "DELETE") {
          return {
            ok: del.ok,
            status: del.status ?? (del.ok ? 200 : 500),
            json: async () => (del.ok ? { ok: true } : (del.body ?? { error: "boom" })),
          };
        }
        return { ok: true, status: 200, json: async () => ({ items }) };
      }),
    );
    return calls;
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
    // GPU 资源 is the service's whole footprint: prefill 8 cards × 1 replica
    // plus decode 8 cards × 2 replicas.
    expect(container.textContent).toContain("24 × MXC500");
    // The detail card breaks the same facts down per role, per replica.
    expect(container.textContent).toContain("Prefill 8 × MXC500 · Decode 8 × MXC500");
    // Replicas render multi-line, one row per integer override the profile
    // declares (no hardcoded knob names), labelled as words rather than by the
    // raw override key.
    expect(container.textContent).toContain("Decode Replicas 2");
    expect(container.textContent).toContain("Prefill Replicas 1");
    expect(container.textContent).toContain("Group Size 1");
    // No status from the controller yet -> no phase, so the status chip shows
    // its placeholder rather than inventing one.
    expect((container.querySelector('[data-od-id="svc-row-dsv4-flash-pd"]') as HTMLElement).textContent).toContain("—");

    // First in the list is selected (newest): its engine/value params show.
    expect(container.textContent).toContain("访问端点");
    expect(container.textContent).toContain("dsv4-pro");
    // The public endpoint is the operator-reported value (not a hardcoded host).
    expect(container.textContent).toContain("https://ai.cubestack.dev");
    // No controller status -> metrics and conditions show their empty states.
    expect(container.querySelector('[data-od-id="metrics-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("可调参数");
    expect(container.textContent).toContain("引擎参数");

    act(() => root.unmount());
  });

  it("shows the whole GPU footprint, not one replica's share", async () => {
    // A single-role service running 4 cards on 2 replicas occupies 8 cards. The
    // list's GPU 资源 cell is the total; the detail card keeps the per-replica
    // figure under its own label.
    stubData([
      inferenceServiceSummary({
        name: "qwen38-27b",
        gpuModel: "MXC550",
        gpuPerPod: 4,
        gpuRoles: [{ name: "vllm", gpuPerPod: 4, model: "MXC550", replicas: 2, groupSize: 1 }],
        overrideNums: { replicas: 2, tpSize: 4 },
        overrides: [{ name: "replicas", type: "integer", min: 1, max: 4, enum: null, current: 2, default: 1 }],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    const row = container.querySelector('[data-od-id="svc-row-qwen38-27b"]') as HTMLElement;
    expect(row.textContent).toContain("8 × MXC550");
    // The detail card's row stays per replica, so the two numbers cannot drift.
    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "每副本 GPU");
    expect(label).toBeDefined();
    expect(label!.parentElement?.lastElementChild?.textContent).toBe("4 × MXC550");

    act(() => root.unmount());
  });

  it("counts every pod of a LeaderWorkerSet replica", async () => {
    // A multi-node profile runs a 2-pod group per replica, and each pod requests
    // its own cards: 4 cards × 2 pods × 2 replicas = 16, while the detail card
    // shows the group (8) as the per-replica figure.
    stubData([
      inferenceServiceSummary({
        name: "dsv4-flash-multinode",
        gpuModel: "MXC550",
        gpuPerPod: 4,
        gpuRoles: [{ name: "vllm", gpuPerPod: 4, model: "MXC550", replicas: 2, groupSize: 2 }],
        overrideNums: { replicas: 2, groupSize: 2 },
        overrides: [
          { name: "replicas", type: "integer", min: 1, max: 4, enum: null, current: 2, default: 1 },
          { name: "groupSize", type: "integer", min: 1, max: 8, enum: null, current: 2, default: 1 },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    const row = container.querySelector('[data-od-id="svc-row-dsv4-flash-multinode"]') as HTMLElement;
    expect(row.textContent).toContain("16 × MXC550");
    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "每副本 GPU");
    expect(label!.parentElement?.lastElementChild?.textContent).toBe("8 × MXC550");

    act(() => root.unmount());
  });

  it("treats a Deployment replica as one pod", async () => {
    // The API reports groupSize 0 for a role without a group; a replica there is
    // a single pod, so the footprint must not collapse to zero.
    stubData([
      inferenceServiceSummary({
        name: "tp8-deployment",
        gpuModel: "MXC500",
        gpuPerPod: 8,
        gpuRoles: [{ name: "vllm", gpuPerPod: 8, model: "MXC500", replicas: 2, groupSize: 0 }],
        overrideNums: { replicas: 2 },
        overrides: [{ name: "replicas", type: "integer", min: 1, max: 4, enum: null, current: 2, default: 1 }],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    const row = container.querySelector('[data-od-id="svc-row-tp8-deployment"]') as HTMLElement;
    expect(row.textContent).toContain("16 × MXC500");

    act(() => root.unmount());
  });

  it("shows the profile's effective maxModelLen when the user did not override it", async () => {
    // The runtime uses the profile default when spec.overrides omits the knob,
    // so the details card must show that value rather than an empty placeholder.
    stubData([
      inferenceServiceSummary({
        overrideNums: {},
        overrides: [
          { name: "maxModelLen", type: "integer", min: 4096, max: 262144, enum: null, current: 123456, default: 123456 },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    // Locate the row in the parameters card rather than searching the page:
    // the replicas table renders the same integer, so a page-wide match would
    // pass even if this card still showed "—".
    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "maxModelLen");
    expect(label).toBeDefined();
    expect(label!.parentElement?.lastElementChild?.textContent).toBe("123456");

    act(() => root.unmount());
  });

  it("shows the private gateway's in-cluster address as the AI Gateway endpoint of a private service", async () => {
    // The private catalog route has no public listener: a caller inside the
    // cluster reaches it through the private gateway's Service, not the
    // cluster's public catalog host — and not the model server's own address.
    stubData([
      inferenceServiceSummary({
        aigatewayRouter: "cubestack-ai-gateway-private",
        internalEndpoint: "dsv4-api.project-a.svc:8001",
        publicEndpoint: "https://ai.cubestack.dev",
        // The API resolves this from the private Gateway's dataplane Service.
        privateGatewayEndpoint:
          "http://envoy-envoy-gateway-system-cubestack-gateway-private-bbbbbbbb.envoy-gateway-system.svc:8080",
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.textContent).toContain("集群内端点(AI Gateway)");
    expect(container.textContent).toContain(
      "http://envoy-envoy-gateway-system-cubestack-gateway-private-bbbbbbbb.envoy-gateway-system.svc:8080",
    );
    expect(container.textContent).toContain("dsv4-api.project-a.svc:8001");
    expect(container.textContent).not.toContain("https://ai.cubestack.dev");

    act(() => root.unmount());
  });

  it("renders the phase the controller reported, and nothing else", async () => {
    const list = [
      // Just created: the operator reads it as Progressing (Reconciling) — the
      // row must not call that broken.
      inferenceServiceSummary({ name: "starting", createdAt: "2026-09-01T07:00:00Z", phase: "Progressing", phaseReason: "Reconciling" }),
      // Converged then broke: the operator's own verdict.
      inferenceServiceSummary({ name: "broken", createdAt: "2026-09-01T06:00:00Z", phase: "Failed", phaseReason: "RolesNotReady" }),
      inferenceServiceSummary({ name: "up", createdAt: "2026-09-01T05:00:00Z", phase: "Ready", phaseReason: "Ready" }),
    ];
    stubData(list);
    const { container, root } = renderPage();
    await act(async () => {});

    const chip = (name: string) =>
      (container.querySelector(`[data-od-id="svc-row-${name}"]`) as HTMLElement).textContent;
    expect(chip("starting")).toContain("Progressing");
    expect(chip("broken")).toContain("Failed");
    expect(chip("up")).toContain("Ready");

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

  it("renders a refusal the route sent as a code, in the user's language", async () => {
    // The route answers with `{ error, params }` and no prose, so the sentence is
    // the console's (`inf.err.<code>`) — the same contract as the create routes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return { ok: false, status: 400, json: async () => ({ error: "overrideAboveMax", params: { key: "prefillReplicas", max: 8 } }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: [inferenceServiceSummary({})] }) };
      }),
    );
    const { container, root } = renderPage();
    await act(async () => {});

    const numInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(numInput, "3");
      numInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "应用") as HTMLElement).click();
    });
    await act(async () => {});

    expect(container.textContent).toContain("override 'prefillReplicas' 大于最大值 8。");

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
          { name: "quantization", type: "string", min: null, max: null, enum: ["w8a8", "fp16"], current: null, default: "w8a8" },
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
          { name: "quantization", type: "string", min: null, max: null, enum: ["w8a8", "fp16"], current: "int4", default: "w8a8" },
          { name: "maxModelLen", type: "integer", min: 1, max: 100, enum: null, current: 10, default: 1 },
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
          { name: "a", type: "string", min: null, max: null, enum: null, current: "p;b=q", default: "p" },
          { name: "b", type: "string", min: null, max: null, enum: null, current: "r", default: "r" },
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

  it("lets a string override whose declared default is empty be cleared", async () => {
    // A knob like nodeSelector declares "" as its value: empty means "off", so
    // the box must accept it (and send it) instead of reading it as missing
    // input. A string override with no declared default keeps rejecting empty.
    const list = [
      inferenceServiceSummary({
        name: "node-selector",
        namespace: "project-a",
        overrides: [
          { name: "nodeSelector", type: "string", min: null, max: null, enum: null, current: "node-pool=inference", default: "" },
          { name: "endpoint", type: "string", min: null, max: null, enum: null, current: "http://rgw:8080", default: null },
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
    const applyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "应用");
    const setValue = async (el: HTMLInputElement, v: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await setValue(inputs[0] as HTMLInputElement, "");
    expect((applyBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (applyBtn as HTMLElement).click();
    });
    await act(async () => {});
    // Cleared to empty on the wire — the state a site returns to when it wants
    // no node selector at all. The panel sends every knob it declares.
    expect(patches[0]?.overrides).toEqual({ nodeSelector: "", endpoint: "http://rgw:8080" });

    // The second knob declares no default, so an empty box is still invalid.
    await setValue(inputs[1] as HTMLInputElement, "");
    expect((applyBtn as HTMLButtonElement).disabled).toBe(true);

    act(() => root.unmount());
  });

  it("picks nodes for a stringList nodeSelector from the cluster in the detail panel", async () => {
    // The detail panel edits the same knob the wizard creates: a nodeSelector
    // list is a multi-select of the cluster's schedulable nodes, and the pick
    // crosses the wire as the hostname label pair the operator expects.
    const list = [
      inferenceServiceSummary({
        name: "node-pinned",
        overrides: [
          {
            name: "prefill_nodeSelector",
            type: "stringList",
            min: null,
            max: null,
            enum: null,
            current: ["kubernetes.io/hostname=worker-a"],
            default: [],
          },
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
        if (String(input).includes("/options")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              nodes: [
                { name: "worker-a", gpuModels: { metax: "MXC500" } },
                { name: "worker-b", gpuModels: { metax: "MXC550" } },
              ],
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ items: list }) };
      }),
    );
    const { container, root } = renderPage();
    await act(async () => {});

    const picker = container.querySelector('[data-od-id="scale-prefill_nodeSelector"]') as HTMLElement;
    expect(picker).not.toBeNull();
    // The current pin renders as its node name, not the label pair.
    expect(picker.textContent).toContain("worker-a");

    await act(async () => {
      (picker.querySelector('[role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    // worker-a is already pinned; adding worker-b must keep it and extend the
    // pin to both nodes.
    for (const name of ["worker-b"]) {
      const option = Array.from(document.body.querySelectorAll('[role="option"]')).find(
        (o) => o.textContent === name,
      );
      expect(option).toBeDefined();
      await act(async () => {
        (option as HTMLElement).click();
      });
      await act(async () => {});
    }
    // A multiple select keeps its menu open between picks; dismiss it.
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {});

    const applyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "应用");
    expect((applyBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (applyBtn as HTMLElement).click();
    });
    await act(async () => {});

    expect(patches[0]?.overrides).toEqual({
      prefill_nodeSelector: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
    });

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

  it("keeps a failed service out of 准备中, where it is not preparing", async () => {
    stubData([
      inferenceServiceSummary({ name: "up", createdAt: "2026-09-01T07:00:00Z", phase: "Ready" }),
      inferenceServiceSummary({ name: "starting", createdAt: "2026-09-01T06:00:00Z", phase: "Progressing" }),
      inferenceServiceSummary({ name: "unreported", createdAt: "2026-09-01T05:30:00Z", phase: null }),
      inferenceServiceSummary({ name: "broken", createdAt: "2026-09-01T05:00:00Z", phase: "Failed" }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    const rows = () =>
      Array.from(container.querySelectorAll('[data-od-id^="svc-row-"]')).map(
        (r) => r.getAttribute("data-od-id"),
      );
    expect(rows()).toHaveLength(4);

    const tabs = container.querySelectorAll('[role="tab"]');
    await act(async () => {
      (tabs[1] as HTMLElement).click(); // Ready
    });
    expect(rows()).toEqual(["svc-row-up"]);

    await act(async () => {
      (tabs[2] as HTMLElement).click(); // 准备中
    });
    // A service the controller has not reported on is still starting, so it
    // belongs here; a Failed one is not preparing and is reached through 全部.
    expect(rows()).toEqual(["svc-row-starting", "svc-row-unreported"]);

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

  it("shows a sub-1 QPS with decimals instead of rounding it to zero", async () => {
    const list = inferenceServiceList();
    // ~3 requests a minute is a real rate, but Math.round would render it "0".
    list[0].metrics = { qps: 0.048, p95: 412, tps: 1, spark: [0, 0.01, 0.05] };
    stubData(list);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="metrics-empty"]')).toBeNull();
    expect(container.textContent).toContain("0.05");

    act(() => root.unmount());
  });

  it("prints every condition beside its pill, True ones included", async () => {
    stubData([
      inferenceServiceSummary({
        name: "half-broken-svc",
        conditions: [
          // A True condition whose message is empty: the pill is the whole line.
          { type: "Ready", status: "True", reason: "Ready", message: "", transitionTime: null },
          // A True condition with a sentence: the controller saying what it did,
          // on the same line as its pill.
          { type: "RouteReady", status: "True", reason: "Published", message: "Routes are published on the gateway", transitionTime: null },
          // The sentences that used to be unreachable: they were printed in a
          // second list keyed by type, detached from the row that carried them.
          { type: "Scaling", status: "True", reason: "Scaling", message: "Scaling decode replicas to 2", transitionTime: null },
          { type: "ReplicasReady", status: "False", reason: "PodNotReady", message: "0/2 decode replicas ready", transitionTime: null },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="cond-note-RouteReady"]')?.textContent).toBe(
      ": Routes are published on the gateway",
    );
    expect(container.querySelector('[data-od-id="cond-note-Scaling"]')?.textContent).toBe(": Scaling decode replicas to 2");
    expect(container.querySelector('[data-od-id="cond-note-ReplicasReady"]')?.textContent).toBe(": 0/2 decode replicas ready");
    // An empty message takes no line: ": " on its own reads as a message that
    // failed to arrive. The pill still states the condition.
    expect(container.querySelector('[data-od-id="cond-note-Ready"]')).toBeNull();
    expect(container.querySelector('[data-od-id="cond-Ready"]')?.textContent).toBe("ReadyTrue");
    // The reason is off the line but not out of reach: the pill's hover carries
    // it beside the message.
    expect(container.querySelector('[data-od-id="cond-Ready"]')?.getAttribute("title")).toBe("Ready True (Ready)");
    expect(container.querySelector('[data-od-id="cond-ReplicasReady"]')?.getAttribute("title")).toBe(
      "ReplicasReady False (PodNotReady) 0/2 decode replicas ready",
    );
    // The status is stated, not only coloured: the dot is decorative now that
    // the enum is text beside it.
    expect(container.querySelector('[data-od-id="cond-ReplicasReady"]')?.textContent).toBe("ReplicasReadyFalse");
    expect(container.querySelector('[data-od-id="cond-ReplicasReady"] [aria-hidden="true"]')).not.toBeNull();
    // Every condition takes a line, True ones included — not only the False ones.
    for (const type of ["Ready", "RouteReady", "Scaling", "ReplicasReady"]) {
      expect(container.querySelector(`[data-od-id="cond-${type}"]`)).not.toBeNull();
    }

    act(() => root.unmount());
  });

  it("paints Progressing False as the settled state, not a failure", async () => {
    stubData([
      inferenceServiceSummary({
        name: "settled-svc",
        conditions: [
          { type: "Ready", status: "True", reason: "Ready", message: "", transitionTime: null },
          { type: "Progressing", status: "False", reason: "Converged", message: "Nothing in flight", transitionTime: null },
          { type: "ReplicasReady", status: "False", reason: "PodNotReady", message: "0/2 decode replicas ready", transitionTime: null },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    const pill = (type: string) => container.querySelector(`[data-od-id="cond-${type}"]`);
    // A settled Progressing (False) wears the same success tint as a True
    // condition; a False condition of the usual polarity stays the error tint.
    expect(pill("Progressing")?.className).toBe(pill("Ready")?.className);
    expect(pill("ReplicasReady")?.className).not.toBe(pill("Ready")?.className);

    act(() => root.unmount());
  });

  it("lays the row's actions out in an open row and keeps them behind the kebab when closed", async () => {
    stubData(inferenceServiceList());
    const { container, root } = renderPage();
    await act(async () => {});

    // The open row has the width to lay the action out, so it is a button.
    const openAct = container.querySelector('[data-od-id="act-del-dsv4-pro-pd"]');
    expect(openAct).not.toBeNull();
    expect(openAct?.textContent).toBe("删除");

    // The closed row has only the kebab: the item exists nowhere in the DOM
    // until the menu is opened.
    expect(container.querySelector('[data-od-id="svc-ops-dsv4-flash-pd"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="act-del-dsv4-flash-pd"]')).toBeNull();
    // Opening that row is what puts the action on the row.
    await act(async () => {
      (container.querySelector('[data-od-id="svc-row-dsv4-flash-pd"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-od-id="act-del-dsv4-flash-pd"]')).not.toBeNull();
    // One row is open at a time, so the first row's action went back to a kebab.
    expect(container.querySelector('[data-od-id="act-del-dsv4-pro-pd"]')).toBeNull();

    act(() => root.unmount());
  });

  it("asks before deleting, then sends the row's own namespace and name", async () => {
    const calls = stubDeleteFetch(inferenceServiceList(), { ok: true });
    const { container, root } = renderPage();
    await act(async () => {});

    await act(async () => {
      (container.querySelector('[data-od-id="act-del-dsv4-pro-pd"]') as HTMLElement).click();
    });
    // The dialog says what goes, by name — and nothing has been sent: the click
    // on the row's button only names the target.
    expect(document.body.querySelector('[data-od-id="delete-prompt"]')?.textContent).toBe(
      "删除推理服务「dsv4-pro-pd」?其控制器创建的资源会一并回收,此操作不可撤销。",
    );
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    await act(async () => {
      (document.body.querySelector('[data-od-id="delete-confirm"]') as HTMLElement).click();
    });
    await act(async () => {});

    // The composite namespace/name, not the bare name a same-named service in
    // another namespace would answer to.
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.body).toEqual({ namespace: "project-a", name: "dsv4-pro-pd" });
    expect(document.body.querySelector('[data-od-id="delete-dialog"]')).toBeNull();

    act(() => root.unmount());
  });

  it("says a failed delete in the console's own dialog, in the user's language", async () => {
    stubDeleteFetch(inferenceServiceList(), {
      ok: false,
      status: 404,
      body: { error: "nameMissing", params: { name: "dsv4-pro-pd" } },
    });
    const { container, root } = renderPage();
    await act(async () => {});

    await act(async () => {
      (container.querySelector('[data-od-id="act-del-dsv4-pro-pd"]') as HTMLElement).click();
    });
    await act(async () => {
      (document.body.querySelector('[data-od-id="delete-confirm"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(document.body.querySelector('[data-od-id="error-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-od-id="error-message"]')?.textContent).toBe("服务 'dsv4-pro-pd' 不存在。");
    // The row behind the dialog is unchanged: the delete did not happen.
    expect(container.querySelector('[data-od-id="svc-row-dsv4-pro-pd"]')).not.toBeNull();

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
  // The API names the namespace the wizard opens on: `default` here, even though
  // project-a sorts first.
  defaultNamespace: "default",
  // The schedulable nodes the wizard may pin a service to, each with the GPU
  // model its vendor's product label advertises.
  nodes: [
    { name: "worker-a", gpuModels: { metax: "MXC500" } },
    { name: "worker-b", gpuModels: { metax: "MXC550" } },
  ],
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
      roles: [
        { name: "prefill", vendor: "metax", models: ["MXC500"], gpuPerPod: 8 },
        { name: "decode", vendor: "nvidia", models: ["H200"], gpuPerPod: 8 },
      ],
      overrides: [
        { name: "decodeReplicas", type: "integer", min: 1, max: 16, enum: null, default: 1, description: null },
        { name: "prefillReplicas", type: "integer", min: 1, max: 8, enum: null, default: 1, description: null },
        { name: "groupSize", type: "integer", min: null, max: null, enum: [1, 2, 4], default: 1, description: null },
        { name: "nodeSelector", type: "string", min: null, max: null, enum: null, default: "", description: null },
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
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes("/options")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => opts });
        }
        if (method === "POST") {
          return Promise.resolve({ ok: true, status: 201, json: async () => ({ created: true, name: "my-serve" }) });
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
    return { container, root, calls };
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

    // Step 2: override fields rendered from the profile, each labelled as
    // words rather than by its raw key.
    expect(document.body.textContent).toContain("引擎与资源");
    expect(document.body.textContent).toContain("Decode Replicas");
    expect(document.body.textContent).toContain("Prefill Replicas");
    expect(document.body.textContent).not.toContain("decodeReplicas");

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

  it("always publishes and defaults the catalog model name to the service name", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;

    // Publishing is mandatory, so the catalog controls are always present; the
    // request/idle timeout inputs are gone.
    expect(step2.querySelector('[data-od-id="deploy-aigateway-router"]')).not.toBeNull();
    expect(step2.querySelector('[data-od-id="deploy-catalog-paths"]')).not.toBeNull();
    expect(step2.textContent).not.toContain("请求超时");
    expect(step2.textContent).not.toContain("空闲超时");

    // The service name is a valid catalog name, so the field follows it rather
    // than making the user retype it.
    const modelName = () =>
      document.body.querySelector('[data-od-id="deploy-model-name"] input') as HTMLInputElement;
    expect(modelName().value).toBe("my-serve");

    // A catalog name the user typed is theirs: renaming the service leaves it
    // alone.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(modelName(), "custom-model");
      modelName().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "上一步") as HTMLElement).click();
    });
    await act(async () => {});
    const nameInput = document.body.querySelector('input[placeholder="e.g. dsv4-flash-serve"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput, "renamed-serve");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    expect(modelName().value).toBe("custom-model");

    act(() => root.unmount());
  });

  it("publishes to the private catalog route by default", async () => {
    const { container, root, calls } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;

    // Private visibility is the default.
    const picker = step2.querySelector('[data-od-id="deploy-aigateway-router"] [role="combobox"]');
    expect(selectText(picker)).toContain("cubestack-ai-gateway-private");

    // A model is required to advance; pick the compatible one.
    const modelSelect = Array.from(step2.querySelectorAll('[role="combobox"]')).find((c) =>
      (c.textContent ?? "").includes("选择模型版本"),
    ) as HTMLElement;
    await act(async () => {
      modelSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const model = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "deepseek-v4-flash-w8a8-v1",
    );
    expect(model).toBeDefined();
    await act(async () => {
      (model as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      route: {
        aigatewayRouter: "cubestack-ai-gateway-private",
        modelName: "my-serve",
        paths: ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/images"],
      },
    });

    act(() => root.unmount());
  });

  it("publishes only the catalog paths that stay selected", async () => {
    const { container, root, calls } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;

    // Publishing starts with every supported path exposed.
    const paths = step2.querySelector('[data-od-id="deploy-catalog-paths"]') as HTMLElement;
    const combobox = paths.querySelector('[role="combobox"]') as HTMLElement;
    const pathText = () => selectText(combobox);
    expect(pathText()).toBe("/v1/chat/completions, /v1/responses, /v1/messages, /v1/images");

    await act(async () => {
      combobox.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const pathOption = (label: string) =>
      Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === label) as HTMLElement;

    // Drop /v1/responses.
    await act(async () => {
      pathOption("/v1/responses").click();
    });
    await act(async () => {});
    expect(pathText()).toBe("/v1/chat/completions, /v1/messages, /v1/images");

    // The last selected path cannot be removed: a published model exposes at
    // least one.
    for (const label of ["/v1/chat/completions", "/v1/messages", "/v1/images"]) {
      await act(async () => {
        pathOption(label).click();
      });
      await act(async () => {});
    }
    expect(pathText()).toBe("/v1/images");

    const modelSelect = Array.from(step2.querySelectorAll('[role="combobox"]')).find((c) =>
      (c.textContent ?? "").includes("选择模型版本"),
    ) as HTMLElement;
    await act(async () => {
      modelSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const model = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "deepseek-v4-flash-w8a8-v1",
    );
    await act(async () => {
      (model as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      route: { paths: ["/v1/images"] },
    });

    act(() => root.unmount());
  });

  it("lists the cluster's nodes for a nodeSelector override and submits the hostname pin", async () => {
    const { container, root, calls } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    // The free-text node selector is a select of the nodes the API offered.
    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const picker = step2.querySelector('[data-od-id="override-nodeSelector"]') as HTMLElement;
    expect(selectText(picker)).toBe("不指定节点（由调度器选择）");

    await act(async () => {
      (picker.querySelector('[role="combobox"]') as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const node = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === "worker-b");
    expect(node).toBeDefined();
    await act(async () => {
      (node as HTMLElement).click();
    });
    await act(async () => {});
    expect(selectText(step2.querySelector('[data-od-id="override-nodeSelector"]'))).toBe("worker-b");

    // A model is required to advance; pick the compatible one.
    const modelSelect = Array.from(step2.querySelectorAll('[role="combobox"]')).find((c) =>
      (c.textContent ?? "").includes("选择模型版本"),
    ) as HTMLElement;
    await act(async () => {
      modelSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const model = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "deepseek-v4-flash-w8a8-v1",
    );
    expect(model).toBeDefined();
    await act(async () => {
      (model as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    // The pick is sent as the one label pair the operator's nodeSelector
    // override accepts.
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      overrides: { nodeSelector: "kubernetes.io/hostname=worker-b" },
    });

    act(() => root.unmount());
  });

  it("keeps a multi-pair nodeSelector in the free-text input", async () => {
    // A scalar nodeSelector may hold several label pairs. That is not a
    // single-node pin, so the picker must not claim the first pair's value as
    // a node name (or the second pair would be silently dropped on a pick).
    const value = "kubernetes.io/hostname=worker-a,node-pool=inference";
    const opts = {
      ...OPTIONS,
      profiles: [
        {
          ...OPTIONS.profiles[0],
          overrides: OPTIONS.profiles[0].overrides.map((o) =>
            o.name === "nodeSelector" ? { ...o, default: value } : o,
          ),
        },
      ],
    };
    const { container, root } = renderWithBoth(opts);
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const field = step2.querySelector('[data-od-id="override-nodeSelector"]') as HTMLElement;
    expect(field.querySelector('[role="combobox"]')).toBeNull();
    expect((field.querySelector("input") as HTMLInputElement).value).toBe(value);

    act(() => root.unmount());
  });

  it("offers only nodes whose GPU model matches the model chosen for the role", async () => {
    // The operator pins the model label and the hostname together. Offering a
    // node labelled with another model is a choice whose only outcome is a
    // Pending Pod, so the picker narrows to the role's selected model.
    const optionsWithModels = {
      ...OPTIONS,
      profiles: [
        {
          ...OPTIONS.profiles[0],
          models: ["MXC500", "MXC550"],
          roles: [{ name: "vllm", vendor: "metax", models: ["MXC500", "MXC550"], gpuPerPod: 8 }],
          overrides: [
            { name: "metax_model", type: "string", min: null, max: null, enum: ["MXC500", "MXC550"], default: "MXC500", description: null },
            { name: "nodeSelector", type: "string", min: null, max: null, enum: null, default: "", description: null },
          ],
        },
      ],
    };
    const { container, root } = renderWithBoth(optionsWithModels);
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const openPicker = async () => {
      await act(async () => {
        (step2.querySelector('[data-od-id="override-nodeSelector"] [role="combobox"]') as HTMLElement).dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true }),
        );
      });
    };
    const closeMenu = async () => {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    };
    const offered = () =>
      Array.from(document.body.querySelectorAll('[role="option"]')).map((o) => o.textContent);

    // MXC500 is the default, so only the MXC500 node is offered.
    await openPicker();
    expect(offered()).toContain("worker-a");
    expect(offered()).not.toContain("worker-b");
    await closeMenu();

    // Switching to MXC550 re-filters the picker to that model's nodes.
    await act(async () => {
      (step2.querySelector('[data-od-id="override-metax_model"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const mxc550 = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === "MXC550");
    expect(mxc550).toBeDefined();
    await act(async () => {
      (mxc550 as HTMLElement).click();
    });
    await act(async () => {});

    await openPicker();
    expect(offered()).toContain("worker-b");
    expect(offered()).not.toContain("worker-a");

    act(() => root.unmount());
  });

  it("multi-selects nodes for a stringList nodeSelector override and submits the hostname pins", async () => {
    // A stringList nodeSelector lets a service accept any of several nodes; a
    // single nodeSelector pair cannot express that, so the operator renders it
    // as a required nodeAffinity In term.
    const optionsWithList = {
      ...OPTIONS,
      profiles: [
        {
          ...OPTIONS.profiles[0],
          overrides: OPTIONS.profiles[0].overrides.map((o) =>
            o.name === "nodeSelector"
              ? { ...o, type: "stringList", default: [] }
              : o,
          ),
        },
      ],
    };
    const { container, root, calls } = renderWithBoth(optionsWithList);
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const picker = step2.querySelector('[data-od-id="override-nodeSelector"]') as HTMLElement;
    expect(selectText(picker)).toBe("不指定节点（由调度器选择）");

    await act(async () => {
      (picker.querySelector('[role="combobox"]') as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    for (const name of ["worker-a", "worker-b"]) {
      const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === name);
      expect(option).toBeDefined();
      await act(async () => {
        (option as HTMLElement).click();
      });
      await act(async () => {});
    }
    // A multiple select keeps its menu open between picks; dismiss it.
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {});
    expect(selectText(step2.querySelector('[data-od-id="override-nodeSelector"]'))).toBe("worker-a, worker-b");

    const modelSelect = Array.from(step2.querySelectorAll('[role="combobox"]')).find((c) =>
      (c.textContent ?? "").includes("选择模型版本"),
    ) as HTMLElement;
    await act(async () => {
      modelSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const model = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "deepseek-v4-flash-w8a8-v1",
    );
    await act(async () => {
      (model as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      overrides: {
        nodeSelector: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
      },
    });

    act(() => root.unmount());
  });

  // The deploy wizard's last steps are the same in the RDMA tests below: pick
  // the compatible model, advance, and create.
  async function pickModelAndCreate() {
    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const modelSelect = Array.from(step2.querySelectorAll('[role="combobox"]')).find((c) =>
      (c.textContent ?? "").includes("选择模型版本"),
    ) as HTMLElement;
    await act(async () => {
      modelSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const model = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "deepseek-v4-flash-w8a8-v1",
    ) as HTMLElement;
    await act(async () => {
      model.click();
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});
  }

  /** A create-options payload whose one profile declares extendedResources. */
  function extendedResourcesOptions(nodes: unknown[], gpuPerPod: number) {
    return {
      ...OPTIONS,
      nodes,
      profiles: [
        {
          ...OPTIONS.profiles[0],
          servingMode: "standard",
          roles: [{ name: "vllm", vendor: "metax", models: ["MXC500"], gpuPerPod }],
          overrides: [
            {
              name: "extendedResources",
              type: "stringList",
              min: null,
              max: null,
              enum: null,
              default: [],
              description: null,
            },
          ],
        },
      ],
    };
  }

  const rdmaNode = (name: string, gpu: number, roce: number, infiniband: number) => ({
    name,
    gpuModels: { metax: "MXC500" },
    allocatable: { gpu: { metax: gpu }, rdma: { roce, infiniband } },
  });

  it("auto-injects the only RDMA fabric into extendedResources", async () => {
    // Only RoCE is advertised, so the wizard picks it on its own and writes
    // the Pod's share of the node's devices: 100 × 4 / 8 = 50.
    const { container, root, calls } = renderWithBoth(
      extendedResourcesOptions([rdmaNode("worker-a", 8, 100, 0)], 4),
    );
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const picker = step2.querySelector('[data-od-id="override-extendedResources"]') as HTMLElement;
    expect(selectText(picker)).toBe("RoCE");

    await pickModelAndCreate();
    expect((calls.find((c) => c.method === "POST")?.body as { overrides?: unknown }).overrides).toEqual({
      extendedResources: ["rdma/roce_shared_devices=50"],
    });

    act(() => root.unmount());
  });

  it("defaults to InfiniBand when both RDMA fabrics are offered, and injects the chosen one", async () => {
    const { container, root, calls } = renderWithBoth(
      extendedResourcesOptions([rdmaNode("worker-a", 8, 100, 25)], 8),
    );
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const picker = step2.querySelector('[data-od-id="override-extendedResources"]') as HTMLElement;
    // Both fabrics exist: InfiniBand is the default.
    expect(selectText(picker)).toBe("InfiniBand");

    await act(async () => {
      (picker.querySelector('[role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const offered = Array.from(document.body.querySelectorAll('[role="option"]')).map(
      (o) => o.textContent ?? "",
    );
    // "No RDMA" is not an option: the field always names a fabric.
    expect(offered).not.toContain("不使用 RDMA");
    const roce = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) =>
      (o.textContent ?? "").includes("RoCE"),
    );
    expect(roce).toBeDefined();
    await act(async () => {
      (roce as HTMLElement).click();
    });
    await act(async () => {});
    expect(selectText(picker)).toBe("RoCE");

    await pickModelAndCreate();
    expect((calls.find((c) => c.method === "POST")?.body as { overrides?: unknown }).overrides).toEqual({
      extendedResources: ["rdma/roce_shared_devices=100"],
    });

    act(() => root.unmount());
  });

  it("sums the RDMA devices allocatable across every eligible node", async () => {
    // (100 + 50) × 4 / (8 + 8) = 37.5, floored: a Pod must not ask for more
    // device shares than the nodes can allocate.
    const { container, root, calls } = renderWithBoth(
      extendedResourcesOptions([rdmaNode("worker-a", 8, 100, 0), rdmaNode("worker-b", 8, 50, 0)], 4),
    );
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    // The dropdown names the fabric only; the derived count travels in the
    // submitted override below.
    expect(selectText(step2.querySelector('[data-od-id="override-extendedResources"]'))).toBe("RoCE");

    await pickModelAndCreate();
    expect((calls.find((c) => c.method === "POST")?.body as { overrides?: unknown }).overrides).toEqual({
      extendedResources: ["rdma/roce_shared_devices=37"],
    });

    act(() => root.unmount());
  });

  it("keeps a non-RDMA extendedResources value in the free-text input", async () => {
    // The picker only owns a value naming one known fabric; another resource
    // (or several pairs) is the profile's own choice and must not be replaced.
    const opts = extendedResourcesOptions([rdmaNode("worker-a", 8, 100, 0)], 8);
    const profile = opts.profiles[0] as {
      overrides: Array<Record<string, unknown>>;
    };
    profile.overrides[0].default = ["example.com/foo=1"];
    const { container, root } = renderWithBoth(opts);
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const field = step2.querySelector('[data-od-id="override-extendedResources"]') as HTMLElement;
    expect(field.querySelector('[role="combobox"]')).toBeNull();
    expect((field.querySelector("input") as HTMLInputElement).value).toBe("example.com/foo=1");

    act(() => root.unmount());
  });

  it("leaves extendedResources empty when no node advertises RDMA", async () => {
    // With nothing to offer there is no picker and no value: the field stays
    // empty and out of the request.
    const { container, root, calls } = renderWithBoth(
      extendedResourcesOptions([rdmaNode("worker-a", 8, 0, 0)], 8),
    );
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const field = step2.querySelector('[data-od-id="override-extendedResources"]') as HTMLElement;
    expect(field.querySelector('[role="combobox"]')).toBeNull();
    expect((field.querySelector("input") as HTMLInputElement).value).toBe("");

    await pickModelAndCreate();
    expect((calls.find((c) => c.method === "POST")?.body as { overrides?: unknown }).overrides).toEqual({});

    act(() => root.unmount());
  });

  it("filters the nodeSelector by the RDMA fabric chosen for the service", async () => {
    // The operator pins the hostname and the fabric together; offering a node
    // that does not advertise the chosen fabric is a Pod that can only stay
    // Pending.
    const opts = extendedResourcesOptions(
      [rdmaNode("worker-roce", 8, 100, 0), rdmaNode("worker-ib", 8, 0, 25)],
      8,
    );
    const profile = opts.profiles[0] as {
      overrides: Array<Record<string, unknown>>;
    };
    // Role-scoped, as the PD profiles declare them; the fabric is declared
    // once for the service, so the selector follows that value.
    profile.overrides.push({
      name: "vllm_nodeSelector",
      type: "string",
      min: null,
      max: null,
      enum: null,
      default: "",
      description: null,
    });
    const { container, root } = renderWithBoth(opts);
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    const nodePicker = () => step2.querySelector('[data-od-id="override-vllm_nodeSelector"]') as HTMLElement;
    const open = async (field: HTMLElement) => {
      await act(async () => {
        (field.querySelector('[role="combobox"]') as HTMLElement).dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true }),
        );
      });
    };
    const offered = () =>
      Array.from(document.body.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? "");

    // InfiniBand is the default when it is offered, so the selector already
    // narrows to the node that advertises it.
    await open(nodePicker());
    expect(offered()).toContain("worker-ib");
    expect(offered()).not.toContain("worker-roce");

    const chooseFabric = async (label: string) => {
      await open(step2.querySelector('[data-od-id="override-extendedResources"]') as HTMLElement);
      const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) =>
        (o.textContent ?? "").includes(label),
      );
      await act(async () => {
        (option as HTMLElement).click();
      });
      await act(async () => {});
    };

    await chooseFabric("RoCE");
    await open(nodePicker());
    expect(offered()).toContain("worker-roce");
    expect(offered()).not.toContain("worker-ib");

    await chooseFabric("InfiniBand");
    await open(nodePicker());
    expect(offered()).toContain("worker-ib");
    expect(offered()).not.toContain("worker-roce");

    act(() => root.unmount());
  });

  it("creates the namespace it is given, then the service in it", async () => {
    const { container, root, calls } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();
    // Back to step 1, where the namespace lives.
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "上一步") as HTMLElement).click();
    });
    await act(async () => {});

    // The select no longer lists the tenant namespaces the platform does not
    // manage, so naming one is how a user gets a home of their own.
    await act(async () => {
      (document.body.querySelector('[data-od-id="deploy-namespace"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const createNew = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "创建新命名空间",
    );
    expect(createNew).toBeDefined();
    await act(async () => {
      (createNew as HTMLElement).click();
    });

    const nameBox = document.body.querySelector('[data-od-id="deploy-namespace-name"] input') as HTMLInputElement;
    expect(nameBox).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameBox, "team-a");
      nameBox.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});

    // step 1 -> 2
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});

    // Step 2 refuses to advance without a model version, so pick one.
    const modelSelect = Array.from(document.body.querySelectorAll('[role="combobox"] [role="button"], [role="combobox"]')).find(
      (c) => (c.textContent ?? "").includes("选择模型版本"),
    ) as HTMLElement;
    await act(async () => {
      modelSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const model = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "deepseek-v4-flash-w8a8-v1",
    );
    await act(async () => {
      (model as HTMLElement).click();
    });
    await act(async () => {});

    // step 2 -> 3
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    // The namespace first: the service cannot be created in one that is not
    // there yet.
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      expect.stringContaining("/api/namespaces"),
      expect.stringContaining("/api/inferenceservices"),
    ]);
    expect(calls.filter((c) => c.method === "POST")[1].body).toMatchObject({ namespace: "team-a" });

    act(() => root.unmount());
  });

  it("shows a namespace error when no existing namespace is available", async () => {
    const { container, root, calls } = renderWithBoth({ ...OPTIONS, namespaces: [], defaultNamespace: null });
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    expect(document.body.querySelector('[data-step="1"]')).not.toBeNull();
    expect(document.body.textContent).toContain("命名空间名称不合法");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);

    act(() => root.unmount());
  });

  it("refuses to advance until the new namespace has a valid name", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    await act(async () => {
      (document.body.querySelector('[data-od-id="deploy-namespace"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const createNew = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent === "创建新命名空间",
    );
    await act(async () => {
      (createNew as HTMLElement).click();
    });

    const nameBox = () =>
      document.body.querySelector('[data-od-id="deploy-namespace-name"] input') as HTMLInputElement;
    const setBox = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(nameBox(), value);
        nameBox().dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {});
    };
    const next = async () => {
      await act(async () => {
        (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
      });
      await act(async () => {});
    };

    const nameInput = document.body.querySelector('input[placeholder="e.g. dsv4-flash-serve"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput, "my-serve");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});

    // Empty, then an underscore: neither is a DNS-1123 label.
    await next();
    expect(document.body.textContent).toContain("命名空间名称不合法");
    await setBox("team_a");
    await next();
    expect(document.body.textContent).toContain("基本信息");

    await setBox("team-a");
    await next();
    expect(document.body.textContent).toContain("引擎与资源");

    act(() => root.unmount());
  });

  it("opens on the namespace the API names, and refuses a name taken there", async () => {
    // The wizard opens on `default` — not on whichever namespace sorts first —
    // and the field's message promises an already-taken check, which reads the
    // services the table behind the dialog already rendered.
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    expect(document.body.querySelector('[data-od-id="deploy-namespace"]')?.textContent).toContain("default");

    // ...and the check is per namespace: move to project-a, where the fixture's
    // services live, and take one of their names.
    await act(async () => {
      (document.body.querySelector('[data-od-id="deploy-namespace"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const projectA = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === "project-a");
    await act(async () => {
      (projectA as HTMLElement).click();
    });

    const input = document.body.querySelector('input[placeholder="e.g. dsv4-flash-serve"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "dsv4-flash-pd");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});

    expect(document.body.textContent).toContain("名称不合法或已被占用。");
    expect(document.body.textContent).toContain("基本信息");

    act(() => root.unmount());
  });

  it("renders per-role GPU type selects for a pd-separation profile", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
    await act(async () => {
      deployBtn.click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    // pd-separation: one read-only GPU select per role, each showing that
    // role's own accelerator as declared by the profile.
    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    expect(step2.textContent).toContain("GPU 类型");
    const prefillGpu = step2.querySelector('[data-od-id="wizard-gpu-prefill"]');
    const decodeGpu = step2.querySelector('[data-od-id="wizard-gpu-decode"]');
    expect(selectText(prefillGpu)).toBe("metax");
    expect(selectText(decodeGpu)).toBe("nvidia");
    expect(step2.textContent).toContain("不可更改");

    act(() => root.unmount());
  });

  it("shows the accelerator model chosen through an override beside the GPU type", async () => {
    // A profile allows several accelerator models and narrows the choice
    // through an override (metax_model): the backend turns the allowed models
    // into a nodeAffinity and pins the nodeSelector to the chosen one, so the
    // wizard must show the same choice, not just the vendor.
    const optionsWithModel = {
      ...OPTIONS,
      profiles: [
        {
          ...OPTIONS.profiles[0],
          models: ["MXC500", "MXC550"],
          roles: [
            { name: "prefill", vendor: "metax", models: ["MXC500", "MXC550"], gpuPerPod: 8 },
            { name: "decode", vendor: "metax", models: ["MXC500", "MXC550"], gpuPerPod: 8 },
          ],
          overrides: [
            { name: "metax_model", type: "string", min: null, max: null, enum: ["MXC500", "MXC550"], default: "MXC550", description: null },
          ],
        },
      ],
    };
    const { container, root } = renderWithBoth(optionsWithModel);
    await act(async () => {});
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
    await act(async () => {
      deployBtn.click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-prefill"]'))).toBe("metax / MXC550");
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-decode"]'))).toBe("metax / MXC550");
    // A profile-wide model override is not role-scoped, so it keeps the plain
    // override grid.
    expect(step2.querySelector('[data-od-id="override-role-grid"]')).toBeNull();

    // Choosing another allowed model moves both GPU type selects with it.
    await act(async () => {
      (step2.querySelector('[data-od-id="override-metax_model"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const mxc500 = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === "MXC500");
    await act(async () => {
      (mxc500 as HTMLElement).click();
    });
    await act(async () => {});

    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-prefill"]'))).toBe("metax / MXC500");
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-decode"]'))).toBe("metax / MXC500");

    act(() => root.unmount());
  });

  it("shows each PD role's own accelerator model and nodeSelector overrides", async () => {
    // The PD profiles declare prefill_/decode_ scoped model and nodeSelector
    // overrides so the two roles can run on different GPU models and node
    // pools. The provider must render all four knobs and reflect each role's
    // own model, not one shared choice on both GPU type selects.
    const optionsWithRoleOverrides = {
      ...OPTIONS,
      profiles: [
        {
          ...OPTIONS.profiles[0],
          models: ["MXC500", "MXC550"],
          roles: [
            { name: "prefill", vendor: "metax", models: ["MXC500", "MXC550"], gpuPerPod: 8 },
            { name: "decode", vendor: "metax", models: ["MXC500", "MXC550"], gpuPerPod: 8 },
          ],
          overrides: [
            { name: "replicaPlacement", type: "string", min: null, max: null, enum: ["preferred", "required", "none"], default: "preferred", description: null },
            { name: "prefill_metax_model", type: "string", min: null, max: null, enum: ["MXC500", "MXC550"], default: "MXC550", description: null },
            { name: "prefill_nodeSelector", type: "string", min: null, max: null, enum: null, default: "", description: null },
            { name: "decode_metax_model", type: "string", min: null, max: null, enum: ["MXC500", "MXC550"], default: "MXC550", description: null },
            { name: "decode_nodeSelector", type: "string", min: null, max: null, enum: null, default: "", description: null },
          ],
        },
      ],
    };
    const { container, root } = renderWithBoth(optionsWithRoleOverrides);
    await act(async () => {});
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
    await act(async () => {
      deployBtn.click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    // The knobs are labelled as words, not by their raw override keys.
    expect(step2.textContent).toContain("Prefill Node Selector");
    expect(step2.textContent).toContain("Decode Node Selector");
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-prefill"]'))).toBe("metax / MXC550");
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-decode"]'))).toBe("metax / MXC550");

    // Role-scoped overrides line up as one column per role and one row per
    // knob, even though the profile declares the two roles' knobs apart.
    const roleGrid = step2.querySelector('[data-od-id="override-role-grid"]') as HTMLElement;
    expect(roleGrid).not.toBeNull();
    expect(roleGrid.querySelector('[data-od-id="override-role-prefill"]')?.textContent?.trim()).toBe("Prefill");
    expect(roleGrid.querySelector('[data-od-id="override-role-decode"]')?.textContent?.trim()).toBe("Decode");
    const gridText = roleGrid.textContent ?? "";
    const positions = ["Prefill Metax Model", "Decode Metax Model", "Prefill Node Selector", "Decode Node Selector"].map(
      (name) => gridText.indexOf(name),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const placement = step2.querySelector('[data-od-id="override-replicaPlacement"]');
    expect(placement).not.toBeNull();
    expect(roleGrid.contains(placement)).toBe(false);

    // Narrowing prefill's model leaves decode's choice alone.
    await act(async () => {
      (step2.querySelector('[data-od-id="override-prefill_metax_model"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const mxc500 = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === "MXC500");
    await act(async () => {
      (mxc500 as HTMLElement).click();
    });
    await act(async () => {});

    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-prefill"]'))).toBe("metax / MXC500");
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-decode"]'))).toBe("metax / MXC550");

    act(() => root.unmount());
  });

  it("shows an override key as words instead of its identifier", async () => {
    // Override declarations are keys like prefill_metax_model or
    // cacheDitWarmup; the form labels them as words while the raw key stays
    // the identifier sent to the API and carried by data-od-id.
    const optionsWithKeys = {
      ...OPTIONS,
      profiles: [
        {
          ...OPTIONS.profiles[0],
          overrides: [
            { name: "cacheDitWarmup", type: "boolean", min: null, max: null, enum: null, default: true, description: null },
            { name: "prefill_metax_model", type: "string", min: null, max: null, enum: ["MXC500", "MXC550"], default: "MXC550", description: null },
          ],
        },
      ],
    };
    const { container, root } = renderWithBoth(optionsWithKeys);
    await act(async () => {});
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
    await act(async () => {
      deployBtn.click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    expect(step2.textContent).toContain("Cache Dit Warmup");
    expect(step2.textContent).toContain("Prefill Metax Model");
    expect(step2.textContent).not.toContain("cacheDitWarmup");
    expect(step2.textContent).not.toContain("prefill_metax_model");
    expect(step2.querySelector('[data-od-id="override-cacheDitWarmup"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("falls back to the profile vendor when the profile's roles lack prefill/decode", async () => {
    // The wizard must never blank the select when roles[] is absent or named
    // differently: the profile-level vendor is the fallback, matching the
    // options projection's effective value.
    const noRolesOptions = {
      ...OPTIONS,
      profiles: OPTIONS.profiles.map((p) => ({ ...p, roles: [] })),
    };
    const { container, root } = renderWithBoth(noRolesOptions);
    await act(async () => {});
    const deployBtn = container.querySelector('[data-od-id="deploy-btn"]') as HTMLElement;
    await act(async () => {
      deployBtn.click();
    });
    await act(async () => {});
    await fillNameAndGoToStep2();

    const step2 = document.body.querySelector('[data-step="2"]') as HTMLElement;
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-prefill"]'))).toBe("metax");
    expect(selectText(step2.querySelector('[data-od-id="wizard-gpu-decode"]'))).toBe("metax");

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
