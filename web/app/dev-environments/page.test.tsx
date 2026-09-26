import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DevEnvironmentsPage from "./page";
import { devEnvironmentList } from "@/test/fixtures/devenvironments";

// The test files avoid JSX because tsconfig sets jsx: "preserve" (for Next),
// which vitest's import-analysis can't transform.

const OPTIONS = {
  namespaces: [{ name: "project-a" }, { name: "default" }],
  images: [
    { tag: "harbor.isuanova.com/suanova/jupyter-minimal:latest", label: "suanova/jupyter-minimal · CPU · JupyterLab (jovyan)", user: "jovyan", runAsGroup: 100 },
    { tag: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest", label: "suanova/ssh-ubuntu22.04 · CPU · SSH (ubuntu)", user: "ubuntu" },
    { tag: "harbor.isuanova.com/suanova/base-cuda:latest", label: "suanova/base-cuda · NVIDIA CUDA (ubuntu)", user: "ubuntu" },
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
    expect(container.textContent).toContain("harbor.isuanova.com/suanova/base-cuda:latest");
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
    const { container, root } = renderPage();
    await act(async () => {});

    const startBtn = container.querySelector('[data-od-id="act-start-ssh-dataset-prep"]');
    expect(startBtn).not.toBeNull();
    await act(async () => {
      (startBtn as HTMLElement).click();
    });
    await act(async () => {});
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ namespace: "project-a", name: "ssh-dataset-prep", running: true });

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
    const { container, root } = renderPage();
    await act(async () => {});

    const delBtn = container.querySelector('[data-od-id="act-del-ssh-dataset-prep"]');
    expect(delBtn).not.toBeNull();
    await act(async () => {
      (delBtn as HTMLElement).click();
    });
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
    const { container, root } = renderPage();
    await act(async () => {});

    const delBtn = container.querySelector('[data-od-id="act-del-ssh-dataset-prep"]');
    await act(async () => {
      (delBtn as HTMLElement).click();
    });
    await act(async () => {});
    expect(deletes).toHaveLength(0);

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
    const stopBtn = container.querySelector('[data-od-id="act-stop-jupyter-nlp-ln"]');
    expect(stopBtn).not.toBeNull();
    await act(async () => {
      (stopBtn as HTMLElement).click();
    });
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

  function renderWithBoth() {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/options")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => OPTIONS });
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

  /** Step 3's workspace mount path — empty means "derive it from the identity". */
  function mountPathInput(): HTMLInputElement {
    return document.body.querySelector('[data-od-id="wizard-mount-path"] input') as HTMLInputElement;
  }

  /** Step 3's runtime args line. */
  function argsInput(): HTMLInputElement {
    return document.body.querySelector('[data-od-id="wizard-args"] input') as HTMLInputElement;
  }

  /** The body of the POST the wizard sent to /api/devenvironments. */
  function createdBody(): Record<string, unknown> {
    const call = (globalThis.fetch as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }).mock.calls.find(
      ([url, init]) => String(url) === "/api/devenvironments" && init?.method === "POST",
    );
    expect(call).toBeTruthy();
    const [, init] = call as [RequestInfo | URL, RequestInit];
    return JSON.parse(init.body as string);
  }

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

    // One variable, in the runtime section, plus a line of arguments.
    clickRow("row-add", 1);
    setInput(rowInputs("env-name")[0], "HF_HOME");
    setInput(rowInputs("env-value")[0], "/data/hf");
    setInput(argsInput(), "--port 8080");

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
      // A single command line on the wire: the split into argv is the route's job.
      args: "--port 8080",
      ports: [{ name: "debug", containerPort: 9229, type: "http" }],
    });

    act(() => root.unmount());
  });

  it("leaves the four new keys out of the body when the advanced step is untouched", async () => {
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
});