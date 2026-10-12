import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DevEnvironmentsPage from "./page";
import { withBasePath } from "@/lib/base-path";
import { devEnvironmentList, devEnvironmentSummary } from "@/test/fixtures/devenvironments";

// The test files avoid JSX because tsconfig sets jsx: "preserve" (for Next),
// which vitest's import-analysis can't transform.

const OPTIONS = {
  namespaces: [{ name: "project-a" }, { name: "default" }],
  // The API names the starting point rather than leaving the wizard to take the
  // first entry: project-a sorts first here, and is not the answer.
  defaultNamespace: "default",
  images: [
    { tag: "harbor.isuanova.com/suanova/jupyter-minimal:latest", label: "suanova/jupyter-minimal · CPU · JupyterLab (jovyan)", user: "jovyan", runAsGroup: 100, interface: "jupyter", vendor: "cpu" },
    { tag: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest", label: "suanova/ssh-ubuntu22.04 · CPU · SSH (ubuntu)", user: "ubuntu", interface: "ssh", vendor: "cpu" },
    { tag: "harbor.isuanova.com/suanova/jupyter-cuda-pytorch:latest", label: "suanova/jupyter-cuda-pytorch · NVIDIA CUDA · JupyterLab (ubuntu)", user: "ubuntu", interface: "jupyter", vendor: "nvidia" },
    { tag: "harbor.isuanova.com/suanova/ssh-cuda-pytorch:latest", label: "suanova/ssh-cuda-pytorch · NVIDIA CUDA · SSH (ubuntu)", user: "ubuntu", interface: "ssh", vendor: "nvidia" },
    { tag: "harbor.isuanova.com/suanova/jupyter-maca-pytorch:latest", label: "suanova/jupyter-maca-pytorch · Metax MACA · JupyterLab (ubuntu)", user: "ubuntu", interface: "jupyter", vendor: "metax" },
    { tag: "harbor.isuanova.com/suanova/ssh-maca-pytorch:latest", label: "suanova/ssh-maca-pytorch · Metax MACA · SSH (ubuntu)", user: "ubuntu", interface: "ssh", vendor: "metax" },
  ],
};

// The labelled key Secrets the wizard's SSH picker loads when the SSH toggle is
// turned on (served by /api/devenvironments/ssh-keys).
const SSH_KEYS = {
  namespace: "project-a",
  secrets: [
    { name: "alice-keys", keys: ["alice@laptop", "alice@phone"] },
    { name: "bob-keys", keys: ["bob@desktop"] },
  ],
};

describe("dev environments page", () => {
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
      root.render(createElement(DevEnvironmentsPage));
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
   * Run one of a row's actions. They live behind a kebab button now, so it
   * takes two clicks, and the menu lands in a portal on document.body rather
   * than inside the container the page rendered into.
   */
  function rowAct(name: string, kind: "start" | "stop" | "del") {
    act(() => {
      (document.body.querySelector(`[data-od-id="env-ops-${name}"]`) as HTMLElement).click();
    });
    const item = document.body.querySelector(`[data-od-id="act-${kind}-${name}"]`);
    expect(item).not.toBeNull();
    act(() => {
      (item as HTMLElement).click();
    });
  }

  /** A row's kebab button. */
  function kebab(container: HTMLElement, name: string): HTMLButtonElement {
    return container.querySelector(`[data-od-id="env-ops-${name}"]`) as HTMLButtonElement;
  }

  it("shows a loading state until the cluster request resolves", () => {
    stubData([]);
    const { container, root } = renderPage();
    expect(container.querySelector('[data-od-id="dev-loading"]')).not.toBeNull();
    expect(container.textContent).toContain("加载中…");
    act(() => root.unmount());
  });

  it("renders the environment table and defaults to the first environment's detail", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    const rows = container.querySelectorAll('[data-od-id^="dev-row-"]');
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("jupyter-nlp-ln");
    expect(container.textContent).toContain("ssh-dataset-prep");
    // Type badges via the i18n label map.
    expect(container.textContent).toContain("JUPYTER");
    expect(container.textContent).toContain("SSH");
    // Status chips.
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Stopped");

    // First row selected -> its connection info and spec show.
    expect(container.textContent).toContain("连接信息");
    expect(container.textContent).toContain("https://dev.cubestack.local/ws/jupyter-nlp-ln");
    expect(container.textContent).toContain("规格与状态");
    expect(container.textContent).toContain("harbor.isuanova.com/suanova/jupyter-cuda-pytorch:latest");
    // The GPU environment's accelerator, and the stopped one's absence of one.
    expect(container.textContent).toContain("1 × nvidia");
    expect(container.textContent).toContain("无加速卡");

    act(() => root.unmount());
  });

  it("shows the workspace, volume, runtime and network fields in the spec panel", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    // The selected environment states everything: storage shows the mount path
    // the CR carries, and each new section gets a row of its own.
    expect(container.textContent).toContain("200Gi · /home/ubuntu");
    expect(container.textContent).toContain("data-cache → /data");
    expect(container.textContent).toContain("HF_HOME · HF_TOKEN");
    expect(container.textContent).toContain("python -m jupyter lab");
    expect(container.textContent).toContain("--port 8080");
    expect(container.textContent).toContain("api:8080/http");

    // The stopped environment carries no mount path, which is not the same as
    // mounting at /workspace — the controller derives it, and /workspace is only
    // the last resort of that derivation.
    await act(async () => {
      (container.querySelector('[data-od-id="dev-row-ssh-dataset-prep"]') as HTMLElement).click();
    });
    expect(container.textContent).toContain("500Gi · 按运行身份自动派生");
    expect(container.textContent).toContain("shared-models → /models (只读)");
    expect(container.textContent).toContain("debug:9229/tcp");

    act(() => root.unmount());
  });

  it("reads each condition's status as text, not as the colour of a dot", async () => {
    stubData([
      devEnvironmentSummary({
        name: "half-broken-env",
        conditions: [
          { type: "Accepted", status: "True", reason: "Accepted", message: "" },
          { type: "RouteReady", status: "True", reason: "Published", message: "" },
          { type: "PodScheduled", status: "True", reason: "Scheduled", message: "" },
          { type: "Ready", status: "False", reason: "Running", message: "Environment pod is running but not ready" },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    // The status is the whole point of the row and it used to be carried by a 6px
    // dot alone: `Ready=False` and `Ready=True` rendered as the same word.
    expect(container.querySelector('[data-od-id="cond-Ready"]')?.textContent).toBe("ReadyFalse");
    expect(container.querySelector('[data-od-id="cond-Accepted"]')?.textContent).toBe("AcceptedTrue");

    // The dot decorates text that already says it, so it is hidden from a screen
    // reader rather than left as an unlabelled colour.
    const dot = container.querySelector('[data-od-id="cond-Ready"] span');
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.getAttribute("aria-label")).toBeNull();

    act(() => root.unmount());
  });

  it("prints the reason and message of a condition that is not True", async () => {
    stubData([
      devEnvironmentSummary({
        name: "half-broken-env",
        conditions: [
          { type: "Accepted", status: "True", reason: "Accepted", message: "" },
          // The sentence the object carries for the 503 this environment serves,
          // and the remediation the brand gate carries. Both were unreachable
          // from the console.
          { type: "Ready", status: "False", reason: "Running", message: "Environment pod is running but not ready" },
          { type: "BrandOk", status: "False", reason: "BrandMismatch", message: 'image "x" does not match gpu.vendor metax' },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="cond-note-Ready"]')?.textContent).toBe(
      "Ready (Running): Environment pod is running but not ready",
    );
    expect(container.querySelector('[data-od-id="cond-note-BrandOk"]')?.textContent).toBe(
      'BrandOk (BrandMismatch): image "x" does not match gpu.vendor metax',
    );
    // A True condition has nothing to explain, so it takes no line of its own —
    // its reason is still reachable on hover, which is where every condition's
    // own sentence lives.
    expect(container.querySelector('[data-od-id="cond-note-Accepted"]')).toBeNull();
    expect(container.querySelector('[data-od-id="cond-Accepted"]')?.getAttribute("title")).toBe("Accepted True (Accepted)");
    expect(container.querySelector('[data-od-id="cond-Ready"]')?.getAttribute("title")).toBe(
      "Ready False (Running) Environment pod is running but not ready",
    );

    act(() => root.unmount());
  });

  it("confirms a copy it made, and reports one it could not make", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    // The deployment this portal serves is plain HTTP, where the Clipboard API
    // does not exist and `document.execCommand` is the only mechanism there is.
    // The button may not report a copy that did not happen.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true, writable: true });
    let outcome = true;
    let copies = 0;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => {
        copies += 1;
        return outcome;
      },
    });

    const copyBtn = () =>
      Array.from(container.querySelectorAll("button")).find((b) =>
        ["复制", "已复制", "复制失败,请手动选择文本"].includes(b.textContent ?? ""),
      ) as HTMLElement;

    await act(async () => {
      copyBtn().click();
    });
    expect(copies).toBe(1);
    expect(copyBtn().textContent).toBe("已复制");

    // ...and when neither path can copy, it says so rather than silently doing
    // nothing — which is what the optional-chained call did on cs7.
    outcome = false;
    await act(async () => {
      copyBtn().click();
    });
    expect(copies).toBe(2);
    expect(copyBtn().textContent).toBe("复制失败,请手动选择文本");

    act(() => root.unmount());
  });

  it("names the jupyter token's Secret and how to read it, and neither for an ssh environment", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    // The value stays in the cluster — the portal has no cluster-wide Secret
    // read — so the panel names the Secret and offers the command instead.
    expect(container.textContent).toContain("Jupyter Token Secret");
    expect(container.textContent).toContain("jupyter-nlp-ln-jupyter-token");
    expect(container.textContent).toContain(
      "kubectl -n project-a get secret jupyter-nlp-ln-jupyter-token -o jsonpath='{.data.token}' | base64 -d",
    );

    // An ssh environment has no token: no row, and no command to run.
    await act(async () => {
      (container.querySelector('[data-od-id="dev-row-ssh-dataset-prep"]') as HTMLElement).click();
    });
    expect(container.textContent).not.toContain("Jupyter Token Secret");
    expect(container.textContent).not.toContain("kubectl -n");

    act(() => root.unmount());
  });

  it("switches the selected environment when a row is clicked", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    const sshRow = container.querySelector('[data-od-id="dev-row-ssh-dataset-prep"]');
    expect(sshRow).not.toBeNull();
    await act(async () => {
      (sshRow as HTMLElement).click();
    });
    expect((sshRow as HTMLElement).style.background).toBe("var(--accent-soft)");

    // Stopped env: connection panel shows the stopped note + a start button.
    expect(container.textContent).toContain("连接信息");
    expect(container.querySelector('[data-od-id="detail-start"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("filters the table by status", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelectorAll('[data-od-id^="dev-row-"]')).toHaveLength(2);
    const tabs = container.querySelectorAll('[role="tab"]');
    await act(async () => {
      (tabs[2] as HTMLElement).click(); // 已停止
    });
    // Only the stopped env remains (ssh-dataset-prep), the running one is hidden.
    expect(container.querySelectorAll('[data-od-id^="dev-row-"]')).toHaveLength(1);
    expect(container.querySelector('[data-od-id="dev-row-ssh-dataset-prep"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="dev-row-jupyter-nlp-ln"]')).toBeNull();
    await act(async () => {
      (tabs[1] as HTMLElement).click(); // 运行中
    });
    expect(container.querySelectorAll('[data-od-id^="dev-row-"]')).toHaveLength(1);
    expect(container.querySelector('[data-od-id="dev-row-jupyter-nlp-ln"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="dev-row-ssh-dataset-prep"]')).toBeNull();

    act(() => root.unmount());
  });

  it("start/stop patches spec.running for the correct namespace/name", async () => {
    const patches: Array<Record<string, unknown> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: devEnvironmentList() }) };
      }),
    );
    const { root } = renderPage();
    await act(async () => {});

    rowAct("ssh-dataset-prep", "start");
    await act(async () => {});
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ namespace: "project-a", name: "ssh-dataset-prep", running: true });

    act(() => root.unmount());
  });

  it("gates start/stop on the phase and never gates delete on it", async () => {
    stubData([
      devEnvironmentSummary(),
      devEnvironmentSummary({ name: "sleeping-env", phase: "Stopped", endpoints: [], conditions: [] }),
      devEnvironmentSummary({ name: "booting-env", phase: "Pending", endpoints: [], conditions: [] }),
      // The two phases the console does not offer a transition for. An empty
      // phase is what a controller failure before the status write leaves
      // behind; Failed is what the controller writes when it refuses the spec.
      devEnvironmentSummary({ name: "phaseless-env", phase: null, endpoints: [], conditions: [] }),
      devEnvironmentSummary({ name: "failed-env", phase: "Failed", endpoints: [], conditions: [] }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    const open = (name: string) =>
      act(() => {
        kebab(container, name).click();
      });
    const item = (kind: string, name: string) => document.body.querySelector(`[data-od-id="act-${kind}-${name}"]`);

    // Running: stop, and no start — but the way out is still there.
    open("jupyter-nlp-ln");
    expect(item("stop", "jupyter-nlp-ln")).not.toBeNull();
    expect(item("start", "jupyter-nlp-ln")).toBeNull();
    expect(item("del", "jupyter-nlp-ln")).not.toBeNull();

    // Stopped: start, and delete.
    open("sleeping-env");
    expect(item("start", "sleeping-env")).not.toBeNull();
    expect(item("del", "sleeping-env")).not.toBeNull();
    expect(item("stop", "sleeping-env")).toBeNull();

    // Pending, empty and Failed: no transition to offer — the controller owns
    // that — but the environment is still one the user can remove.
    for (const name of ["booting-env", "phaseless-env", "failed-env"]) {
      expect(kebab(container, name).disabled).toBe(false);
      open(name);
      expect(item("start", name)).toBeNull();
      expect(item("stop", name)).toBeNull();
      expect(item("del", name)).not.toBeNull();
    }

    act(() => root.unmount());
  });

  it("deletes an environment whose phase the controller never wrote", async () => {
    const deletes: Array<Record<string, unknown> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deletes.push(JSON.parse(String(init.body)));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [devEnvironmentSummary({ name: "phaseless-env", phase: null, endpoints: [], conditions: [] })],
          }),
        };
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { root } = renderPage();
    await act(async () => {});

    rowAct("phaseless-env", "del");
    await act(async () => {});

    // Without this the object is a dead end: no phase the menu could match, and
    // no other delete path in the console.
    expect(deletes).toEqual([{ namespace: "project-a", name: "phaseless-env" }]);

    act(() => root.unmount());
  });

  it("does not read a missing phase into the connection card's copy", async () => {
    stubData([
      devEnvironmentSummary({ name: "phaseless-env", phase: null, endpoints: [], conditions: [] }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    // "The environment is —" is what interpolating a null phase rendered.
    expect(container.textContent).toContain("环境尚未上报状态");
    expect(container.textContent).not.toContain("环境当前—");

    act(() => root.unmount());
  });

  it("claims an idle expiry only for an environment that has one", async () => {
    // The guide used to state the idle clause unconditionally, so an
    // environment created with the timeout disabled carried it on the same
    // screen that showed "disabled" — and named an auth proxy a cluster
    // without the Agent Router does not have.
    stubData([devEnvironmentSummary({ name: "never-idle-env", idleTimeout: 0 })]);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.textContent).not.toContain("空闲超时生效");
    expect(container.textContent).not.toContain("AI Gateway 鉴权代理");

    act(() => root.unmount());
  });

  it("states the idle timeout the environment carries, in minutes", async () => {
    stubData([devEnvironmentSummary({ name: "idle-env", idleTimeout: 3600 })]);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.textContent).toContain("超过 60 分钟无活动即停止");

    act(() => root.unmount());
  });

  it("Delete is confirmed: sends DELETE for the selected environment", async () => {
    const deletes: Array<Record<string, unknown> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deletes.push(JSON.parse(String(init.body)));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: devEnvironmentList() }) };
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { root } = renderPage();
    await act(async () => {});

    rowAct("ssh-dataset-prep", "del");
    await act(async () => {});
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toEqual({ namespace: "project-a", name: "ssh-dataset-prep" });

    act(() => root.unmount());
  });

  it("Delete is cancelled: no DELETE request is sent", async () => {
    const deletes: Array<unknown> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") deletes.push(init.body);
        return { ok: true, status: 200, json: async () => ({ items: devEnvironmentList() }) };
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { root } = renderPage();
    await act(async () => {});

    rowAct("ssh-dataset-prep", "del");
    await act(async () => {});
    expect(deletes).toHaveLength(0);

    act(() => root.unmount());
  });

  it("names the workspace consequence of a delete, per that environment's policy", async () => {
    stubData([
      devEnvironmentSummary({ name: "kept-env", phase: "Stopped", endpoints: [], conditions: [], storage: { size: "20Gi", mountPath: null, pvcRetention: "retain" } }),
      devEnvironmentSummary({ name: "purged-env", phase: "Stopped", endpoints: [], conditions: [], storage: { size: "200Gi", mountPath: null, pvcRetention: "delete" } }),
    ]);
    const prompts: string[] = [];
    // Answering "no" keeps the request off the wire: what is under test is the
    // sentence the user reads at the moment of the decision, not the delete.
    vi.spyOn(window, "confirm").mockImplementation((message?: string) => {
      prompts.push(String(message));
      return false;
    });
    const { root } = renderPage();
    await act(async () => {});

    rowAct("kept-env", "del");
    rowAct("purged-env", "del");

    // A retained workspace outlives the environment and nothing else names it,
    // so the confirmation does — it is how one is found again.
    expect(prompts[0]).toContain("workspace-kept-env-0");
    expect(prompts[0]).toContain("20Gi");
    // The default policy is stated as the loss it is, not as the field name.
    expect(prompts[1]).toContain("workspace-purged-env-0");
    expect(prompts[1]).toContain("200Gi");

    act(() => root.unmount());
  });

  it("refreshes and applies the newer phase after an action", async () => {
    // First fetch returns jupyter running; the post-action refresh flips it to Stopped.
    let flipped = false;
    const list = () =>
      devEnvironmentList().map((e) =>
        e.name === "jupyter-nlp-ln"
          ? { ...e, running: !flipped, phase: flipped ? "Stopped" : "Running" }
          : e,
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          flipped = true;
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: list() }) };
      }),
    );
    const { container, root } = renderPage();
    await act(async () => {});
    const row = container.querySelector('[data-od-id="dev-row-jupyter-nlp-ln"]');
    expect(row?.textContent).toContain("Running");

    // Stop via the row action -> triggers a refresh that returns Stopped.
    rowAct("jupyter-nlp-ln", "stop");
    await act(async () => {});
    expect(row?.textContent).toContain("Stopped");

    act(() => root.unmount());
  });

  it("shows an error with a retry button when the cluster request fails", async () => {
    stubData([], false);
    const { container, root } = renderPage();
    await act(async () => {});
    expect(container.querySelector('[data-od-id="dev-error"]')).not.toBeNull();
    expect(container.textContent).toContain("重试");
    act(() => root.unmount());
  });
});

describe("create wizard", () => {
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

  /**
   * Render the page with both options endpoints stubbed. `rejectCreate` stands in
   * for a create the route refuses: the portal must render whatever it answers.
   */
  function renderWithBoth(rejectCreate?: { status: number; body: unknown }) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/options")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => OPTIONS });
        }
        if (url.includes("/ssh-keys")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => SSH_KEYS });
        }
        if (rejectCreate && init?.method === "POST") {
          return Promise.resolve({ ok: false, status: rejectCreate.status, json: async () => rejectCreate.body });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: devEnvironmentList() }) });
      }),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(DevEnvironmentsPage));
    });
    return { container, root };
  }

  /** The wizard's accelerator select — the first combobox on step 2. */
  function acceleratorSelect(): HTMLElement {
    return document.body.querySelector('[data-step="2"] [role="combobox"]') as HTMLElement;
  }

  /**
   * Open a MUI Select, pick the option whose text matches, and return the option
   * texts it offered — so a test can assert the list itself and not just the pick.
   */
  async function selectOption(select: HTMLElement, optionText: string): Promise<string[]> {
    await act(async () => {
      select.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const options = Array.from(document.body.querySelectorAll('[role="option"]'));
    const option = options.find((o) => o.textContent === optionText);
    expect(option).toBeTruthy();
    await act(async () => {
      (option as HTMLElement).click();
    });
    return options.map((o) => o.textContent ?? "");
  }

  /** Step 2's selects in render order: accelerator, cpu, memory, idle. */
  function step2Selects(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('[data-step="2"] [role="combobox"]')) as HTMLElement[];
  }

  /** Open the wizard and advance to step 2 under a valid name. */
  async function toStep2(container: HTMLElement) {
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    const input = document.body.querySelector('input[placeholder="e.g. jupyter-nlp-ln"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-env");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    expect(document.body.querySelector('[data-step="2"]')).not.toBeNull();
  }

  async function click(label: string) {
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLElement).click();
    });
    await act(async () => {});
  }

  /** Advance one step by clicking 下一步. */
  const nextStep = () => click("下一步");
  const prevStep = () => click("上一步");

  /** Open the wizard and advance to step 3, the runtime identity. */
  async function toStep3(container: HTMLElement) {
    await toStep2(container);
    await nextStep();
    expect(document.body.querySelector('[data-step="3"]')).not.toBeNull();
  }

  function setInput(input: HTMLInputElement, value: string) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /**
   * Step 3's account, uid and gid boxes, in render order (the root switch is a
   * checkbox). Scoped to the security section: the other three sections carry
   * inputs of their own, and they sit in the same step.
   */
  function identityInputs(): HTMLInputElement[] {
    return Array.from(document.body.querySelectorAll('[data-od-id="sec-security"] input')).filter(
      (i) => (i as HTMLInputElement).type !== "checkbox",
    ) as HTMLInputElement[];
  }

  /** The text boxes of one repeatable row kind, across every row of that kind. */
  function rowInputs(kind: "pvc-name" | "pvc-path" | "env-name" | "env-value" | "port-name" | "port-num"): HTMLInputElement[] {
    return Array.from(document.body.querySelectorAll(`[data-od-id="${kind}"] input`)) as HTMLInputElement[];
  }

  function clickRow(kind: "row-add" | "row-del", nth = 0) {
    const btns = document.body.querySelectorAll(`[data-od-id="${kind}"]`);
    act(() => {
      (btns[nth] as HTMLElement).click();
    });
  }

  function rootSwitch(): HTMLElement {
    return document.body.querySelector('[data-od-id="wizard-root"] input') as HTMLElement;
  }

  /** The image combobox's text box, on step 1. */
  function imageInput(): HTMLInputElement {
    return document.body.querySelector('[data-od-id="wizard-image"] input') as HTMLInputElement;
  }

  /** One of step 1's type buttons, by its visible name. */
  async function clickType(name: string) {
    await act(async () => {
      const btn = Array.from(document.body.querySelectorAll('[data-step="1"] button')).find(
        (b) => b.firstElementChild?.textContent === name,
      ) as HTMLElement;
      expect(btn).toBeTruthy();
      btn.click();
    });
  }

  /** The references the image combobox offers, in order, with its list opened. */
  async function offeredImageTags(): Promise<string[]> {
    await act(async () => {
      imageInput().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const tags = Array.from(document.body.querySelectorAll('[role="option"]')).map(
      // The option reads as the human label over the reference; the reference is
      // what the wizard writes to spec.image.
      (o) => o.querySelector("span")?.textContent ?? "",
    );
    await act(async () => {
      imageInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    return tags;
  }

  /** Step 3's workspace mount path — empty means "derive it from the identity". */
  function mountPathInput(): HTMLInputElement {
    return document.body.querySelector('[data-od-id="wizard-mount-path"] input') as HTMLInputElement;
  }

  /** Step 3's runtime args line. */
  function argsInput(): HTMLInputElement {
    return document.body.querySelector('[data-od-id="wizard-args"] input') as HTMLInputElement;
  }

  /** Step 3's runtime command line — the image's ENTRYPOINT override. */
  function commandInput(): HTMLInputElement {
    return document.body.querySelector('[data-od-id="wizard-command"] input') as HTMLInputElement;
  }

  /** The body of the POST the wizard sent to /api/devenvironments. */
  function createdBody(): Record<string, unknown> {
    const call = (globalThis.fetch as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }).mock.calls.find(
      // The route goes through apiFetch, which carries the deployment's base
      // path, so the URL asserted here is the one the helper would build.
      ([url, init]) => String(url) === withBasePath("/api/devenvironments") && init?.method === "POST",
    );
    expect(call).toBeTruthy();
    const [, init] = call as [RequestInfo | URL, RequestInit];
    return JSON.parse(init.body as string);
  }

  it("takes an idle timeout that is not one of the four presets", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep2(container);

    // The presets are offered, plus the custom case: the CRD takes any second
    // count, and 30 minutes — the shortest preset — is short enough to stop an
    // environment someone is reading a notebook in.
    const idle = step2Selects()[3];
    expect(idle.textContent).toBe("不启用");
    expect(await selectOption(idle, "自定义…")).toEqual(["不启用", "30", "60", "240", "自定义…"]);

    // The custom branch is minutes, as the presets are, and reaches the API as
    // seconds.
    setInput(document.body.querySelector('[data-od-id="wizard-idle-minutes"] input') as HTMLInputElement, "5");

    await nextStep();
    expect(document.body.querySelector('[data-step="3"]')).not.toBeNull();
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(createdBody()).toMatchObject({ idleTimeout: 300 });

    act(() => root.unmount());
  });

  it("blocks the step on a custom idle that is not a whole number of minutes", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep2(container);

    await selectOption(step2Selects()[3], "自定义…");
    const minutes = document.body.querySelector('[data-od-id="wizard-idle-minutes"] input') as HTMLInputElement;

    // Empty is not 0: 0 means "never shut down", which the presets state.
    await nextStep();
    expect(document.body.querySelector('[data-step="3"]')).toBeNull();
    expect(document.body.textContent).toContain("请输入非负整数分钟数");

    setInput(minutes, "1.5");
    await nextStep();
    expect(document.body.querySelector('[data-step="3"]')).toBeNull();

    setInput(minutes, "-30");
    await nextStep();
    expect(document.body.querySelector('[data-step="3"]')).toBeNull();

    setInput(minutes, "30");
    await nextStep();
    expect(document.body.querySelector('[data-step="3"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("offers 1/2/4/8/16 cores, and lists only the memory sizes those cores allow", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep2(container);

    const [, cpu, memory] = step2Selects();
    // Cores are the 1/2/4/8/16 the platform offers, not the old 16/32/64 list.
    expect(await selectOption(cpu, "8 核")).toEqual(["1 核", "2 核", "4 核", "8 核", "16 核"]);
    // Memory is 1x/2x/4x the cores, and nothing else: 64Gi was legal at 16 cores
    // and must be gone at 8.
    expect(await selectOption(memory, "16Gi")).toEqual(["8Gi", "16Gi", "32Gi"]);

    act(() => root.unmount());
  });

  it("carries the memory ratio across a core change", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep2(container);

    const [, cpu] = step2Selects();
    // The wizard opens at 2 核 / 4Gi (the 2x ratio); at 4 cores that is 8Gi.
    await selectOption(cpu, "4 核");
    expect(step2Selects()[2].textContent).toBe("8Gi");
    // ...and at 1 core it is 2Gi, still 2x.
    await selectOption(cpu, "1 核");
    expect(step2Selects()[2].textContent).toBe("2Gi");

    act(() => root.unmount());
  });

  it("opens the wizard, loads options and reaches step 2", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});

    const createBtn = container.querySelector('[data-od-id="create-env-btn"]');
    expect(createBtn).not.toBeNull();
    await act(async () => {
      (createBtn as HTMLElement).click();
    });
    await act(async () => {});

    expect(document.body.textContent).toContain("新建开发环境");
    expect(document.body.querySelector('[data-step="1"]')).not.toBeNull();

    const input = document.body.querySelector('input[placeholder="e.g. jupyter-nlp-ln"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-env");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});

    const nextBtn = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步");
    expect(nextBtn).not.toBeNull();
    await act(async () => {
      (nextBtn as HTMLElement).click();
    });
    await act(async () => {});

    expect(document.body.querySelector('[data-step="2"]')).not.toBeNull();
    expect(document.body.textContent).toContain("加速卡");
    expect(document.body.textContent).toContain("持久化存储(Gi)");

    act(() => root.unmount());
  });

  it("asks for a card count only once an accelerator is chosen", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    const input = document.body.querySelector('input[placeholder="e.g. jupyter-nlp-ln"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-env");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    expect(document.body.querySelector('[data-step="2"]')).not.toBeNull();

    // The catalog opens on a CPU image, so the accelerator starts at "无(纯 CPU)"
    // and no GPU card count is asked for — only the storage input remains.
    expect(Array.from(document.body.querySelectorAll('[data-step="2"] input[type="number"]'))).toHaveLength(1);

    await selectOption(acceleratorSelect(), "nvidia");
    // Choosing a vendor is what brings the count back.
    expect(Array.from(document.body.querySelectorAll('[data-step="2"] input[type="number"]'))).toHaveLength(2);

    act(() => root.unmount());
  });

  it("blocks advancing past step 2 on invalid storage, and on an invalid card count", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    // fill a valid name, advance to step 2
    const input = document.body.querySelector('input[placeholder="e.g. jupyter-nlp-ln"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-env");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    expect(document.body.querySelector('[data-step="2"]')).not.toBeNull();
    await selectOption(acceleratorSelect(), "nvidia");

    const nums = () => Array.from(document.body.querySelectorAll('[data-step="2"] input[type="number"]')) as HTMLInputElement[];
    const setNum = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const next = async () => {
      await act(async () => {
        (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
      });
      await act(async () => {});
    };

    await act(async () => {
      setNum(nums()[0], "1.5"); // fractional gpuCount
      setNum(nums()[1], "10"); // storage below 20
    });
    await next();
    // still on step 2 and per-field errors surfaced
    expect(document.body.querySelector('[data-step="3"]')).toBeNull();
    expect(document.body.textContent).toContain("GPU 卡数须为 1–16 的整数。");
    expect(document.body.textContent).toContain("持久化存储须为 20–800(Gi) 的整数。");

    // fixing both lets the wizard proceed
    await act(async () => {
      setNum(nums()[0], "2");
      setNum(nums()[1], "200");
    });
    await next();
    expect(document.body.querySelector('[data-step="3"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("pre-fills the runtime identity from the image the wizard opens on", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    // The catalog is where the identity is known: jovyan is uid 1000 but gid
    // 100, and no other field implies that gid.
    expect(identityInputs().map((i) => i.value)).toEqual(["jovyan", "1000", "100"]);

    act(() => root.unmount());
  });

  it("re-seeds the identity when the image changes, but not when it is merely re-confirmed", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    const [account] = identityInputs();
    setInput(account, "alice");
    expect(identityInputs()[0].value).toBe("alice");

    // Regressing to step 1 and re-confirming the same reference is what the
    // freeSolo combobox does on blur; re-deriving there would undo the edit.
    await prevStep();
    await prevStep();
    setInput(imageInput(), "harbor.isuanova.com/suanova/jupyter-minimal:latest");
    await nextStep();
    await nextStep();
    expect(identityInputs()[0].value).toBe("alice");

    // A different image is a different identity: back to what it publishes.
    await prevStep();
    await prevStep();
    setInput(imageInput(), "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest");
    await nextStep();
    await nextStep();
    expect(identityInputs().map((i) => i.value)).toEqual(["ubuntu", "1000", "1000"]);

    act(() => root.unmount());
  });

  it("lets the user type an image the platform does not publish", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    // Back to step 1 with a bring-your-own reference: it is kept verbatim and the
    // identity falls back to what the operator itself defaults to.
    await prevStep();
    await prevStep();
    setInput(imageInput(), "harbor.local/ai-images/custom:1.0");
    await nextStep();
    await nextStep();
    expect(identityInputs().map((i) => i.value)).toEqual(["user", "1000", "1000"]);

    act(() => root.unmount());
  });

  it("zeroes and disables the identity under root, and restores it when root is turned off", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    await act(async () => {
      rootSwitch().click();
    });
    expect(identityInputs().map((i) => i.value)).toEqual(["root", "0", "0"]);
    expect(identityInputs().every((i) => i.disabled)).toBe(true);

    await act(async () => {
      rootSwitch().click();
    });
    // The typed identity was never overwritten, so switching back restores it
    // rather than leaving three zeroed boxes behind.
    expect(identityInputs().map((i) => i.value)).toEqual(["jovyan", "1000", "100"]);

    act(() => root.unmount());
  });

  it("refuses to advance past a runtime identity the CRD would reject", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    setInput(identityInputs()[0], "Alice");
    await nextStep();
    // Still on step 3, with the account error surfaced rather than left to the
    // API server to reject on the CR.
    expect(document.body.querySelector('[data-step="4"]')).toBeNull();
    expect(document.body.textContent).toContain("运行账号须以字母或下划线开头");

    setInput(identityInputs()[1], "1.5");
    setInput(identityInputs()[0], "alice");
    await nextStep();
    expect(document.body.querySelector('[data-step="4"]')).toBeNull();
    expect(document.body.textContent).toContain("uid / gid 须为 0–2147483647 之间的整数。");

    setInput(identityInputs()[1], "1500");
    await nextStep();
    expect(document.body.querySelector('[data-step="4"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("submits the identity the user confirmed on the last step", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    const [account, uid, gid] = identityInputs();
    setInput(account, "alice");
    setInput(uid, "1500");
    setInput(gid, "1500");
    await nextStep();

    // The confirmation step restates the identity, so what is submitted is what
    // was read there.
    expect(document.body.textContent).toContain("alice · uid 1500 / gid 1500");
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(createdBody()).toMatchObject({ runtimeUser: "alice", runAsUser: 1500, runAsGroup: 1500 });

    act(() => root.unmount());
  });

  it("refuses a name already taken in the selected namespace, and only there", async () => {
    // The list the dialog is opened from is the list the check reads: a name that
    // exists in project-a cannot be created in project-a, while the same name in
    // another namespace is a different environment and is no clash at all.
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});

    // Same name as the fixture environment, which lives in project-a.
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-namespace"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const projectA = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === "project-a");
    await act(async () => {
      (projectA as HTMLElement).click();
    });
    const nameInput = document.body.querySelector('input[placeholder="e.g. jupyter-nlp-ln"]') as HTMLInputElement;
    setInput(nameInput, "jupyter-nlp-ln");
    await nextStep();

    // Step 1 holds, and says why.
    expect(document.body.querySelector('[data-step="2"]')).toBeNull();
    expect(document.body.querySelector('[data-od-id="field-error"]')?.textContent).toBe("名称不合法或已被占用。");

    // The same name under another namespace goes through.
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-namespace"] [role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    const def = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) => o.textContent === "default");
    await act(async () => {
      (def as HTMLElement).click();
    });
    await nextStep();
    expect(document.body.querySelector('[data-step="2"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("renders a refusal the route sent as a code, in the user's language", async () => {
    // The route answers with `{ error: "nameTaken", params: { name } }` and no
    // prose of its own, so the sentence below comes from the console's
    // dictionary — which is the only place a user-facing string can come from.
    const { container, root } = renderWithBoth({ status: 400, body: { error: "nameTaken", params: { name: "my-env" } } });
    await act(async () => {});
    await toStep3(container);
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    const shown = document.body.querySelector('[data-od-id="create-error"]') as HTMLElement;
    expect(shown.textContent).toBe("创建失败: 环境 'my-env' 已存在。");

    act(() => root.unmount());
  });

  it("names a code it has no sentence for, rather than inventing one", async () => {
    // Version skew: this bundle predates the route. A bare code still names what
    // was refused; "HTTP 400" names nothing.
    const { container, root } = renderWithBoth({ status: 400, body: { error: "someFutureRefusal" } });
    await act(async () => {});
    await toStep3(container);
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect((document.body.querySelector('[data-od-id="create-error"]') as HTMLElement).textContent).toContain("someFutureRefusal");

    act(() => root.unmount());
  });

  it("asks for root as uid 0 alone, with no account", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    await act(async () => {
      rootSwitch().click();
    });
    await nextStep();
    expect(document.body.textContent).toContain("root(uid/gid 0)");
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    const body = createdBody();
    expect(body).toMatchObject({ runAsUser: 0, runAsGroup: 0 });
    // The operator serves "root" itself and reports spec.runtime.user as
    // overridden, so there is no account to state.
    expect("runtimeUser" in body).toBe(false);

    act(() => root.unmount());
  });

  it("sends the workspace, runtime and network sections the advanced step filled in", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    setInput(mountPathInput(), "/data");

    // One extra PVC, in the workspace section (the first 添加 button).
    clickRow("row-add", 0);
    setInput(rowInputs("pvc-name")[0], "shared-models");
    setInput(rowInputs("pvc-path")[0], "/models");

    // One variable, in the runtime section, plus a line of arguments and one of
    // command.
    clickRow("row-add", 1);
    setInput(rowInputs("env-name")[0], "HF_HOME");
    setInput(rowInputs("env-value")[0], "/data/hf");
    setInput(argsInput(), "--port 8080");
    setInput(commandInput(), 'python -m "my app"');

    // One port, in the network section.
    clickRow("row-add", 2);
    setInput(rowInputs("port-name")[0], "debug");
    setInput(rowInputs("port-num")[0], "9229");

    await nextStep();
    expect(document.body.querySelector('[data-step="4"]')).not.toBeNull();
    // The confirmation step restates the section, so what is read on step 4 is
    // what a user would notice before submitting.
    expect(document.body.textContent).toContain("shared-models → /models");

    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(createdBody()).toMatchObject({
      mountPath: "/data",
      volumes: [{ pvcName: "shared-models", mountPath: "/models" }],
      env: [{ name: "HF_HOME", value: "/data/hf" }],
      // One command line each on the wire: the split into argv is the route's
      // job, and the two land on different spec.runtime keys.
      command: 'python -m "my app"',
      args: "--port 8080",
      ports: [{ name: "debug", containerPort: 9229, type: "http" }],
    });

    act(() => root.unmount());
  });

  it("leaves the five new keys out of the body when the advanced step is untouched", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    const body = createdBody();
    // An empty mount-path box means "let the controller derive it". Sending the
    // placeholder — the path the box displays — would pin HOME where the image's
    // own entrypoint puts it (jupyter's /home/jovyan).
    expect("mountPath" in body).toBe(false);
    expect("volumes" in body).toBe(false);
    expect("env" in body).toBe(false);
    expect("command" in body).toBe(false);
    expect("args" in body).toBe(false);
    expect("ports" in body).toBe(false);

    act(() => root.unmount());
  });

  it("drops a row the user added but never filled in", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    clickRow("row-add", 0);
    clickRow("row-add", 1);
    clickRow("row-add", 2);
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    // Three empty rows still describe nothing, so none of them reach the CR —
    // and none of them block the step either.
    const body = createdBody();
    expect("volumes" in body).toBe(false);
    expect("env" in body).toBe(false);
    expect("ports" in body).toBe(false);

    act(() => root.unmount());
  });

  it("blocks the step on a PVC that mounts over the workspace path", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    setInput(mountPathInput(), "/data");
    clickRow("row-add", 0);
    setInput(rowInputs("pvc-name")[0], "shared-models");
    setInput(rowInputs("pvc-path")[0], "/data");

    await nextStep();
    expect(document.body.querySelector('[data-step="4"]')).toBeNull();
    expect(document.body.textContent).toContain("每条 PVC 需同时填写名称与以 / 开头的挂载路径");

    act(() => root.unmount());
  });

  it("blocks the step on a HOME that is not absolute", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    clickRow("row-add", 1);
    setInput(rowInputs("env-name")[0], "HOME");
    setInput(rowInputs("env-value")[0], "opt/home");

    await nextStep();
    // A relative HOME is legal for the pod but not for the controller, whose
    // workspace derivation reads it — the API server would take it and the
    // environment would come up without the workspace it asked for.
    expect(document.body.querySelector('[data-step="4"]')).toBeNull();
    expect(document.body.textContent).toContain("HOME 需为绝对路径");

    act(() => root.unmount());
  });

  it("blocks the step on a port row the CRD would reject", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    clickRow("row-add", 2);
    setInput(rowInputs("port-name")[0], "debug");
    setInput(rowInputs("port-num")[0], "70000");

    await nextStep();
    expect(document.body.querySelector('[data-step="4"]')).toBeNull();
    expect(document.body.textContent).toContain("端口须为 1–65535 的整数");

    setInput(rowInputs("port-num")[0], "9229");
    await nextStep();
    expect(document.body.querySelector('[data-step="4"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("sends spec.network only when the RDMA toggle is on", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    // The RDMA toggle is off by default, so no network reaches the body.
    // Flipping it on exposes the fabric select and writes spec.network.
    const rdmaSwitch = document.body.querySelector('[data-od-id="wizard-rdma"] input') as HTMLInputElement;
    await act(async () => {
      rdmaSwitch.click();
    });
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(createdBody()).toMatchObject({ rdmaEnabled: true, rdmaType: "roce" });

    act(() => root.unmount());
  });

  it("sends spec.ssh with a bring-your-own key Secret when SSH is on", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    // Turning on the SSH toggle loads the labelled key Secrets for the namespace
    // and exposes the picker (independent of the environment's type).
    const sshSwitch = document.body.querySelector('[data-od-id="wizard-ssh"] input') as HTMLInputElement;
    await act(async () => {
      sshSwitch.click();
    });
    // Let the ssh-keys fetch resolve before interacting with the picker.
    await act(async () => {});

    // Select a labelled key Secret; the key defaults to its first data entry.
    // The picker opens from its inner combobox, as MUI attaches the mousedown
    // handler there and the od-id sits on the field root.
    const sshSecretSelect = document.body.querySelector(
      '[data-od-id="wizard-ssh-secret"] [role="combobox"]',
    ) as HTMLElement;
    expect(sshSecretSelect).not.toBeNull();
    await selectOption(sshSecretSelect, "alice-keys");

    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    const body = createdBody();
    expect(body).toMatchObject({
      sshEnabled: true,
      sshKeysSecret: "alice-keys",
      sshKeysKey: "alice@laptop",
    });

    act(() => root.unmount());
  });

  it("says why an empty image blocks the step instead of refusing silently", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
    setInput(document.body.querySelector('input[placeholder="e.g. jupyter-nlp-ln"]') as HTMLInputElement, "r2-web");
    await act(async () => {});

    // Clearing the field — what its own clear button does before a new reference
    // is typed — used to leave Next doing nothing at all: no message, no error
    // colour, and no way to learn what was missing.
    setInput(imageInput(), "");
    await act(async () => {});
    await nextStep();

    expect(document.body.querySelector('[data-step="2"]')).toBeNull();
    // The name and the namespace are filled here, so the image is the only field
    // that can be complaining.
    const err = document.body.querySelector('[data-od-id="field-error"]');
    expect(err?.textContent).toBe("请填写开发镜像地址,或从平台内置镜像中选择。");
    // Announced, not only painted.
    expect(err?.getAttribute("role")).toBe("alert");

    // A reference of any kind clears it, and the step advances.
    setInput(imageInput(), "busybox:latest");
    await act(async () => {});
    await nextStep();
    expect(document.body.querySelector('[data-step="2"]')).not.toBeNull();
    expect(document.body.querySelector('[data-od-id="field-error"]')).toBeNull();

    act(() => root.unmount());
  });

  it("offers only the environment types the platform can serve", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});

    // `vscode` is a legal spec.type that nothing publishes an image for:
    // mainContainerPort maps it to 8080, and neither the readiness probe nor the
    // Service can be satisfied because no shipped image binds that port. Offering
    // the type would be offering a spec the platform cannot honour — a 0/1 pod
    // behind a route that reports RouteReady=True and answers 503.
    // The type cards are the buttons carrying a description line (the image
    // combobox's own clear button sits in the same step).
    const types = Array.from(document.body.querySelectorAll('[data-step="1"] button'))
      .filter((b) => b.querySelector("span"))
      .map((b) => b.firstElementChild?.textContent ?? "");
    expect(types).toEqual(["JupyterLab", "SSH"]);
    expect(document.body.textContent).not.toContain("VS Code");

    act(() => root.unmount());
  });

  it("offers only the images that serve the chosen type", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});

    // The wizard opens on the first catalog image — jupyter-minimal, which serves
    // the jupyter type it also opens on — and the list holds only jupyter images.
    expect(imageInput().value).toBe("harbor.isuanova.com/suanova/jupyter-minimal:latest");
    expect(await offeredImageTags()).toEqual([
      "harbor.isuanova.com/suanova/jupyter-minimal:latest",
      "harbor.isuanova.com/suanova/jupyter-cuda-pytorch:latest",
      "harbor.isuanova.com/suanova/jupyter-maca-pytorch:latest",
    ]);

    // SSH is served by the other three, and nothing mixes the two: an ssh image
    // under type jupyter runs sshd with nothing serving the token the operator
    // publishes for it, which is the environment the type is supposed to describe.
    await clickType("SSH");
    expect(await offeredImageTags()).toEqual([
      "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest",
      "harbor.isuanova.com/suanova/ssh-cuda-pytorch:latest",
      "harbor.isuanova.com/suanova/ssh-maca-pytorch:latest",
    ]);

    act(() => root.unmount());
  });

  it("keeps the accelerator when the type changes", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});

    // The two images of a stack differ only in the mode baked into them, so a
    // CUDA environment moved to ssh lands on the CUDA ssh image. Following the
    // type alone would put it on the CPU image, which the operator refuses as a
    // brand mismatch (Accepted=False / BrandMismatch) — the same dead end
    // reached by a different route.
    setInput(imageInput(), "harbor.isuanova.com/suanova/jupyter-cuda-pytorch:latest");
    await act(async () => {});
    await clickType("SSH");
    expect(imageInput().value).toBe("harbor.isuanova.com/suanova/ssh-cuda-pytorch:latest");
    // ...and the identity follows the image, since ubuntu/1000 is the shipped
    // account rather than whatever the previous image implied.
    expect(document.body.textContent).not.toContain("与当前环境类型不一致");

    // A reference the platform does not publish is not the catalog's to replace:
    // it is left exactly as typed, and nothing is claimed about what it serves,
    // since only the catalog knows an image's interface.
    setInput(imageInput(), "busybox:latest");
    await act(async () => {});
    await clickType("SSH");
    expect(imageInput().value).toBe("busybox:latest");
    expect(document.body.textContent).not.toContain("与当前环境类型不一致");

    act(() => root.unmount());
  });

  it("says when the chosen image does not serve the chosen type", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});

    // The catalog opens on a jupyter image under the jupyter type: nothing to say.
    expect(document.body.textContent).not.toContain("与当前环境类型不一致");

    // An ssh image under the jupyter type is the combination the per-interface
    // vendor pairs make expressible, and the one nothing can serve: the
    // operator would publish a jupyter token for an image whose sshd is all
    // that starts. The list no longer offers it, so the user has to type it —
    // which is exactly the case the hint is for.
    setInput(imageInput(), "harbor.isuanova.com/suanova/ssh-maca-pytorch:latest");
    await act(async () => {});
    expect(document.body.textContent).toContain("与当前环境类型不一致");

    // Choosing the type the image was built for settles it.
    await clickType("SSH");
    expect(document.body.textContent).not.toContain("与当前环境类型不一致");

    act(() => root.unmount());
  });

  it("opens the wizard on the namespace the API offers, not the first it lists", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="create-env-btn"]') as HTMLElement).click();
    });
    await act(async () => {});

    // project-a sorts first in the options; the API's default is `default`. On
    // a real install the first entry used to be a platform namespace, which an
    // untouched wizard then created the environment in.
    const namespace = document.body.querySelector('[data-od-id="wizard-namespace"] [role="combobox"]') as HTMLElement;
    expect(namespace.textContent).toBe("default");
    // Every namespace the API offered is still selectable.
    expect(await selectOption(namespace, "project-a")).toEqual(["project-a", "default"]);

    act(() => root.unmount());
  });

  it("sends spec.storage.pvcRetention when the workspace is to outlive the environment", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    // The control opens on the CRD's default (delete), which the body does not
    // state: absent and delete mean the same thing to the API server.
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});
    expect("pvcRetention" in createdBody()).toBe(false);

    act(() => root.unmount());
  });

  it("keeps the workspace when the user asks for it, and says so on the confirm step", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    const retention = document.body.querySelector('[data-od-id="wizard-pvc-retention"] [role="combobox"]') as HTMLElement;
    expect(retention).not.toBeNull();
    // The two-way choice names the consequence, not the field.
    expect(await selectOption(retention, "保留工作区卷")).toEqual(["随环境一并删除(默认)", "保留工作区卷"]);

    await nextStep();
    expect(document.body.textContent).toContain("保留工作区卷");
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(createdBody()).toMatchObject({ storageGi: 200, pvcRetention: "retain" });

    act(() => root.unmount());
  });
});