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
  // What the cluster's nodes advertise, in each vendor's device-plugin spelling.
  // More than one model per vendor, so the list's order — not just its contents —
  // is something a case can assert.
  gpuModels: { nvidia: ["A100", "H200"], metax: ["MXC500", "MXC550"] },
  // The nodes the wizard may pin to, with the vendors each advertises — one CPU
  // node, one of each vendor, and one carrying both, so the option text can be
  // asserted for every shape it takes.
  nodes: [
    { name: "worker-01", vendors: ["nvidia"] },
    { name: "worker-02", vendors: [] },
    { name: "worker-03", vendors: ["nvidia", "metax"] },
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

  // The value the stubbed token endpoint hands back, and one entry per request
  // made for it (see stubData).
  const JUPYTER_TOKEN = "fa4040c1b2e34d5f8091aa2b3c5d5e6f";
  const tokenRequests: string[] = [];
  // The key the stubbed ssh-key endpoint hands back, and the requests made for
  // it: the login command embeds the key, so it is fetched as lazily as the token.
  const SSH_KEY =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----\n";
  const keyRequests: string[] = [];
  // The literal env values the endpoint hands back, and the requests made for
  // them: the list carries names only, so the spec panel fetches the values for
  // one environment when its detail opens.
  const ENV_VALUES: Record<string, string> = {
    HF_HOME: "/home/ubuntu/.cache/huggingface",
    HF_TOKEN: "hf_example",
  };
  const envRequests: string[] = [];

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
    tokenRequests.length = 0;
    keyRequests.length = 0;
    envRequests.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        // The token endpoint is the one request whose *timing* matters: the card
        // must not pull a credential it was not asked to show.
        if (String(url).includes("/api/devenvironments/token")) {
          const q = new URL(String(url), "http://localhost").searchParams;
          tokenRequests.push(`${q.get("namespace")}/${q.get("name")}`);
          return { ok: true, status: 200, json: async () => ({ token: JUPYTER_TOKEN, secret: { name: "jupyter-nlp-ln-jupyter-token", namespace: "project-a" } }) };
        }
        // The private key is handed out the same way, and is read as text: the
        // route serves it as a file, not as JSON.
        if (String(url).includes("/api/devenvironments/ssh-key")) {
          const q = new URL(String(url), "http://localhost").searchParams;
          keyRequests.push(`${q.get("namespace")}/${q.get("name")}`);
          return { ok: true, status: 200, text: async () => SSH_KEY, json: async () => ({}) };
        }
        if (String(url).includes("/api/devenvironments/env-values")) {
          const q = new URL(String(url), "http://localhost").searchParams;
          envRequests.push(`${q.get("namespace")}/${q.get("name")}`);
          return { ok: true, status: 200, json: async () => ({ values: ENV_VALUES }) };
        }
        return { ok, status: ok ? 200 : 500, json: async () => (ok ? { items } : { error: "boom" }) };
      }),
    );
  }

  /**
   * Run one of a row's actions. An expanded row lays them out in the row itself;
   * a closed one keeps them behind a kebab, which takes a second click and lands
   * its menu in a portal on document.body rather than inside the container the
   * page rendered into.
   */
  function rowAct(name: string, kind: "start" | "stop" | "del") {
    const selector = `[data-od-id="act-${kind}-${name}"]`;
    if (!document.body.querySelector(selector)) {
      // Still behind the kebab. An expanded row has none, so only reach for it
      // when the row is actually closed; otherwise the action simply is not
      // offered and the assertion below should say so.
      const ops = document.body.querySelector(`[data-od-id="env-ops-${name}"]`);
      if (ops) act(() => { (ops as HTMLElement).click(); });
    }
    const item = document.body.querySelector(selector);
    expect(item).not.toBeNull();
    act(() => {
      (item as HTMLElement).click();
    });
  }

  /** A row's kebab button. */
  function kebab(container: HTMLElement, name: string): HTMLButtonElement {
    return container.querySelector(`[data-od-id="env-ops-${name}"]`) as HTMLButtonElement;
  }

  /**
   * Answer the delete dialog. It replaced window.confirm, so deleting is now the
   * row's click plus a click here — and like the menu, it renders into a portal
   * on document.body rather than inside the container the page rendered into.
   */
  async function answerDelete(ok: boolean) {
    const btn = document.body.querySelector(`[data-od-id="delete-${ok ? "confirm" : "cancel"}"]`);
    expect(btn).not.toBeNull();
    await act(async () => {
      (btn as HTMLElement).click();
    });
    await act(async () => {});
  }

  /** What the delete dialog says deleting this environment does to its workspace. */
  function deletePrompt(): string {
    return document.body.querySelector('[data-od-id="delete-prompt"]')?.textContent ?? "";
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
    expect(container.textContent).toContain("规格");
    expect(container.textContent).toContain("状态");
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
    // The detail's env-values fetch resolves a tick after the list's.
    await act(async () => {});

    // The selected environment states everything: storage shows the mount path
    // the CR carries, and each new section gets a row of its own.
    expect(container.textContent).toContain("200Gi · /home/ubuntu");
    expect(container.textContent).toContain("data-cache → /data");
    // One environment variable per line: the list response does not carry the
    // literal values, so the panel fetches them when its detail opens — and
    // shows them as they are, with no reveal toggle.
    expect(container.textContent).toContain("HF_HOME=/home/ubuntu/.cache/huggingface\nHF_TOKEN=hf_example");
    expect(container.querySelector('[data-od-id="env-values-toggle"]')).toBeNull();
    expect(envRequests).toEqual(["project-a/jupyter-nlp-ln"]);
    expect(container.textContent).toContain("python -m jupyter lab");
    expect(container.textContent).toContain("--port 8080");
    expect(container.textContent).toContain("api:8080/http");
    // The two rows that describe where the pod runs and what it may reach: the
    // pin as the CR states it, and the egress policy the environment asked for.
    expect(container.textContent).toContain("kubernetes.io/hostname=worker-01");
    expect(container.textContent).toContain("不受限");

    // The stopped environment carries no mount path, which is not the same as
    // mounting at /workspace — the controller derives it, and /workspace is only
    // the last resort of that derivation.
    await act(async () => {
      (container.querySelector('[data-od-id="dev-row-ssh-dataset-prep"]') as HTMLElement).click();
    });
    expect(container.textContent).toContain("500Gi · 按运行身份自动派生");
    expect(container.textContent).toContain("shared-models → /models (只读)");
    expect(container.textContent).toContain("debug:9229/tcp");
    // Egress is the one row that is always shown, because every environment is in
    // one of the two states: an environment that never asked is restricted, and
    // the row says so rather than leaving the reader to infer it from silence.
    expect(container.textContent).toContain("受限(默认)");

    act(() => root.unmount());
  });

  it("links an endpoint the user can open, and keeps it copyable", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    // The endpoint is a URL, so it opens the container's own UI in a new tab
    // instead of asking the user to select and paste it — and the copy button
    // stays, for the places a link cannot go (a terminal, a client config).
    const link = container.querySelector('[data-od-id="endpoint-link"]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://dev.cubestack.local/ws/jupyter-nlp-ln");
    expect(link.getAttribute("target")).toBe("_blank");
    // noopener: a new tab must not get a handle on this window through `window.opener`.
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent).toBe("https://dev.cubestack.local/ws/jupyter-nlp-ln");

    // The copy button next to it still copies the address itself.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true, writable: true });
    let copiedInto = "";
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => {
        copiedInto = (document.querySelector("textarea") as HTMLTextAreaElement).value;
        return true;
      },
    });
    const row = link.closest("div")?.parentElement as HTMLElement;
    await act(async () => {
      (Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "复制") as HTMLElement).click();
    });
    expect(copiedInto).toBe("https://dev.cubestack.local/ws/jupyter-nlp-ln");

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

  it("paints Progressing False as the settled state, not a failure", async () => {
    stubData([
      devEnvironmentSummary({
        name: "settled-env",
        conditions: [
          { type: "Ready", status: "True", reason: "Running", message: "" },
          { type: "Progressing", status: "False", reason: "Converged", message: "Nothing in flight" },
          { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "" },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    const pill = (type: string) => container.querySelector(`[data-od-id="cond-${type}"]`);
    // A settled Progressing (False) wears the same success tint as a True
    // condition; a False condition of the usual polarity stays the error tint.
    expect(pill("Progressing")?.className).toBe(pill("Ready")?.className);
    expect(pill("PodScheduled")?.className).not.toBe(pill("Ready")?.className);

    act(() => root.unmount());
  });

  it("prints every condition beside its pill, True ones included", async () => {
    stubData([
      devEnvironmentSummary({
        name: "half-broken-env",
        conditions: [
          // A True condition whose message is empty: the pill is the whole line.
          { type: "Accepted", status: "True", reason: "Accepted", message: "" },
          // A True condition with a sentence: the controller saying what it did,
          // on the same line as its pill.
          { type: "RouteReady", status: "True", reason: "Published", message: "Routes are published on the gateway" },
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

    expect(container.querySelector('[data-od-id="cond-note-RouteReady"]')?.textContent).toBe(
      ": Routes are published on the gateway",
    );
    expect(container.querySelector('[data-od-id="cond-note-Ready"]')?.textContent).toBe(
      ": Environment pod is running but not ready",
    );
    expect(container.querySelector('[data-od-id="cond-note-BrandOk"]')?.textContent).toBe(
      ': image "x" does not match gpu.vendor metax',
    );
    // An empty message takes no line: ": " on its own reads as a message that
    // failed to arrive. The pill still states the condition.
    expect(container.querySelector('[data-od-id="cond-note-Accepted"]')).toBeNull();
    expect(container.querySelector('[data-od-id="cond-Accepted"]')?.textContent).toBe("AcceptedTrue");
    // The reason is off the line but not out of reach: the pill's hover carries
    // it beside the message.
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

  it("shows the jupyter token masked until it is asked for, and nothing for an ssh environment", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    const value = () => container.querySelector('[data-od-id="token-value"]') as HTMLElement;
    const toggle = () => container.querySelector('[data-od-id="token-toggle"]') as HTMLElement;
    // Masked on arrival, at a width the token's own length cannot be read off,
    // and nothing has been fetched: the credential waits to be asked for.
    expect(value().textContent).toBe("•".repeat(12));
    expect(container.querySelector('[data-od-id="token-secret"]')?.textContent).toContain(
      "project-a/jupyter-nlp-ln-jupyter-token",
    );
    expect(tokenRequests).toEqual([]);

    // The eye is what asks for it, and the value is the token itself — not a
    // command the user is meant to run against a cluster they may have no shell on.
    await act(async () => {
      toggle().click();
    });
    expect(tokenRequests).toEqual(["project-a/jupyter-nlp-ln"]);
    expect(value().textContent).toBe(JUPYTER_TOKEN);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe("隐藏 Token");

    // Clicking again hides it without a second read.
    await act(async () => {
      toggle().click();
    });
    expect(value().textContent).toBe("•".repeat(12));
    expect(toggle().getAttribute("aria-label")).toBe("显示 Token");
    expect(tokenRequests).toHaveLength(1);

    // Copy takes the same value the reveal shows, and asks for it if the user
    // went straight for the clipboard.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true, writable: true });
    let copiedInto = "";
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => {
        copiedInto = (document.querySelector("textarea") as HTMLTextAreaElement).value;
        return true;
      },
    });
    const tokenRow = value().parentElement as HTMLElement;
    await act(async () => {
      (Array.from(tokenRow.querySelectorAll("button")).find((b) => b.textContent === "复制") as HTMLElement).click();
    });
    expect(copiedInto).toBe(JUPYTER_TOKEN);

    // An ssh environment has no token: no row at all.
    await act(async () => {
      (container.querySelector('[data-od-id="dev-row-ssh-dataset-prep"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-od-id="token-value"]')).toBeNull();
    expect(container.textContent).not.toContain("kubectl -n");
    expect(tokenRequests).toHaveLength(1);

    act(() => root.unmount());
  });

  it("hands out the private key as a download and as a masked, self-contained command", async () => {
    stubData([
      devEnvironmentSummary({
        endpoints: [
          { name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-nlp-ln" },
          { name: "ssh", address: "ssh://ubuntu@203.0.113.7:2200" },
        ],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});

    // The card carries the login command and the download together in one row —
    // the generic endpoint row stands aside — so the key is named once.
    const endpoint = container.querySelector('[data-od-id="ssh-endpoint"]') as HTMLElement;
    expect(endpoint.textContent).toBe("ssh -i ./id_ed25519 ubuntu@203.0.113.7 -p 2200");
    const link = container.querySelector('[data-od-id="ssh-key-download"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("/cubestack/api/devenvironments/ssh-key?namespace=project-a&name=jupyter-nlp-ln");
    expect(link.parentElement).toBe(endpoint.parentElement);
    // The download path states its follow-up: ssh refuses a key that is group-
    // or world-readable, so the hint chmods it before the login command runs.
    expect(container.querySelector('[data-od-id="ssh-key-hint"]')?.textContent).toBe(
      "下载后使用:chmod -R 600 ./id_ed25519",
    );

    // The second shape is one paste-ready command that embeds the key, writes
    // it to a private temp file, and removes it after the session. It is masked
    // on arrival and nothing has been fetched: the key waits to be asked for.
    const command = () => container.querySelector('[data-od-id="ssh-command-value"]') as HTMLElement;
    const toggle = () => container.querySelector('[data-od-id="ssh-command-toggle"]') as HTMLElement;
    expect(command().textContent).toBe("•".repeat(12));
    expect(keyRequests).toEqual([]);

    await act(async () => {
      toggle().click();
    });
    expect(keyRequests).toEqual(["project-a/jupyter-nlp-ln"]);
    const shown = command().textContent ?? "";
    // A subshell: the pasted line must not close the user's interactive shell.
    expect(shown.startsWith('(tmp=$(mktemp) && chmod 600 "$tmp"')).toBe(true);
    expect(shown.endsWith('exit "$rc")')).toBe(true);
    // The key is carried verbatim, so it needs no file on disk before the paste.
    expect(shown).toContain(SSH_KEY);
    expect(shown).toContain('ssh -i "$tmp" -p 2200 \'ubuntu@203.0.113.7\'');
    expect(shown).toContain('rc=$?; rm -f "$tmp"; exit "$rc"');
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe("隐藏登录命令");

    // Hiding it again is local: the key is already here, so nothing is re-read.
    await act(async () => {
      toggle().click();
    });
    expect(command().textContent).toBe("•".repeat(12));
    expect(toggle().getAttribute("aria-label")).toBe("显示登录命令");
    expect(keyRequests).toHaveLength(1);

    act(() => root.unmount());
  });

  it("shows no key download for an environment keyed with the user's own keys", async () => {
    // sshClientKeySecret is null when the spec names the user's own key Secret:
    // no keypair was minted, and there is nothing the card can hand out.
    stubData([
      devEnvironmentSummary({
        sshClientKeySecret: null,
        endpoints: [{ name: "ssh", address: "ssh://ubuntu@203.0.113.7:2200" }],
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});
    expect(container.querySelector('[data-od-id="ssh-key-download"]')).toBeNull();

    act(() => root.unmount());
  });

  it("does not carry a revealed token over to the next environment", async () => {
    stubData([
      ...devEnvironmentList(),
      devEnvironmentSummary({
        name: "jupyter-vision",
        type: "jupyter",
        endpoints: [{ name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-vision" }],
        jupyterTokenSecret: { name: "jupyter-vision-jupyter-token", namespace: "project-a" },
      }),
    ]);
    const { container, root } = renderPage();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="token-toggle"]') as HTMLElement).click();
    });
    expect((container.querySelector('[data-od-id="token-value"]') as HTMLElement).textContent).toBe(JUPYTER_TOKEN);

    // The detail panel is one component with new props when another row is
    // selected: revealed state must not follow it, or the panel would show the
    // environment that was just navigated away from — with its value on screen.
    await act(async () => {
      (container.querySelector('[data-od-id="dev-row-jupyter-vision"]') as HTMLElement).click();
    });
    expect((container.querySelector('[data-od-id="token-value"]') as HTMLElement).textContent).toBe("•".repeat(12));
    expect(container.querySelector('[data-od-id="token-toggle"]')?.getAttribute("aria-pressed")).toBe("false");

    act(() => root.unmount());
  });

  it("says why a token could not be read instead of showing an empty box", async () => {
    stubData(devEnvironmentList());
    const calls = { n: 0 };
    const real = globalThis.fetch as unknown as (u: unknown, i?: unknown) => Promise<unknown>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: unknown) => {
        if (String(url).includes("/api/devenvironments/token")) {
          calls.n += 1;
          return { ok: false, status: 404, json: async () => ({ error: "tokenMissing" }) };
        }
        return real(url, init);
      }),
    );

    const { container, root } = renderPage();
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-od-id="token-toggle"]') as HTMLElement).click();
    });

    // The route's code reaches the row as a sentence in the user's language, and
    // the row stays masked rather than pretending the token is empty.
    const value = container.querySelector('[data-od-id="token-value"]') as HTMLElement;
    expect(value.textContent).toContain("尚未发布 Jupyter Token");
    expect(container.querySelector('[data-od-id="token-toggle"]')?.getAttribute("aria-pressed")).toBe("false");

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

  it("carries the detail under its own row, and closes it on a second click", async () => {
    stubData(devEnvironmentList());
    const { container, root } = renderPage();
    await act(async () => {});

    // The panel is a sibling of the row it belongs to, inside the table: no
    // column beside the table carries it.
    const row = container.querySelector('[data-od-id="dev-row-jupyter-nlp-ln"]') as HTMLElement;
    const panel = container.querySelector('[data-od-id="dev-detail-jupyter-nlp-ln"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.previousElementSibling).toBe(row);
    expect(panel.closest('[data-od-id="dev-table"]')).not.toBeNull();
    expect(row.getAttribute("aria-expanded")).toBe("true");

    // The open row is a disclosure: a second click closes it, and the detail
    // goes with it rather than staying behind as a column would.
    await act(async () => {
      row.click();
    });
    expect(container.querySelector('[data-od-id="dev-detail-jupyter-nlp-ln"]')).toBeNull();
    expect(container.querySelector('[data-od-id="dev-row-jupyter-nlp-ln"]')?.getAttribute("aria-expanded")).toBe("false");

    // ...and it opens its own detail again, not another environment's.
    await act(async () => {
      (container.querySelector('[data-od-id="dev-row-jupyter-nlp-ln"]') as HTMLElement).click();
    });
    expect(container.querySelectorAll('[data-od-id^="dev-detail-"]')).toHaveLength(1);
    expect(container.querySelector('[data-od-id="dev-detail-jupyter-nlp-ln"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("says the list is empty in the table, where the column used to say it", async () => {
    stubData([]);
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="dev-table"]')?.textContent).toContain("暂无开发环境");

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

    // Selecting a row lays its actions out in it, so what a phase offers can be
    // read straight off the row. The first row is already selected on load, so
    // only click the ones that are not.
    const select = (name: string) => {
      const row = container.querySelector(`[data-od-id="dev-row-${name}"]`) as HTMLElement;
      if (row.getAttribute("aria-expanded") !== "true") {
        act(() => {
          row.click();
        });
      }
    };
    const item = (kind: string, name: string) => document.body.querySelector(`[data-od-id="act-${kind}-${name}"]`);

    // Running: stop, and no start — but the way out is still there.
    select("jupyter-nlp-ln");
    expect(item("stop", "jupyter-nlp-ln")).not.toBeNull();
    expect(item("start", "jupyter-nlp-ln")).toBeNull();
    expect(item("del", "jupyter-nlp-ln")).not.toBeNull();

    // Stopped: start, and delete.
    select("sleeping-env");
    expect(item("start", "sleeping-env")).not.toBeNull();
    expect(item("del", "sleeping-env")).not.toBeNull();
    expect(item("stop", "sleeping-env")).toBeNull();

    // Pending, empty and Failed: no transition to offer — the controller owns
    // that — but the environment is still one the user can remove.
    for (const name of ["booting-env", "phaseless-env", "failed-env"]) {
      select(name);
      expect(item("start", name)).toBeNull();
      expect(item("stop", name)).toBeNull();
      expect(item("del", name)).not.toBeNull();
    }

    // A closed row keeps them behind the kebab: selecting another row puts the
    // buttons away and the kebab back.
    select("jupyter-nlp-ln");
    expect(kebab(container, "failed-env").disabled).toBe(false);
    expect(item("del", "failed-env")).toBeNull();

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
    const { root } = renderPage();
    await act(async () => {});

    rowAct("phaseless-env", "del");
    await answerDelete(true);

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

  it("Delete asks first, and sends DELETE only once the dialog is confirmed", async () => {
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
    const { root } = renderPage();
    await act(async () => {});

    rowAct("ssh-dataset-prep", "del");
    await act(async () => {});
    // Clicking Delete opens the dialog and nothing else: the request is the
    // user's answer, not the click that asks the question.
    expect(document.body.querySelector('[data-od-id="delete-dialog"]')).not.toBeNull();
    expect(deletes).toHaveLength(0);

    await answerDelete(true);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toEqual({ namespace: "project-a", name: "ssh-dataset-prep" });
    expect(document.body.querySelector('[data-od-id="delete-dialog"]')).toBeNull();

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
    const { root } = renderPage();
    await act(async () => {});

    rowAct("ssh-dataset-prep", "del");
    await answerDelete(false);
    expect(deletes).toHaveLength(0);
    expect(document.body.querySelector('[data-od-id="delete-dialog"]')).toBeNull();

    act(() => root.unmount());
  });

  it("reports a failed action in the console's dialog, not the browser's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          // What the route answers when the environment went away under the
          // click: a code, and the values its sentence needs.
          return { ok: false, status: 404, json: async () => ({ error: "nameMissing", params: { name: "jupyter-nlp-ln" } }) };
        }
        return { ok: true, status: 200, json: async () => ({ items: devEnvironmentList() }) };
      }),
    );
    const alerts = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { root } = renderPage();
    await act(async () => {});

    rowAct("jupyter-nlp-ln", "stop");
    await act(async () => {});

    // The API's sentence, in the console's own dialog: the browser alert could
    // be styled by neither the console nor this test.
    expect(alerts).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-od-id="error-dialog"]')).not.toBeNull();
    const message = document.body.querySelector('[data-od-id="error-message"]')?.textContent ?? "";
    // The code the route sent, resolved in the user's language — not the bare
    // code, and not "HTTP 404".
    expect(message).toContain("jupyter-nlp-ln");
    expect(message).not.toContain("nameMissing");

    await act(async () => {
      (document.body.querySelector('[data-od-id="error-close"]') as HTMLElement).click();
    });
    await act(async () => {});
    expect(document.body.querySelector('[data-od-id="error-dialog"]')).toBeNull();

    act(() => root.unmount());
  });

  it("names the workspace consequence of a delete, per that environment's policy", async () => {
    stubData([
      devEnvironmentSummary({ name: "kept-env", phase: "Stopped", endpoints: [], conditions: [], storage: { size: "20Gi", mountPath: null, pvcRetention: "retain" } }),
      devEnvironmentSummary({ name: "purged-env", phase: "Stopped", endpoints: [], conditions: [], storage: { size: "200Gi", mountPath: null, pvcRetention: "delete" } }),
    ]);
    const { root } = renderPage();
    await act(async () => {});

    // Cancelling each one keeps the request off the wire: what is under test is
    // the sentence the user reads at the moment of the decision, not the delete.
    rowAct("kept-env", "del");
    const kept = deletePrompt();
    await answerDelete(false);
    rowAct("purged-env", "del");
    const purged = deletePrompt();
    await answerDelete(false);

    // A retained workspace outlives the environment and nothing else names it,
    // so the dialog does — it is how one is found again.
    expect(kept).toContain("workspace-kept-env-0");
    expect(kept).toContain("20Gi");
    // The default policy is stated as the loss it is, not as the field name.
    expect(purged).toContain("workspace-purged-env-0");
    expect(purged).toContain("200Gi");

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

  /** Step 2's GPU-model select — present only once an accelerator is chosen. */
  function gpuModelSelect(): HTMLElement {
    return document.body.querySelector('[data-od-id="wizard-gpu-model"] [role="combobox"]') as HTMLElement;
  }

  /** Step 3's node select — the placement section's only control. */
  function nodeSelect(): HTMLElement {
    return document.body.querySelector('[data-od-id="wizard-node"] [role="combobox"]') as HTMLElement;
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

  function sudoSwitch(): HTMLInputElement {
    return document.body.querySelector('[data-od-id="wizard-sudo"] input') as HTMLInputElement;
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

  it("offers the models the cluster advertises, and sends the one chosen", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep2(container);

    // No accelerator, no model: the field arrives with the card count, not
    // before it, because "无(纯 CPU)" has nothing for a model to describe.
    expect(gpuModelSelect()).toBeNull();

    await selectOption(acceleratorSelect(), "nvidia");
    // A closed list of what this cluster's nodes advertise, plus "any": a model
    // no node carries would pin the environment to a node that does not exist.
    expect(await selectOption(gpuModelSelect(), "H200")).toEqual(["任意(不限定型号)", "A100", "H200"]);

    await nextStep();
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(createdBody()).toMatchObject({ accelerator: "nvidia", gpuCount: 1, gpuModel: "H200" });

    act(() => root.unmount());
  });

  it("clears the model when the vendor changes, and sends none for `any`", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep2(container);

    await selectOption(acceleratorSelect(), "nvidia");
    await selectOption(gpuModelSelect(), "H200");

    // The other vendor's models are the other vendor's: a pin carried across the
    // change would name a card the operator can never match, because the label
    // and the model always have to describe one vendor.
    await selectOption(acceleratorSelect(), "metax");
    expect(gpuModelSelect().textContent).toBe("任意(不限定型号)");
    expect(await selectOption(gpuModelSelect(), "MXC500")).toEqual(["任意(不限定型号)", "MXC500", "MXC550"]);

    // Back to "any": the field is absent from the body, not sent empty.
    await selectOption(gpuModelSelect(), "任意(不限定型号)");
    await nextStep();
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    const body = createdBody();
    expect(body).toMatchObject({ accelerator: "metax" });
    expect(body).not.toHaveProperty("gpuModel");

    act(() => root.unmount());
  });

  it("sends no model at all when no accelerator is chosen", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep2(container);

    await nextStep();
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    // Not a stale default carried along for the ride: the body describes no
    // card, so it describes no model either.
    expect(createdBody()).not.toHaveProperty("gpuModel");

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

  it("grants sudo to the runtime account only when asked", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    await act(async () => {
      sudoSwitch().click();
    });
    await nextStep();
    // The confirmation restates the grant beside the identity, so it is visible
    // before the environment is created.
    expect(document.body.textContent).toContain("sudo");
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    expect(createdBody()).toMatchObject({ sudo: true });

    act(() => root.unmount());
  });

  it("does not state sudo for a root environment", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    await act(async () => {
      sudoSwitch().click();
    });
    await act(async () => {
      rootSwitch().click();
    });
    // The grant belongs to the non-root account; a root container already has it.
    expect(sudoSwitch().disabled).toBe(true);
    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    const body = createdBody();
    expect(body).toMatchObject({ runAsUser: 0, runAsGroup: 0 });
    expect("sudo" in body).toBe(false);

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

    // Egress, and the node to pin to. The select offers "any" plus the nodes the
    // options read advertised, each with the accelerators it carries.
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-egress"] input') as HTMLInputElement).click();
    });
    const offered = await selectOption(nodeSelect(), "worker-03 · nvidia / metax");
    expect(offered).toEqual(["不限(由调度器选择)", "worker-01 · nvidia", "worker-02", "worker-03 · nvidia / metax"]);

    await nextStep();
    expect(document.body.querySelector('[data-step="4"]')).not.toBeNull();
    // The confirmation step restates the section, so what is read on step 4 is
    // what a user would notice before submitting.
    expect(document.body.textContent).toContain("shared-models → /models");
    // The environment variable is restated with its value, not by name alone.
    expect(document.body.textContent).toContain("HF_HOME=/data/hf");
    // Both of this step's new choices, restated: the pin by the node's own name,
    // which is what the user picked.
    expect(document.body.textContent).toContain("worker-03");
    expect(document.body.textContent).toContain("不受限");

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
      // The node itself, not a label map: the route turns it into the
      // kubernetes.io/hostname pin.
      nodeName: "worker-03",
      egressUnrestricted: true,
    });

    act(() => root.unmount());
  });

  it("sends none of the advanced step's optional keys when it is untouched", async () => {
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
    // The node select opens on "any" and the egress switch on off, so neither
    // states anything: a pin the user did not make would be the wizard placing
    // the pod for them, and `unrestricted: false` would state a policy the CRD
    // already applies.
    expect("nodeName" in body).toBe(false);
    expect("egressUnrestricted" in body).toBe(false);

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

  it("sends spec.ssh with the pasted public keys when SSH is on", async () => {
    const { container, root } = renderWithBoth();
    await act(async () => {});
    await toStep3(container);

    // Turning on the SSH toggle exposes the public-key input (independent of the
    // environment's type); the route writes the pasted keys to an owned Secret.
    const sshSwitch = document.body.querySelector('[data-od-id="wizard-ssh"] input') as HTMLInputElement;
    await act(async () => {
      sshSwitch.click();
    });

    const keyArea = document.body.querySelector('[data-od-id="wizard-ssh-keys"] textarea') as HTMLTextAreaElement;
    expect(keyArea).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(keyArea, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAliceKey alice@laptop");
      keyArea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await nextStep();
    await act(async () => {
      (document.body.querySelector('[data-od-id="wizard-create"]') as HTMLElement).click();
    });
    await act(async () => {});

    const body = createdBody();
    expect(body).toMatchObject({
      sshEnabled: true,
      sshKeys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAliceKey alice@laptop",
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

    // 20Gi is the wizard's starting size, left untouched here: the claim is
    // provisioned at its full size up front, so the default is the smallest the
    // route accepts rather than the largest it allows.
    expect(createdBody()).toMatchObject({ storageGi: 20, pvcRetention: "retain" });

    act(() => root.unmount());
  });
});