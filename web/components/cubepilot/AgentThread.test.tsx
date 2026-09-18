import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentBlock, AgentMsg, ThreadMsg } from "@/lib/cubepilot/agentThread";

import { AgentThread } from "./AgentThread";

// This file cannot use JSX: the repo's tsconfig is Next's, and vitest's import
// analysis cannot transform JSX. Same approach as app/cubepilot/page.test.tsx —
// createElement (aliased to `h`) plus createRoot + act. There is deliberately no
// @testing-library/react here.
//
// jsdom does no layout, so every assertion below is structure, attributes or
// text: `aria-expanded`, the `data-od-*` contract the e2e suite also drives off,
// and textContent. Nothing asserts a size or a colour.

type ToolBlock = Extract<AgentBlock, { kind: "tool" }>;

const S1 = "agent:main:conv-1";
const S2 = "agent:main:conv-2";

/** A settled agent turn; a case overrides only what it is about. */
function agentMsg(id: number, blocks: AgentBlock[], over: Partial<AgentMsg> = {}): AgentMsg {
  return { id, role: "agent", blocks, approvals: [], questions: [], phase: "done", phaseAt: 0, ...over };
}

function text(t: string, superseded?: string[]): AgentBlock {
  return { kind: "text", text: t, ...(superseded ? { superseded } : {}) };
}

/** A tool call that has already returned — the resting, collapsed state. Pass
 *  `{ done: false, output: undefined }` for one still in flight. */
function tool(over: Partial<ToolBlock> = {}): ToolBlock {
  return { kind: "tool", callId: "call-1", name: "shell", args: "ceph df", output: "POOL USED: 71%", done: true, ...over };
}

function view(msgs: ThreadMsg[], sessionKey: string | null) {
  return h(AgentThread, { msgs, sessionKey, now: 0 });
}

const roots: Root[] = [];

function render(msgs: ThreadMsg[], sessionKey: string | null): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(view(msgs, sessionKey));
  });
  roots.push(root);
  return { container, root };
}

function rerender(root: Root, msgs: ThreadMsg[], sessionKey: string | null): void {
  act(() => {
    root.render(view(msgs, sessionKey));
  });
}

const blockKinds = (container: HTMLElement): (string | null)[] =>
  Array.from(container.querySelectorAll("[data-od-block]")).map((el) => el.getAttribute("data-od-block"));

const cardHead = (container: HTMLElement): HTMLElement =>
  container.querySelector('[data-od-id="tool-card-head"]') as HTMLElement;

const expanded = (container: HTMLElement): string | null => cardHead(container).getAttribute("aria-expanded");

/** The tool card's output box. Present only while the card is open, so it also
 *  answers "is this card expanded" for the cases that need the body, not just
 *  the head. */
const output = (container: HTMLElement): Element | null => container.querySelector('[data-od-id="tool-output"]');

describe("AgentThread", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cubestack-locale", "zh-CN");
    document.documentElement.dataset.locale = "zh-CN";
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders a turn's blocks in array order, not grouped by kind", () => {
    const { container } = render([agentMsg(1, [text("先查一下。"), tool(), text("使用率 71%。")])], S1);

    // Three blocks in the order they arrived — the ordering bug this component
    // exists to fix rendered both texts as one blob above the tool.
    expect(blockKinds(container)).toEqual(["text", "tool", "text"]);
    const blocks = Array.from(container.querySelectorAll("[data-od-block]"));
    expect(blocks[0].textContent).toContain("先查一下。");
    // The card is closed (the tool returned), so its command and output are not
    // in the DOM — the head carries the tool's name.
    expect(blocks[1].textContent).toContain("shell");
    expect(blocks[2].textContent).toContain("使用率 71%。");
  });

  it("derives a card's resting state: open while in flight, closed once it returns or the turn ends", () => {
    // In flight: open, so the command it is running is visible even though
    // nothing has come back yet.
    const running = render([agentMsg(1, [text("查一下。"), tool({ done: false, output: undefined })], { phase: "tools" })], S1);
    expect(expanded(running.container)).toBe("true");
    expect(running.container.querySelector("pre")?.textContent).toContain("ceph df");
    expect(output(running.container)).toBeNull();

    // Returned: closed.
    const returned = render([agentMsg(1, [text("查一下。"), tool()], { phase: "tools" })], S1);
    expect(expanded(returned.container)).toBe("false");
    expect(output(returned.container)).toBeNull();

    // The turn is over but this tool never returned — stopped, not running.
    const abandoned = render([agentMsg(1, [text("查一下。"), tool({ done: false, output: undefined })], { phase: "done" })], S1);
    expect(expanded(abandoned.container)).toBe("false");
    expect(output(abandoned.container)).toBeNull();
  });

  it("remembers the reader's own choice, scoped to the session", () => {
    const msgs = [agentMsg(1, [tool()])];
    const { container, root } = render(msgs, S1);
    expect(expanded(container)).toBe("false");

    // Opening it is the reader's choice, so it survives further renders.
    act(() => cardHead(container).click());
    expect(expanded(container)).toBe("true");
    expect(output(container)).not.toBeNull();
    rerender(root, msgs, S1);
    expect(expanded(container)).toBe("true");

    // The same call id in another session is another card. Call ids are only
    // unique within a session, which is the whole reason the key carries one:
    // without it, opening `kubectl_get` here would open it there.
    rerender(root, msgs, S2);
    expect(expanded(container)).toBe("false");
    expect(output(container)).toBeNull();

    // Back in the session that opened it, the choice is still there.
    rerender(root, msgs, S1);
    expect(expanded(container)).toBe("true");
    expect(output(container)).not.toBeNull();
  });

  it("labels the closing panel by how the turn ended", () => {
    const blocks = [text("先查一下。"), tool(), text("使用率 71%。")];

    const mid = render([agentMsg(1, blocks, { phase: "streaming" })], S1);
    expect(mid.container.textContent).toContain("回复");
    expect(mid.container.textContent).not.toContain("最终结果");

    const done = render([agentMsg(1, blocks)], S1);
    expect(done.container.textContent).toContain("最终结果");
    expect(done.container.textContent).not.toContain("回复");

    // A lost transport is not a turn outcome: the run may still be executing.
    const lost = render([agentMsg(1, blocks, { transportLost: "stream ended" })], S1);
    expect(lost.container.textContent).toContain("回复");
    expect(lost.container.textContent).not.toContain("最终结果");

    const stopped = render([agentMsg(1, blocks, { stopped: true })], S1);
    expect(stopped.container.textContent).toContain("回复");
    expect(stopped.container.textContent).not.toContain("最终结果");
  });

  it("does not call a turn's opening text the result when the turn ends with a tool", () => {
    // The `historyToMsgs` shape: an assistant bubble restored as [text, tool].
    const { container } = render([agentMsg(1, [text("先查一下。"), tool()])], S1);

    expect(container.textContent).toContain("先查一下。");
    // The panel needs the turn to END with text; ending with a tool means there
    // is no closing text to panel, and no label of either kind.
    expect(container.textContent).not.toContain("最终结果");
    expect(container.textContent).not.toContain("回复");
  });

  it("keeps the text a rewrite displaced in a disclosure, before the text that replaced it", () => {
    const { container } = render([agentMsg(1, [text("使用率 71%。", ["刚才是 68%。", "更早是 64%。"])])], S1);

    const details = container.querySelector('[data-od-id="superseded"]');
    expect(details).not.toBeNull();
    expect(details?.tagName).toBe("DETAILS");
    expect(details?.textContent).toContain("更早的内容 (2)");
    expect(details?.textContent).toContain("刚才是 68%。");
    expect(details?.textContent).toContain("更早是 64%。");

    const all = container.textContent ?? "";
    expect(all.indexOf("刚才是 68%。")).toBeLessThan(all.indexOf("使用率 71%。"));

    // No rewrite, no disclosure.
    const { container: plain } = render([agentMsg(1, [text("使用率 71%。")])], S1);
    expect(plain.querySelector('[data-od-id="superseded"]')).toBeNull();
  });

  it("parses the agent's Markdown: fenced blocks, nesting, and single-newline breaks", () => {
    const md = "可以这样查:\n\n```sh\nkubectl get pods -A\n```\n\n**加粗里带 `code`**\n\n第一行\n第二行";
    const { container } = render([agentMsg(1, [text(md)])], S1);

    // A fence becomes a real code element, not literal backticks.
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("kubectl get pods -A");
    expect(container.textContent).not.toContain("```");

    // `**bold with `code` inside**` — the nesting the hand-rolled parser in
    // Markdown.tsx splits wrongly, and ordinary LLM output.
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("加粗里带 code");
    expect(strong?.querySelector("code")).not.toBeNull();

    // remark-breaks: one newline is a break, not a space, so both lines stay in
    // one paragraph with a <br> between them.
    const br = container.querySelector("br");
    expect(br).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll("p")).some(
        (p) => (p.textContent ?? "").includes("第一行") && (p.textContent ?? "").includes("第二行"),
      ),
    ).toBe(true);
  });

  it("explains a turn that failed with its own error, on the bubble", () => {
    const { container } = render([agentMsg(1, [text("查了一半。")], { error: "gateway 502" })], S1);

    const line = container.querySelector('[data-od-id="agent-error"]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("gateway 502");

    // An ordinary reply must not sprout a line saying it ended: the bubble
    // carries only what is not simply "it ended".
    const { container: clean } = render([agentMsg(1, [text("好了。")])], S1);
    expect(clean.querySelector('[data-od-id="agent-error"]')).toBeNull();
  });

  it("reports a lost stream as a transport failure, with the stream's reason under it", () => {
    const { container } = render(
      [agentMsg(1, [text("查了一半。")], { transportLost: "连接中断,本轮输出可能不完整。" })],
      S1,
    );

    const box = container.querySelector('[data-od-id="agent-lost"]');
    expect(box).not.toBeNull();
    // The headline is the transport status, and the reason is kept beneath it as
    // diagnostics — the run may still be executing, so neither is painted as the
    // turn's own failure.
    expect(box?.textContent).toContain("连接已断开");
    expect(box?.textContent).toContain("本轮输出可能不完整");
    expect(container.querySelector('[data-od-id="agent-error"]')).toBeNull();
  });

  it("marks a stopped turn without calling it a failure", () => {
    const { container } = render([agentMsg(1, [text("到此为止。")], { stopped: true })], S1);

    const line = container.querySelector('[data-od-id="agent-stopped"]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("已停止");
    expect(container.querySelector('[data-od-id="agent-error"]')).toBeNull();
  });

  it("shows the thinking indicator while the turn has nothing to show yet", () => {
    const { container } = render([agentMsg(1, [], { phase: "thinking" })], S1);

    const line = container.querySelector('[data-od-id="agent-thinking"]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain("正在处理你的请求");

    // It stands in for the empty bubble, not for a running turn: a turn with no
    // blocks that has ENDED must not claim to be thinking. Whether a turn is
    // still going is the header's status line, not this.
    const { container: ended } = render([agentMsg(1, [])], S1);
    expect(ended.querySelector('[data-od-id="agent-thinking"]')).toBeNull();
  });
});
