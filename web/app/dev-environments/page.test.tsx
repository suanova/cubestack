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
    { tag: "base-cuda-12.4:v1.6", label: "base-cuda-12.4:v1.6 · CUDA 12.4" },
    { tag: "base-cuda-12.1:v1.6", label: "base-cuda-12.1:v1.6 · CUDA 12.1" },
    { tag: "base-maca-2.28:v1.3", label: "base-maca-2.28:v1.3 · MACA 2.28" },
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
    expect(container.textContent).toContain("base-cuda-12.4:v1.6");

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
    expect(document.body.textContent).toContain("GPU 类型");
    expect(document.body.textContent).toContain("持久化存储(Gi)");

    act(() => root.unmount());
  });

  it("blocks advancing past step 2 on invalid GPU / storage values", async () => {
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

    // number inputs in step 2: [gpuCount, storageGi]
    const nums = Array.from(document.body.querySelectorAll('[data-step="2"] input[type="number"]')) as HTMLInputElement[];
    expect(nums).toHaveLength(2);
    const setNum = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setNum(nums[0], "1.5"); // fractional gpuCount
      setNum(nums[1], "10"); // storage below 20
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    // still on step 2 and per-field errors surfaced
    expect(document.body.querySelector('[data-step="3"]')).toBeNull();
    expect(document.body.textContent).toContain("GPU 卡数须为 1–16 的整数。");
    expect(document.body.textContent).toContain("持久化存储须为 20–800(Gi) 的整数。");

    // fixing both lets the wizard proceed
    await act(async () => {
      setNum(nums[0], "2");
      setNum(nums[1], "200");
    });
    await act(async () => {});
    await act(async () => {
      (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "下一步") as HTMLElement).click();
    });
    await act(async () => {});
    expect(document.body.querySelector('[data-step="3"]')).not.toBeNull();

    act(() => root.unmount());
  });
});