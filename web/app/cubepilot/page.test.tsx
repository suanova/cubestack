import { createElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CubepilotPage from "./page";

// The test file avoids JSX because tsconfig sets jsx: "preserve" (for Next),
// which vitest's import-analysis can't transform.

/** Stub every endpoint the three panes fetch on mount + the agent flow.
 *  `opts.catalogUnavailable` fails the model catalog; `opts.stream` picks how the
 *  turn's SSE stream dies ("error" mid-read, "stall" silent and open);
 *  `opts.activePolls` bounds how long /turn reports a run; `opts.transcript` is
 *  the runtime's copy of the conversation, `opts.attach` serves the re-attach
 *  stream a following pane opens for a parked run. */
function stubApi(
  config?: Record<string, unknown>,
  opts: {
    catalogUnavailable?: boolean;
    stream?: "end" | "error" | "stall";
    activePolls?: number;
    transcript?: Array<{ role: string; content: string }>;
    attach?: { events?: unknown[]; emit?: (ev: unknown) => void; calls?: number };
  } = {},
) {
  let turnPolls = 0;
  let sent = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes("/api/cubepilot/tasktemplates"))
        return json({ taskTemplates: [] });
      if (url.includes("/api/cubepilot/tasks")) return json({ tasks: [], reports: [] });
      if (url.includes("/api/cubepilot/agent/config"))
        return json({
          config: config ?? {
            exists: true,
            selectedModel: "glm-5.2-chat",
            userInstructions: "演示提示词",
            // The AgentTemplate's inlined catalog (the config page's model list).
            models: [{ name: "glm-5.2-chat", endpoint: "http://gw.test:8080" }],
          },
        });
      if (url.includes("/api/cubepilot/agent/status"))
        return json({
          exists: true,
          id: "tester-cubepilot",
          phase: "Ready",
          startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
          uptimeSeconds: 3600,
          user: "tester",
          message: "ready",
          podName: "cubepilot-tester-abc12",
          pvcName: "pvc-tester",
        });
      if (url.includes("/api/cubepilot/agent/confirm"))
        return json({
          exists: true,
          confirmPolicy: "Allowlist",
          templatePolicy: "Allowlist",
          override: "",
          allowlist: [],
          channel: "unknown",
        });
      if (url.includes("/api/cubepilot/skills"))
        return json({
          skills: [
            { name: "cluster-inspect", displayName: "集群巡检", description: "巡检", enabled: true },
            { name: "gpu-health", displayName: "GPU 体检", description: "GPU", enabled: true },
          ],
        });
      // A session sub-resource is decided by its tail, and the turn stream is
      // matched first: the send and the transcript read are the SAME path, and
      // only the method tells them apart.
      if (url.endsWith("/messages") && method === "POST") {
        sent = true;
        // The agent turn: real SSE events (the client accumulates deltas,
        // pairs the tool result by callId, and renders the HITL card).
        //
        // The turn ends on the approval, with no terminal: a turn parked on a
        // human has not ended, so the stream stays open (the stub cannot, so it
        // just ends) and the card stays answerable. A `message_done` here would
        // say the turn was over while the write was still parked, and a turn
        // that really ends settles its parked cards.
        const events = opts.stream
          ? [
              // A plain turn that narrates and then loses its link, before any
              // terminal event: what the runtime's transcript has to answer for.
              { type: "message_start", sessionId: "agent:main:conv-portal" },
              { type: "message_delta", sessionId: "agent:main:conv-portal", delta: "正在查 demo 的 DevEnvironment…" },
            ]
          : [
              { type: "message_start", sessionId: "agent:main:conv-1" },
              { type: "agent_thinking", sessionId: "agent:main:conv-1" },
              { type: "message_delta", sessionId: "agent:main:conv-1", delta: "正在检查 Ceph 状态…" },
              { type: "tool_call", sessionId: "agent:main:conv-1", callId: "call-1", name: "shell", arguments: { cmd: "ceph df" } },
              { type: "tool_result", sessionId: "agent:main:conv-1", callId: "call-1", output: "POOL USED: 71%" },
              { type: "message_delta", sessionId: "agent:main:conv-1", delta: "OSD 使用率 71%。" },
              { type: "approval_pending", sessionId: "agent:main:conv-1", callId: "app-1", name: "shell", command: "ceph osd set-noscrub", level: "write" },
            ];
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            if (opts.stream === "error") controller.error(new TypeError("network error"));
            else if (opts.stream !== "stall") controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      // The re-attach stream: what a following pane opens for a parked run once
      // its own stream is gone. `emit` lets the test push the events a real
      // runtime would (a new card, a resolution).
      if (url.endsWith("/turn/events") && opts.attach) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const e of opts.attach?.events ?? []) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            if (opts.attach) opts.attach.emit = (ev: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.endsWith("/turn") && opts.activePolls !== undefined) {
        // A turn is only running once one has been sent: before that the pane is
        // looking at a conversation that is idle, and a stub that said otherwise
        // would have the composer offering Stop on an empty thread.
        if (!sent) return json({ active: false });
        turnPolls += 1;
        return json({ active: turnPolls <= opts.activePolls });
      }
      if (url.endsWith("/messages") && opts.transcript) return json({ items: opts.transcript });
      if (url.endsWith("/approvals/decision"))
        return json({ approved: true, decision: "approve", approvalId: "app-1" });
      if (url.endsWith("/questions/answer")) return json({ questionId: "ask-1", cancelled: false });
      if (url.endsWith("/questions/cancel")) return json({ questionId: "ask-1", cancelled: true });
      // The two restore collections, and the empty list IS the answer for a
      // session with nothing parked.
      if (url.endsWith("/approvals")) return json({ approvals: [] });
      if (url.endsWith("/questions")) return json({ questions: [] });
      // Everything else under a session: the list is empty for a fresh user (the
      // greeting, not a restore), and `items` covers the transcript read.
      if (url.includes("/api/cubepilot/pilot/api/v1/sessions")) return json({ sessions: [], items: [] });
      if (url.includes("/api/cubepilot/playground/services")) {
        if (opts.catalogUnavailable) {
          return {
            ok: false,
            status: 502,
            json: async () => ({ models: [], endpoint: null, error: "model catalog unavailable" }),
          };
        }
        return json({
          models: [{ id: "glm-5.2-chat", ownedBy: "cubestack" }],
          endpoint: "http://gw.test:8080",
        });
      }
      if (url.includes("/api/cubepilot/playground/chat")) {
        // Real streaming: SSE chunks (the client accumulates the deltas).
        const FULL = "好的,已收到。这是来自真实 AI Gateway 的流式回复。";
        let i = 0;
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const tick = () => {
              if (i < FULL.length) {
                const chunk = FULL.slice(i, i + 5);
                i += 5;
                controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`));
                setTimeout(tick, 15);
              } else {
                controller.enqueue(enc.encode("data: [DONE]\n\n"));
                controller.close();
              }
            };
            tick();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return json({});
    }),
  );
}

describe("cubepilot page", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stubApi();
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
      root.render(createElement(CubepilotPage));
    });
    return { container, root };
  }

  /** Type into the composer and send — the path a reader takes. */
  async function sendTurn(container: HTMLElement, text: string): Promise<void> {
    const input = container.querySelector('[data-od-id="chat-input"]') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      (container.querySelector('[data-od-id="send-btn"]') as HTMLElement).click();
    });
    await act(async () => {});
  }

  /** Advance the clock in act() until `predicate` holds. The turn's own
   *  machinery runs on timers (the follow loop polls every few seconds), so the
   *  tests drive time rather than racing it. */
  async function waitFor(predicate: () => boolean, ticks = 400): Promise<boolean> {
    for (let i = 0; i < ticks && !predicate(); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    return predicate();
  }

  it("renders the page head and the three tabs", async () => {
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="page-head"]')).not.toBeNull();
    expect(container.textContent).toContain("智能助手");
    expect(container.textContent).toContain("聊天");
    expect(container.textContent).toContain("自动化任务");
    expect(container.textContent).toContain("配置");
    expect(container.querySelector('[data-od-id="cp-tab-playground"]')).toBeNull();
    expect(container.querySelector('[data-od-id="cubepilot-tabs"]')).not.toBeNull();
    act(() => root.unmount());
  });

  // An install with no platform model service is a supported shape: the page
  // offers the assistant and leaves the model group out, announcing nothing. The
  // reason a catalog is missing (a gateway that was never installed, a name that
  // does not resolve) is an internal detail the reader can neither act on nor be
  // shown — it used to arrive as "Operation failed: Error: TypeError: fetch
  // failed" on a page whose assistant worked fine.
  it("offers the assistant alone when no model service is available", async () => {
    stubApi(undefined, { catalogUnavailable: true });
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="obj-cubepilot"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="obj-glm-5.2-chat"]')).toBeNull();
    // The group label goes with the list — asserting on the text would match the
    // page subtitle, which names the group in prose.
    expect(container.querySelector('[data-od-id="objects-models"]')).toBeNull();
    expect(document.body.textContent).not.toContain("操作失败");
    expect(document.body.textContent).not.toContain("fetch failed");
    act(() => root.unmount());
  });

  it("keeps all three panes mounted and defaults to chat", async () => {
    const { container, root } = renderPage();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="pane-chat"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="pane-tasks"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="pane-config"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="pane-playground"]')).toBeNull();

    const chat = container.querySelector('[data-od-id="cp-tab-chat"]') as HTMLElement;
    const tasks = container.querySelector('[data-od-id="cp-tab-tasks"]') as HTMLElement;
    const config = container.querySelector('[data-od-id="cp-tab-config"]') as HTMLElement;
    expect(chat.getAttribute("aria-selected")).toBe("true");
    expect(tasks.getAttribute("aria-selected")).toBe("false");
    expect(config.getAttribute("aria-selected")).toBe("false");
    act(() => root.unmount());
  });

  it("renders each tab as a focusable button wired to its pane", async () => {
    const { container, root } = renderPage();
    await act(async () => {});

    for (const id of ["chat", "tasks", "config"]) {
      const tab = container.querySelector(`[data-od-id="cp-tab-${id}"]`) as HTMLButtonElement;
      // A div with role="tab" is neither focusable nor keyboard-activatable.
      expect(tab.tagName).toBe("BUTTON");
      expect(tab.type).toBe("button");
      expect(tab.id).toBe(`tab-${id}`);
      expect(tab.getAttribute("aria-controls")).toBe(`pane-${id}`);
      expect(container.querySelector(`#pane-${id}`)?.getAttribute("aria-labelledby")).toBe(`tab-${id}`);
    }
    act(() => root.unmount());
  });

  it("switches tabs and persists the selection", async () => {
    const { container, root } = renderPage();
    await act(async () => {});

    const tasks = container.querySelector('[data-od-id="cp-tab-tasks"]') as HTMLElement;
    act(() => {
      tasks.click();
    });
    expect(tasks.getAttribute("aria-selected")).toBe("true");
    expect((container.querySelector('[data-od-id="cp-tab-chat"]') as HTMLElement).getAttribute("aria-selected")).toBe("false");
    expect(localStorage.getItem("cubestack.cubepilot.tab")).toBe("tasks");
    act(() => root.unmount());
  });

  it("selects the first model and streams a reply with the sampling params collapsed in the composer", async () => {
    const { container, root } = renderPage();
    await act(async () => {});

    // The page OPENS on the assistant, so the model side is reached by picking
    // a model — what this test is about. (The default itself is asserted in the
    // e2e suite, `opens on the assistant, not on a model`.)
    expect(
      (container.querySelector('[data-od-id="obj-cubepilot"]') as HTMLElement).getAttribute("aria-pressed"),
    ).toBe("true");
    act(() => {
      (container.querySelector('[data-od-id="obj-glm-5.2-chat"]') as HTMLElement).click();
    });
    await act(async () => {});
    expect(
      (container.querySelector('[data-od-id="obj-glm-5.2-chat"]') as HTMLElement).getAttribute("aria-pressed"),
    ).toBe("true");
    // Sampling params collapse into a chip in the composer by default.
    expect(container.querySelector('[data-od-id="params-chip"]')).not.toBeNull();
    expect(document.body.querySelector('[data-od-id="params-card"]')).toBeNull();
    // The chip opens the params panel in a popover (a body portal).
    act(() => {
      (container.querySelector('[data-od-id="params-chip"]') as HTMLElement).click();
    });
    expect(document.body.querySelector('[data-od-id="params-card"]')).not.toBeNull();
    // No fake metrics card.
    expect(container.querySelector('[data-od-id="metrics-card"]')).toBeNull();
    expect(container.querySelector('[data-od-id="api-card"]')).toBeNull();
    expect(container.querySelector('[data-od-id="pg-endpoint"]')?.textContent).toContain("/v1/chat/completions");
    // The object meta line shows the gateway owner.
    expect(container.textContent).toContain("cubestack");
    expect(container.textContent).toContain("已切换到 glm-5.2-chat");

    // Send a message through the composer (native setter so React's
    // controlled onChange fires).
    const input = container.querySelector('[data-od-id="chat-input"]') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "你好");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = container.querySelector('[data-od-id="send-btn"]') as HTMLElement;
    act(() => {
      send.click();
    });

    // The real SSE reply streams in; React commits the updates at act
    // boundaries, so poll with one short act per tick instead of one long act.
    const FULL = "好的,已收到。这是来自真实 AI Gateway 的流式回复。";
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const text = container.textContent ?? "";
      done = text.includes(FULL) && /生成 \d+ 字符/.test(text);
    }
    expect(done).toBe(true);
    expect(container.querySelector('[data-od-id="pg-streaming"]')).toBeNull();
    act(() => root.unmount());
  }, 10000);

  it("switches to the agent: data greeting, SSE turn with an approval card", async () => {
    const { container, root } = renderPage();
    await act(async () => {});

    // Select the CubePilot agent object.
    const agentObj = container.querySelector('[data-od-id="obj-cubepilot"]') as HTMLElement;
    act(() => {
      agentObj.click();
    });

    // No context rail in agent mode: the chat card owns the full width and
    // the instance state lives in the card header.
    expect(container.querySelector('[data-od-id="agent-status-card"]')).toBeNull();
    expect(container.querySelector('[data-od-id="allowlist-card"]')).toBeNull();
    expect(container.querySelector('[data-od-id="tool-whitelist-card"]')).toBeNull();
    expect(container.querySelector('[data-od-id="approval-card"]')).toBeNull();
    // Agent mode has no sampling-params chip (model-side control).
    expect(container.querySelector('[data-od-id="params-chip"]')).toBeNull();

    // The greeting is data-driven (skills from the CRs, model from the CR)
    // because the stub user has no sessions yet.
    let greeted = false;
    for (let i = 0; i < 100 && !greeted; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      greeted =
        (container.textContent ?? "").includes("技能 2 项") &&
        (container.textContent ?? "").includes("当前模型 glm-5.2-chat") &&
        (container.textContent ?? "").includes("会话审计已开启");
    }
    expect(greeted).toBe(true);

    // Composer → a real turn streams through the pilot proxy.
    const input = container.querySelector('[data-od-id="chat-input"]') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "分析 Ceph OSD 使用率告警");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      (container.querySelector('[data-od-id="send-btn"]') as HTMLElement).click();
    });

    // The SSE events land: accumulated text, the paired tool result, and
    // the pending approval card with its decision buttons.
    let turnDone = false;
    for (let i = 0; i < 100 && !turnDone; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const text = container.textContent ?? "";
      turnDone =
        text.includes("正在检查 Ceph 状态…") &&
        text.includes("OSD 使用率 71%。") &&
        text.includes("ceph osd set-noscrub") &&
        text.includes("写操作待审批");
    }
    expect(turnDone).toBe(true);
    expect(container.querySelector('[data-od-id="approval-approve"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="stop-btn"]')).toBeNull();

    // The tool card rests collapsed once its call has returned, so what it
    // produced is one click away — which is the point of the card. The e2e
    // suite drives the same click on the same card.
    act(() => {
      (container.querySelector('[data-od-id="tool-card-head"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-od-id="tool-output"]')?.textContent).toContain("POOL USED: 71%");

    // Approve the write op: the card flips to its resolved state.
    const approve = container.querySelector('[data-od-id="approval-approve"]') as HTMLElement;
    act(() => {
      approve.click();
    });
    let approved = false;
    for (let i = 0; i < 50 && !approved; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      approved = (container.textContent ?? "").includes("已批准");
    }
    expect(approved).toBe(true);
    expect(container.querySelector('[data-od-id="approval-approve"]')).toBeNull();

    // Back to the model: the sampling-params chip is back in the composer
    // and the thread resets.
    const modelObj = container.querySelector('[data-od-id="obj-glm-5.2-chat"]') as HTMLElement;
    act(() => {
      modelObj.click();
    });
    await act(async () => {});
    expect(container.querySelector('[data-od-id="params-chip"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="tool-whitelist-card"]')).toBeNull();
    expect(container.textContent).toContain("已切换到 glm-5.2-chat");
    act(() => root.unmount());
  }, 15000);

  // The transport a pane watches a turn with can die under it — a dropped link,
  // a pod that goes away, a proxy that gives up. That is not the turn's own
  // failure: the run may still be executing, and the only thing that can say
  // what it did is the runtime's transcript. This used to print the browser's
  // own words ("network error") on the bubble and freeze the turn where it
  // stood, until a reload re-read the conversation.
  it("a broken turn stream reads as a lost connection, and the run is taken from the server", async () => {
    stubApi(undefined, {
      stream: "error",
      activePolls: 1,
      transcript: [
        { role: "user", content: "查一下 demo 的 DevEnvironment" },
        { role: "assistant", content: "demo 下共 5 个 DevEnvironment,全部 Running。" },
      ],
    });
    const { container, root } = renderPage();
    await act(async () => {});
    act(() => {
      (container.querySelector('[data-od-id="obj-cubepilot"]') as HTMLElement).click();
    });
    await act(async () => {});

    await sendTurn(container, "查一下 demo 的 DevEnvironment");

    // The link dies. The bubble names the transport in the platform's own words
    // — the browser's error is diagnostics, not something to show a reader.
    expect(await waitFor(() => (container.textContent ?? "").includes("连接中断"))).toBe(true);
    expect(container.textContent ?? "").not.toContain("network error");

    // The run is over, so the pane converges on the server's copy: the answer
    // the stream never delivered is on screen without a reload.
    expect(await waitFor(() => (container.textContent ?? "").includes("全部 Running"))).toBe(true);
    act(() => root.unmount());
  }, 30000);

  // A link that goes silent without closing — a half-open connection, what a
  // dropped tunnel or a dead NAT entry leaves behind — is the same event as one
  // that breaks, and it is the one a reader sees as a page stuck on
  // "正在汇总工具结果…" with a ticking timer while the run has long finished.
  it("a turn whose stream goes silent converges on the server once the run is over", async () => {
    stubApi(undefined, {
      stream: "stall",
      activePolls: 1,
      transcript: [
        { role: "user", content: "查一下 demo 的 DevEnvironment" },
        { role: "assistant", content: "demo 下共 5 个 DevEnvironment,全部 Running。" },
      ],
    });
    const { container, root } = renderPage();
    await act(async () => {});
    act(() => {
      (container.querySelector('[data-od-id="obj-cubepilot"]') as HTMLElement).click();
    });
    await act(async () => {});

    await sendTurn(container, "查一下 demo 的 DevEnvironment");
    // The events that made it through are on screen, and the turn reads as live.
    expect(await waitFor(() => (container.textContent ?? "").includes("正在查 demo 的 DevEnvironment…"))).toBe(true);

    expect(await waitFor(() => (container.textContent ?? "").includes("全部 Running"))).toBe(true);
    // Nothing is left claiming the turn is still running.
    expect(container.textContent ?? "").not.toContain("仍在运行");
    act(() => root.unmount());
  }, 30000);

  // The run's events — "a write needs your decision" among them — are written
  // only to the stream the send opened, so a pane that lost that stream never
  // hears about a card raised afterwards (the runtime logs "no open stream for
  // session …; push dropped"). The API's re-attach route is what makes such a
  // card appear, and stay answerable, in place.
  it("a parked turn recovers its card by re-attaching to the run", async () => {
    const attach: { events?: unknown[]; emit?: (ev: unknown) => void } = {
      events: [
        {
          type: "approval_pending",
          sessionId: "agent:main:conv-portal",
          callId: "app-9",
          name: "shell",
          command: "kubectl delete pod demo-env-0",
          level: "write",
        },
      ],
    };
    stubApi(undefined, { stream: "error", activePolls: 999, attach });
    const { container, root } = renderPage();
    await act(async () => {});
    act(() => {
      (container.querySelector('[data-od-id="obj-cubepilot"]') as HTMLElement).click();
    });
    await act(async () => {});

    await sendTurn(container, "清理掉那个开发环境");
    expect(await waitFor(() => container.querySelector('[data-od-id="approval-approve"]') !== null)).toBe(true);
    expect(container.textContent ?? "").toContain("kubectl delete pod demo-env-0");

    // The decision taken elsewhere arrives on the same stream and settles the
    // card here: a re-attached view is a live one, not a snapshot.
    act(() => {
      attach.emit?.({ type: "approval_resolved", sessionId: "agent:main:conv-portal", callId: "app-9", approved: true });
    });
    expect(await waitFor(() => (container.textContent ?? "").includes("已批准"))).toBe(true);
    expect(container.querySelector('[data-od-id="approval-approve"]')).toBeNull();
    act(() => root.unmount());
  }, 30000);

  it("resizes the object list column by dragging the pane resizer", async () => {
    const { container, root } = renderPage();
    await act(async () => {});

    const resizer = container.querySelector('[data-od-id="pane-resizer"]') as HTMLElement;
    expect(resizer).not.toBeNull();
    expect(resizer.getAttribute("role")).toBe("separator");
    expect(resizer.getAttribute("aria-valuenow")).toBe("157");

    const drag = (fromX: number, toX: number): void => {
      act(() => {
        resizer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: fromX }));
      });
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: toX }));
        window.dispatchEvent(new PointerEvent("pointerup"));
      });
    };

    // Dragging 100px right widens the column by 100px.
    drag(200, 300);
    expect(resizer.getAttribute("aria-valuenow")).toBe("257");

    // Drags beyond the bounds clamp to the min/max.
    drag(200, 5000);
    expect(resizer.getAttribute("aria-valuenow")).toBe("460");
    drag(200, -5000);
    expect(resizer.getAttribute("aria-valuenow")).toBe("120");
    act(() => root.unmount());
  });

  it("shows the platform model without its internal alias, external providers with their name", async () => {
    stubApi({
      exists: true,
      selectedModel: "cubestack/qwen38-27b",
      userInstructions: "",
      providers: [
        { name: "cubestack", endpoint: "http://gw.test:8080/v1", models: ["qwen38-27b"], origin: "system" },
        { name: "deepseek", endpoint: "https://api.deepseek.com/v1", models: ["deepseek-chat"], keyed: true, origin: "external" },
      ],
      gatewayModels: ["qwen38-27b", "deepseek-v4-flash"],
    });
    const { container, root } = renderPage();
    await act(async () => {});

    // "cubestack/" is internal plumbing the user never chose.
    const model = container.querySelector('[data-od-id="cp-config-model-select"]') as HTMLSelectElement;
    expect(model.disabled).toBe(false);
    expect(model.textContent).toContain("qwen38-27b");
    expect(model.textContent).not.toContain("cubestack/");
    // One option per model the TEMPLATE'S PROVIDERS declare, valued as the ref
    // the CR stores — the external provider's included. (The gateway serves
    // "deepseek-v4-flash" as well, but no provider declares it, so it is not a
    // choice: the providers are the catalog.)
    expect(model.options.length).toBe(2);
    expect(Array.from(model.options).map((o) => o.value)).toEqual(["cubestack/qwen38-27b", "deepseek/deepseek-chat"]);

    const external = container.querySelector('[data-od-id="cp-config-llm-src-external"]') as HTMLElement;
    act(() => external.click());
    const row = container.querySelector('[data-od-id="cp-config-llm-row"]') as HTMLElement;
    // The provider key is the ref prefix, so the row reads provider/modelId.
    expect(row.textContent).toContain("deepseek");
    expect(row.textContent).toContain("deepseek/deepseek-chat");
    act(() => root.unmount());
  });

  it("restores the persisted tab on mount", async () => {
    localStorage.setItem("cubestack.cubepilot.tab", "config");
    const { container, root } = renderPage();
    await act(async () => {});

    expect((container.querySelector('[data-od-id="cp-tab-config"]') as HTMLElement).getAttribute("aria-selected")).toBe("true");
    act(() => root.unmount());
  });

  // Regression: the page is statically prerendered (server has no
  // localStorage, so the built HTML always ships the default chat tab).
  // Hydration must not leave that stale DOM in place when the user's stored
  // tab differs — the tab store's post-hydration re-render has to swap the
  // selected tab and the visible pane to the stored value.
  it("restores the persisted tab when hydrating prerendered HTML", async () => {
    const serverHtml = renderToString(createElement(CubepilotPage));
    // Sanity: the prerender really shows the default chat tab.
    const chatTab = serverHtml.indexOf('data-od-id="cp-tab-chat"');
    expect(chatTab).toBeGreaterThan(-1);
    expect(serverHtml.slice(chatTab - 160, chatTab)).toContain('aria-selected="true"');
    const tasksPane = serverHtml.indexOf('data-od-id="pane-tasks"');
    expect(tasksPane).toBeGreaterThan(-1);
    expect(serverHtml.slice(tasksPane - 80, tasksPane)).toContain("hidden");

    localStorage.setItem("cubestack.cubepilot.tab", "tasks");

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const root = hydrateRoot(container, createElement(CubepilotPage));
    await act(async () => {});

    expect((container.querySelector('[data-od-id="cp-tab-tasks"]') as HTMLElement).getAttribute("aria-selected")).toBe("true");
    expect((container.querySelector('[data-od-id="cp-tab-chat"]') as HTMLElement).getAttribute("aria-selected")).toBe("false");
    expect((container.querySelector('[data-od-id="pane-tasks"]') as HTMLElement).hasAttribute("hidden")).toBe(false);
    expect((container.querySelector('[data-od-id="pane-chat"]') as HTMLElement).hasAttribute("hidden")).toBe(true);
    act(() => root.unmount());
  });
});
