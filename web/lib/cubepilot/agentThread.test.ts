// @vitest-environment node
import { describe, expect, it } from "vitest";

import { applyAgentEvent, attachToolResult, fmtToolArgs, historyToMsgs, newAgentMsg } from "./agentThread";
import type { AgentBlock, AgentMsg, ThreadMsg } from "./agentThread";
import type { AgentSseEvent } from "./types";

const T0 = 1_700_000_000_000;

/** Fold a list of events onto a fresh message.
 *
 *  The timestamp is passed to the CONSTRUCTOR as well as to every event, and
 *  that is load-bearing: `newAgentMsg` starts in phase "thinking" and
 *  `setPhase` is a no-op when the phase does not change, so an `agent_thinking`
 *  as the first event leaves `phaseAt` at whatever the constructor set. Letting
 *  the constructor default to `Date.now()` would make `phaseAt` a real clock
 *  reading while every event carries `T0`, and the phaseAt assertions below
 *  would compare against the wrong number. */
function fold(events: AgentSseEvent[], now = T0): AgentMsg {
  return events.reduce((m, e) => applyAgentEvent(m, e, now), newAgentMsg(1, now));
}

const textOf = (m: AgentMsg) => m.blocks.filter((b) => b.kind === "text").map((b) => b.text);
/** Takes blocks, not a message, so `attachToolResult` (which returns blocks)
 *  can be asserted on directly without a cast. */
const toolsOf = (blocks: AgentBlock[]) =>
  blocks.filter((b): b is Extract<AgentBlock, { kind: "tool" }> => b.kind === "tool");

describe("applyAgentEvent — block ordering", () => {
  it("keeps text and tool calls in arrival order", () => {
    const m = fold([
      { type: "message_start", sessionId: "s" },
      { type: "message_delta", sessionId: "s", delta: "先查一下。" },
      { type: "tool_call", sessionId: "s", name: "exec", callId: "c1", arguments: { command: "kubectl get pods" } },
      { type: "tool_result", sessionId: "s", callId: "c1", output: "running" },
      { type: "message_delta", sessionId: "s", delta: "一切正常。" },
    ]);
    expect(m.blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
    expect(textOf(m)).toEqual(["先查一下。", "一切正常。"]);
  });

  it("appends a delta to the trailing text block, not a new one", () => {
    const m = fold([
      { type: "message_delta", sessionId: "s", delta: "a" },
      { type: "message_delta", sessionId: "s", delta: "b" },
    ]);
    expect(textOf(m)).toEqual(["ab"]);
  });

  it("starts a new text block when the trailing block is a tool", () => {
    const m = fold([
      { type: "message_delta", sessionId: "s", delta: "a" },
      { type: "tool_call", sessionId: "s", name: "exec", callId: "c1" },
      { type: "message_delta", sessionId: "s", delta: "b" },
    ]);
    expect(textOf(m)).toEqual(["a", "b"]);
  });
});

describe("applyAgentEvent — text_replace", () => {
  it("replaces rather than appends, and keeps the displaced text", () => {
    const m = fold([
      { type: "message_delta", sessionId: "s", delta: "我先看看。" },
      { type: "text_replace", sessionId: "s", delta: "看完了。" },
    ]);
    expect(textOf(m)).toEqual(["看完了。"]);
    const block = m.blocks[0] as Extract<AgentBlock, { kind: "text" }>;
    expect(block.superseded).toEqual(["我先看看。"]);
  });

  it("does not pile up copies when a snapshot repeats", () => {
    const m = fold([
      { type: "message_delta", sessionId: "s", delta: "same" },
      { type: "text_replace", sessionId: "s", delta: "same" },
      { type: "text_replace", sessionId: "s", delta: "same" },
    ]);
    const block = m.blocks[0] as Extract<AgentBlock, { kind: "text" }>;
    expect(block.superseded).toBeUndefined();
  });
});

describe("applyAgentEvent — approvals", () => {
  const pending: AgentSseEvent = {
    type: "approval_pending",
    sessionId: "s",
    callId: "a1",
    name: "exec",
    command: "kubectl delete pod x",
    level: "write",
  };

  it("records a pending approval", () => {
    const m = fold([pending]);
    expect(m.approvals).toEqual([
      { callId: "a1", name: "exec", command: "kubectl delete pod x", level: "write", message: undefined, state: "pending" },
    ]);
  });

  it("resolves to approved on an explicit true", () => {
    const m = fold([pending, { type: "approval_resolved", sessionId: "s", callId: "a1", approved: true }]);
    expect(m.approvals[0].state).toBe("approved");
  });

  it("resolves to rejected on an explicit false", () => {
    const m = fold([pending, { type: "approval_resolved", sessionId: "s", callId: "a1", approved: false }]);
    expect(m.approvals[0].state).toBe("rejected");
  });

  it("resolves to STOPPED when approved is absent — that is not a rejection", () => {
    const m = fold([pending, { type: "approval_resolved", sessionId: "s", callId: "a1" }]);
    expect(m.approvals[0].state).toBe("stopped");
  });
});

describe("applyAgentEvent — questions", () => {
  it("records a question with a deadline derived from the remainder", () => {
    const m = fold([
      {
        type: "question_pending",
        sessionId: "s",
        callId: "q1",
        question: { questions: [{ questionId: "scope", question: "范围?" }], timeoutSeconds: 45 },
      },
    ]);
    expect(m.questions).toHaveLength(1);
    expect(m.questions[0].deadline).toBe(T0 + 45_000);
    expect(m.questions[0].state).toBe("pending");
  });

  it("leaves the deadline unset when the event carries no timeout", () => {
    const m = fold([
      { type: "question_pending", sessionId: "s", callId: "q1", question: { questions: [{ questionId: "x", question: "?" }] } },
    ]);
    expect(m.questions[0].deadline).toBeUndefined();
  });

  it("maps the resolved message onto a state", () => {
    const base: AgentSseEvent = { type: "question_pending", sessionId: "s", callId: "q1", question: { questions: [{ questionId: "x", question: "?" }] } };
    const stateAfter = (message?: string) =>
      fold([base, { type: "question_resolved", sessionId: "s", callId: "q1", ...(message === undefined ? {} : { message }) }]).questions[0].state;
    expect(stateAfter("answered")).toBe("answered");
    expect(stateAfter("cancelled")).toBe("cancelled");
    expect(stateAfter("expired")).toBe("expired");
    expect(stateAfter()).toBe("answered");
  });
});

describe("applyAgentEvent — message_done", () => {
  it("freezes the phase and records error/stopped", () => {
    const m = fold([{ type: "message_done", sessionId: "s", error: "boom", stopped: false }]);
    expect(m.phase).toBe("done");
    expect(m.error).toBe("boom");
    expect(m.stopped).toBe(false);
  });

  it("settles every unresolved question as cancelled, like the server's settle", () => {
    const m = fold([
      { type: "question_pending", sessionId: "s", callId: "q1", question: { questions: [{ questionId: "x", question: "?" }] } },
      { type: "message_done", sessionId: "s" },
    ]);
    expect(m.questions[0].state).toBe("cancelled");
  });
});

describe("applyAgentEvent — phaseAt", () => {
  it("resets when the phase changes and holds while it does not", () => {
    // Constructed at T0: `newAgentMsg` starts in "thinking", so the
    // agent_thinking below does not change the phase and must not move phaseAt.
    const a = applyAgentEvent(newAgentMsg(1, T0), { type: "agent_thinking", sessionId: "s" }, T0);
    expect(a.phase).toBe("thinking");
    expect(a.phaseAt).toBe(T0);
    const b = applyAgentEvent(a, { type: "message_delta", sessionId: "s", delta: "x" }, T0 + 5_000);
    expect(b.phase).toBe("streaming");
    expect(b.phaseAt).toBe(T0 + 5_000);
    const c = applyAgentEvent(b, { type: "message_delta", sessionId: "s", delta: "y" }, T0 + 9_000);
    expect(c.phaseAt).toBe(T0 + 5_000);
  });
});

describe("historyToMsgs", () => {
  let seq = 0;
  const nextId = () => ++seq;

  it("normalizes a user message carried as a plain string", () => {
    // The string form is the one that used to be iterated character by
    // character and silently dropped, leaving only the agent side visible.
    const out = historyToMsgs([{ role: "user", content: "看看集群" }], nextId, T0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "user", text: "看看集群" });
  });

  it("reads a user message carried as a block array", () => {
    const out = historyToMsgs([{ role: "user", content: [{ type: "text", text: "看看集群" }] }], nextId, T0);
    expect(out).toHaveLength(1);
    expect((out[0] as Extract<ThreadMsg, { role: "user" }>).text).toBe("看看集群");
  });

  it("drops a whitespace-only user message", () => {
    expect(historyToMsgs([{ role: "user", content: "   " }], nextId, T0)).toEqual([]);
  });

  it("folds an assistant text + toolCall + toolResult run into one bubble, in order", () => {
    const out = historyToMsgs(
      [
        { role: "assistant", content: [{ type: "text", text: "先查一下。" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "exec", arguments: { cmd: "ceph df" } }] },
        { role: "toolResult", content: [{ type: "toolCall", id: "c1", text: "POOL USED: 71%" }] },
        { role: "assistant", content: [{ type: "text", text: "使用率 71%。" }] },
      ],
      nextId,
      T0,
    );
    expect(out).toHaveLength(1);
    const msg = out[0] as AgentMsg;
    expect(msg.blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
    expect(toolsOf(msg.blocks)[0].output).toBe("POOL USED: 71%");
    expect(toolsOf(msg.blocks)[0].done).toBe(true);
  });

  it("closes the bubble at a user message", () => {
    const out = historyToMsgs(
      [
        { role: "assistant", content: [{ type: "text", text: "a" }] },
        { role: "user", content: "b" },
        { role: "assistant", content: [{ type: "text", text: "c" }] },
      ],
      nextId,
      T0,
    );
    expect(out.map((m) => m.role)).toEqual(["agent", "user", "agent"]);
  });

  it("marks a restored turn finished, so it renders settled rather than in flight", () => {
    const out = historyToMsgs([{ role: "assistant", content: [{ type: "text", text: "a" }] }], nextId, T0);
    expect((out[0] as AgentMsg).phase).toBe("done");
  });
});

describe("fmtToolArgs", () => {
  it("shows an exec-style command verbatim", () => {
    expect(fmtToolArgs({ cmd: "kubectl get pods -A" })).toBe("kubectl get pods -A");
    expect(fmtToolArgs({ command: "ceph df" })).toBe("ceph df");
  });

  it("passes a non-JSON string through unchanged", () => {
    expect(fmtToolArgs("not json")).toBe("not json");
  });

  it("parses a JSON string before formatting", () => {
    expect(fmtToolArgs('{"cmd":"ceph df"}')).toBe("ceph df");
  });

  it("joins key: value pairs when there is no command", () => {
    expect(fmtToolArgs({ ns: "gpu-operator", name: "pod-1" })).toBe("ns: gpu-operator  name: pod-1");
  });

  it("returns undefined for no arguments", () => {
    expect(fmtToolArgs(undefined)).toBeUndefined();
    expect(fmtToolArgs(null)).toBeUndefined();
  });

  it("redacts secret-looking values at any nesting depth", () => {
    const out = fmtToolArgs({ headers: { authorization: "Bearer abc" }, nested: [{ apiKey: "k" }] });
    expect(out).not.toContain("Bearer abc");
    expect(out).toContain("••••••");
  });
});

describe("attachToolResult", () => {
  const tool = (callId: string | undefined, extra: Partial<Extract<AgentBlock, { kind: "tool" }>> = {}): AgentBlock => ({
    kind: "tool",
    callId,
    name: "exec",
    done: false,
    ...extra,
  });
  const outputs = (blocks: AgentBlock[]) => toolsOf(blocks).map((t) => t.output);

  it("pairs by callId", () => {
    expect(outputs(attachToolResult([tool("a"), tool("b")], "b", "OUT"))).toEqual([undefined, "OUT"]);
  });

  it("falls back to the oldest unfinished call when there is no callId", () => {
    const out = attachToolResult([tool(undefined), tool(undefined, { done: true, output: "x" })], undefined, "OUT");
    expect(outputs(out)).toEqual(["OUT", "x"]);
  });

  it("joins a second result on the same call instead of overwriting", () => {
    expect(outputs(attachToolResult([tool("a", { done: true, output: "first" })], "a", "second"))).toEqual(["first\nsecond"]);
  });

  it("never overwrites a finished call when no target matches", () => {
    expect(outputs(attachToolResult([tool("a", { done: true, output: "keep" })], "zzz", "ORPHAN"))).toEqual(["keep"]);
  });

  it("drops an orphan result when there is nothing to attach it to", () => {
    expect(attachToolResult([], undefined, "ORPHAN")).toEqual([]);
  });
});
