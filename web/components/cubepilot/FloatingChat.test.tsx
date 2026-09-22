import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingChat } from "./FloatingChat";

// No JSX: the repo's tsconfig is Next's (jsx: preserve), which vitest's
// import analysis cannot transform. Same approach as the other component
// suites — createElement plus createRoot + act, asserting on the data-od-id
// contract the e2e suite also drives off, and on text.

const SESSION_KEY = "agent:main:conv-portal";

/** A turn that answers and finishes cleanly (terminal on the stream). */
const TURN_DONE = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "agent_thinking", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "集群状态良好。" },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "所有节点 Ready。" },
  { type: "message_done", sessionId: SESSION_KEY },
];

/** A turn that runs a tool, then parks on a write approval.
 *
 *  It carries NO terminal: a turn waiting on a human has not ended, so the
 *  real stream stays open until the card is resolved. The stub cannot hold a
 *  stream open, so the body simply ends and the client reports the stream as
 *  lost; either way the card stays answerable, which is what this suite is
 *  about. A trailing `message_done` would claim the turn was over while the
 *  write was still parked. */
const TURN_APPROVAL = [
  { type: "message_start", sessionId: SESSION_KEY },
  { type: "agent_thinking", sessionId: SESSION_KEY },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "正在检查 Ceph 状态…" },
  { type: "tool_call", sessionId: SESSION_KEY, callId: "call-1", name: "shell", arguments: { cmd: "ceph df" } },
  { type: "tool_result", sessionId: SESSION_KEY, callId: "call-1", name: "shell", output: "POOL USED: 71%" },
  { type: "message_delta", sessionId: SESSION_KEY, delta: "OSD 使用率 71%。" },
  {
    type: "approval_pending",
    sessionId: SESSION_KEY,
    callId: "app-1",
    name: "shell",
    command: "ceph osd set-noscrub",
    level: "write",
    message: "调整 OSD 参数属于写操作",
  },
];

/** Stub every endpoint the surface hits. `turn` is the SSE body of the first
 *  POST /messages (repeated for later ones). */
function stubApi(turn: object[]) {
  const messagePosts: Array<{ path: string; body: { content?: string; sessionId?: string } }> = [];
  const sse = (events: object[]) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
      if (url.includes("/api/cubepilot/agent/config"))
        return json({ config: { exists: true, selectedModel: "glm-5.2-chat", userInstructions: "" } });
      if (url.includes("/api/cubepilot/agent/status"))
        return json({ exists: true, id: "tester-cubepilot", phase: "Ready", user: "tester", message: "ready" });
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
      if (url.includes("/api/cubepilot/pilot/")) {
        const post = () => JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        if (url.endsWith("/approval/pending")) return json({ error: "no pending approval" }, 404);
        if (url.endsWith("/question/pending")) return json({ error: "no pending question" }, 404);
        if (url.endsWith("/messages")) {
          if (method === "POST") {
            messagePosts.push({ path: url, body: post() as { content?: string; sessionId?: string } });
            return sse(turn);
          }
          // No conversation for this stub user: the surface greets.
          return json({ error: "no such session" }, 404);
        }
        if (url.endsWith("/turn")) return json({ active: false });
        if (url.endsWith("/approval") && method === "POST") {
          const body = post();
          return json({ approved: body.decision !== "reject", decision: body.decision, approvalId: body.approvalId });
        }
        if (url.endsWith("/abort") && method === "POST") return json({ ok: true });
      }
      return json({});
    }),
  );
  return { messagePosts };
}

/** Poll `predicate` at act boundaries (one short act per tick) so streamed
 *  commits land, like the page suite does. */
async function waitFor(root: Root, predicate: () => boolean, tries = 120): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    if (predicate()) return true;
  }
  return predicate();
}

const roots: Root[] = [];

function renderChat() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(h(FloatingChat));
  });
  roots.push(root);
  return { container, root };
}

function setValue(el: HTMLTextAreaElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("floating chat (global AI assistant)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders the launcher only, closed, and restores nothing until opened", async () => {
    const fetches: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const { container, root } = renderChat();
    await act(async () => {});

    expect(container.querySelector('[data-od-id="fchat-fab"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="fchat-panel"]')).toBeNull();
    // The launcher is inert: opening the panel is what restores the session.
    expect(fetches).toHaveLength(0);
    act(() => root.unmount());
  });

  it("opens the panel and greets from the instance's real state", async () => {
    stubApi(TURN_DONE);
    const { container, root } = renderChat();
    await act(async () => {});

    const fab = container.querySelector('[data-od-id="fchat-fab"]') as HTMLElement;
    act(() => {
      fab.click();
    });

    // The greeting is data-driven: skills from the CRs, model from the CR.
    const greeted = await waitFor(root, () => {
      const text = container.textContent ?? "";
      return text.includes("技能 2 项") && text.includes("当前模型 glm-5.2-chat") && text.includes("会话审计已开启");
    });
    expect(greeted).toBe(true);
    expect(container.querySelector('[data-od-id="fchat-panel"]')).not.toBeNull();
    expect(fab.getAttribute("aria-expanded")).toBe("true");
    // The instance's phase under the title.
    expect(container.textContent).toContain("Ready");
    // The mockup's quick prompts, offered while the conversation is fresh.
    expect(container.querySelector('[data-od-id="fchat-quick"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("streams a turn on the fixed session key and settles it cleanly", async () => {
    const { messagePosts } = stubApi(TURN_DONE);
    const { container, root } = renderChat();
    await act(async () => {});
    act(() => {
      (container.querySelector('[data-od-id="fchat-fab"]') as HTMLElement).click();
    });
    await waitFor(root, () => (container.textContent ?? "").includes("会话审计已开启"));

    const input = container.querySelector('[data-od-id="fchat-input"]') as HTMLTextAreaElement;
    setValue(input, "集群状态如何?");
    act(() => {
      (container.querySelector('[data-od-id="fchat-send"]') as HTMLElement).click();
    });

    // The real SSE reply streams in; the turn ends on its terminal.
    const streamed = await waitFor(root, () => (container.textContent ?? "").includes("所有节点 Ready。"));
    expect(streamed).toBe(true);
    // The composer's placeholder is back to empty and the quick prompts are
    // gone: the conversation is no longer fresh.
    expect((container.querySelector('[data-od-id="fchat-input"]') as HTMLTextAreaElement).value).toBe("");
    expect(container.querySelector('[data-od-id="fchat-quick"]')).toBeNull();

    // The send named the ONE fixed conversation — the same key the chat tab
    // owns — not a session the API minted of its own.
    expect(messagePosts.length).toBe(1);
    expect(messagePosts[0].body.sessionId).toBe(SESSION_KEY);
    expect(messagePosts[0].body.content).toBe("集群状态如何?");
    act(() => root.unmount());
  });

  it("streams a turn, docks the approval it parks on, and settles it", async () => {
    stubApi(TURN_APPROVAL);
    const { container, root } = renderChat();
    await act(async () => {});
    act(() => {
      (container.querySelector('[data-od-id="fchat-fab"]') as HTMLElement).click();
    });
    await waitFor(root, () => (container.textContent ?? "").includes("会话审计已开启"));

    const input = container.querySelector('[data-od-id="fchat-input"]') as HTMLTextAreaElement;
    setValue(input, "分析 Ceph OSD 使用率告警");
    act(() => {
      (container.querySelector('[data-od-id="fchat-send"]') as HTMLElement).click();
    });

    // The SSE events land: accumulated text and the pending approval card with
    // its decision buttons, docked above the composer.
    const parked = await waitFor(root, () => (container.textContent ?? "").includes("写操作待审批"));
    expect(parked).toBe(true);
    expect(container.textContent).toContain("ceph osd set-noscrub");
    expect(container.querySelector('[data-od-id="hitl-dock"]')).not.toBeNull();
    expect(container.querySelector('[data-od-id="approval-approve"]')).not.toBeNull();
    // Allowlist policy (the stub's) offers the durable rule.
    expect(container.querySelector('[data-od-id="approval-allow"]')).not.toBeNull();

    // Approve the write op: the card flips to its resolved state.
    act(() => {
      (container.querySelector('[data-od-id="approval-approve"]') as HTMLElement).click();
    });
    const approved = await waitFor(root, () => (container.textContent ?? "").includes("已批准"));
    expect(approved).toBe(true);
    expect(container.querySelector('[data-od-id="approval-approve"]')).toBeNull();
    act(() => root.unmount());
  });

  it("sends a quick prompt from its chip", async () => {
    stubApi(TURN_DONE);
    const { container, root } = renderChat();
    await act(async () => {});
    act(() => {
      (container.querySelector('[data-od-id="fchat-fab"]') as HTMLElement).click();
    });
    const greeted = await waitFor(root, () => (container.textContent ?? "").includes("会话审计已开启"));
    expect(greeted).toBe(true);

    act(() => {
      (container.querySelector('[data-od-id="fchat-qp-1"]') as HTMLElement).click();
    });

    // The chip's text goes out as the user's own message…
    const sent = await waitFor(root, () => (container.textContent ?? "").includes("集群现在有哪些推理服务?状态如何?"));
    expect(sent).toBe(true);
    // …and the conversation is no longer fresh.
    expect(container.querySelector('[data-od-id="fchat-quick"]')).toBeNull();
    act(() => root.unmount());
  });

  it("closes from its own close button and restores the launcher state", async () => {
    stubApi(TURN_DONE);
    const { container, root } = renderChat();
    await act(async () => {});
    const fab = container.querySelector('[data-od-id="fchat-fab"]') as HTMLElement;
    act(() => {
      fab.click();
    });
    await waitFor(root, () => (container.textContent ?? "").includes("会话审计已开启"));
    expect(fab.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      (container.querySelector('[data-od-id="fchat-close"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-od-id="fchat-panel"]')).toBeNull();
    expect(fab.getAttribute("aria-expanded")).toBe("false");
    act(() => root.unmount());
  });
});
