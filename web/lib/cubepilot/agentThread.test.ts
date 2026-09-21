// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  applyAgentEvent,
  approvalExpiring,
  approvalSecondsLeft,
  attachToolResult,
  fmtToolArgs,
  historyToMsgs,
  isExpiring,
  newAgentMsg,
  remainingSeconds,
  seedAnswers,
  TOOL_SUMMARY_CHARS,
  toolSummary,
  turnStatus,
  waitingOnUser,
} from "./agentThread";
import type { AgentApproval, AgentBlock, AgentMsg, AgentQuestion, ThreadMsg } from "./agentThread";
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

describe("applyAgentEvent — narration", () => {
  // The agent's between-tool commentary (cubepilot #216). Without these the
  // stream showed tool cards appearing one after another with nothing between
  // them, while the same turn read from history showed every step — and, before
  // the event was known at all, the unknown type left a hole in `msgs` that the
  // thread crashed on.

  it("appends each step in arrival order, between the cards it introduced", () => {
    const m = fold([
      { type: "narration", sessionId: "s", blockId: "n1", text: "先看节点。" },
      { type: "tool_call", sessionId: "s", name: "exec", callId: "c1", arguments: { command: "kubectl get nodes" } },
      { type: "narration", sessionId: "s", blockId: "n2", text: "节点正常,看 Pod。" },
      { type: "tool_call", sessionId: "s", name: "exec", callId: "c2", arguments: { command: "kubectl get pods -A" } },
    ]);
    expect(m.blocks.map((b) => b.kind)).toEqual(["text", "tool", "text", "tool"]);
    expect(textOf(m)).toEqual(["先看节点。", "节点正常,看 Pod。"]);
  });

  it("replaces a block's text rather than appending the snapshot to it", () => {
    // `text` is the block's WHOLE text. Appending would print the step once per
    // snapshot, which is what the lane's re-publish would do.
    const m = fold([
      { type: "narration", sessionId: "s", blockId: "n1", text: "先看" },
      { type: "narration", sessionId: "s", blockId: "n1", text: "先看节点,再看 Pod" },
    ]);
    expect(textOf(m)).toEqual(["先看节点,再看 Pod"]);
  });

  it("keeps the answer out of the narration it follows", () => {
    // The narration introduces a tool call; the reply is a different thing, and
    // merging them would print the conclusion inside that sentence.
    const m = fold([
      { type: "narration", sessionId: "s", blockId: "n1", text: "先看节点。" },
      { type: "message_delta", sessionId: "s", delta: "共 1 个节点。" },
    ]);
    expect(m.blocks.map((b) => b.kind)).toEqual(["text", "text"]);
    expect(textOf(m)).toEqual(["先看节点。", "共 1 个节点。"]);
  });

  it("continues the reply across deltas that follow narration", () => {
    const m = fold([
      { type: "narration", sessionId: "s", blockId: "n1", text: "先看节点。" },
      { type: "message_delta", sessionId: "s", delta: "共 1 个" },
      { type: "message_delta", sessionId: "s", delta: "节点。" },
    ]);
    expect(textOf(m)).toEqual(["先看节点。", "共 1 个节点。"]);
  });

  it("ignores an event type this build does not know", () => {
    // A newer API's addition must not take the page down: the fold returns the
    // message unchanged, rather than nothing, which the caller would store as a
    // hole in the list and the thread would crash on.
    const m = fold([{ type: "some_future_event", sessionId: "s" } as unknown as AgentSseEvent]);
    expect(m.blocks).toEqual([]);
    expect(m.phase).toBe("thinking");
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

  it("holds several at once, each keeping the gateway's stamps", () => {
    // One turn can have two writes held back. They are two cards, not one: the
    // platform used to keep only the newest, so a decision aimed at either of
    // them settled that one.
    const m = fold([
      { ...pending, callId: "a1", createdAtMs: 1000, expiresAtMs: 60000 },
      { ...pending, callId: "a2", command: "kubectl rollout restart deploy/y", createdAtMs: 2000 },
    ]);
    expect(m.approvals.map((a) => a.callId)).toEqual(["a1", "a2"]);
    expect(m.approvals[0].createdAtMs).toBe(1000);
    expect(m.approvals[0].expiresAtMs).toBe(60000);
    expect(m.approvals[1].createdAtMs).toBe(2000);
  });

  it("does not double an approval the turn already carries", () => {
    // The stream pushes it and a reload reads the pending list; two accounts of
    // one approval are two cards unless the id is the key.
    const m = fold([pending, pending]);
    expect(m.approvals).toHaveLength(1);
  });

  it("keeps the state a card already has when the same approval arrives again", () => {
    // Skipping rather than replacing: the copy already there is the one the
    // user's own click moved.
    const m = fold([
      pending,
      { type: "approval_resolved", sessionId: "s", callId: "a1", approved: true },
      { ...pending, createdAtMs: 5000 },
    ]);
    expect(m.approvals).toHaveLength(1);
    expect(m.approvals[0].state).toBe("approved");
    // ...and the late copy did not overwrite the record either.
    expect(m.approvals[0].createdAtMs).toBeUndefined();
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

  it("settles an undecided approval as STOPPED — the resolve event races the stream", () => {
    // The server publishes the resolve alongside the terminal, but it races the
    // stream's close. A card left live would offer Approve/Reject buttons that
    // POST to a record the settle already deleted, and would keep the header
    // saying "waiting" for a turn that is over.
    const m = fold([
      { type: "approval_pending", sessionId: "s", callId: "a1", name: "exec", command: "kubectl delete pod x", level: "write" },
      { type: "message_done", sessionId: "s" },
    ]);
    expect(m.approvals[0].state).toBe("stopped");
  });

  it("leaves a decision that did arrive alone", () => {
    const m = fold([
      { type: "approval_pending", sessionId: "s", callId: "a1", name: "exec", command: "x", level: "write" },
      { type: "approval_resolved", sessionId: "s", callId: "a1", approved: true },
      { type: "message_done", sessionId: "s" },
    ]);
    expect(m.approvals[0].state).toBe("approved");
  });
});

describe("turnStatus", () => {
  it("reports a lost transport before anything else, even with no phase", () => {
    const m = { ...newAgentMsg(1, T0), phase: "done" as const, transportLost: "boom" };
    expect(turnStatus(m, T0)).toEqual({ tone: "lost", key: "cubepilot.chat.statusLost" });
  });

  it("names the live phase with the elapsed seconds", () => {
    const thinking = { ...newAgentMsg(1, T0), phase: "thinking" as const };
    expect(turnStatus(thinking, T0 + 12_000)).toEqual({
      tone: "run",
      key: "cubepilot.chat.statusThinking",
      vars: { secs: 12 },
    });
  });

  it("counts only the tools still in flight", () => {
    const m = fold([
      { type: "tool_call", sessionId: "s", name: "exec", callId: "c1" },
      { type: "tool_call", sessionId: "s", name: "exec", callId: "c2" },
      { type: "tool_result", sessionId: "s", callId: "c1", output: "done" },
    ]);
    expect(turnStatus(m, T0 + 3_000)).toEqual({
      tone: "run",
      key: "cubepilot.chat.statusTools",
      vars: { count: 1, secs: 3 },
    });
  });

  it("says it is collating, not running zero tools, once every tool has returned", () => {
    const m = fold([
      { type: "tool_call", sessionId: "s", name: "exec", callId: "c1" },
      { type: "tool_result", sessionId: "s", callId: "c1", output: "done" },
    ]);
    expect(turnStatus(m, T0 + 4_000)).toEqual({
      tone: "run",
      key: "cubepilot.chat.statusCollating",
      vars: { secs: 4 },
    });
  });

  it("distinguishes a finished turn's three outcomes", () => {
    const done = (extra: Partial<AgentMsg>) => ({ ...newAgentMsg(1, T0), phase: "done" as const, ...extra });
    expect(turnStatus(done({}), T0)).toEqual({ tone: "done", key: "cubepilot.chat.statusDone" });
    expect(turnStatus(done({ stopped: true }), T0)).toEqual({ tone: "stopped", key: "cubepilot.chat.statusStopped" });
    expect(turnStatus(done({ error: "boom" }), T0)).toEqual({ tone: "error", key: "cubepilot.chat.statusFailed" });
  });
});

describe("waitingOnUser", () => {
  it("is null while nothing is parked", () => {
    expect(waitingOnUser([newAgentMsg(1, T0)])).toBeNull();
  });

  it("reports a pending question ahead of a pending approval", () => {
    const m = fold([
      { type: "approval_pending", sessionId: "s", callId: "a1", name: "exec", command: "x", level: "write" },
      { type: "question_pending", sessionId: "s", callId: "q1", question: { questions: [{ questionId: "x", question: "?" }] } },
    ]);
    expect(waitingOnUser([m])).toBe("question");
  });

  it("stops reporting once the terminal settles the cards", () => {
    const m = fold([
      { type: "approval_pending", sessionId: "s", callId: "a1", name: "exec", command: "x", level: "write" },
      { type: "message_done", sessionId: "s" },
    ]);
    expect(waitingOnUser([m])).toBeNull();
  });

  it("ignores a user message in the list", () => {
    expect(waitingOnUser([{ id: 1, role: "user", text: "hi" }])).toBeNull();
  });
});

describe("question timing", () => {
  const q = (deadline?: number) => ({ callId: "q1", questions: [], state: "pending" as const, ...(deadline ? { deadline } : {}) });

  it("reports no remaining time when the event carried no timeout", () => {
    expect(remainingSeconds(q(), T0)).toBeUndefined();
  });

  it("rounds the remainder", () => {
    expect(remainingSeconds(q(T0 + 45_000), T0)).toBe(45);
    expect(remainingSeconds(q(T0 + 44_600), T0)).toBe(45);
  });

  it("never goes negative", () => {
    expect(remainingSeconds(q(T0 - 5_000), T0)).toBe(0);
  });

  it("is expiring at zero, and not before", () => {
    expect(isExpiring(q(T0 + 1_000), T0)).toBe(false);
    expect(isExpiring(q(T0), T0)).toBe(true);
    // Undefined deadline is not the same as expired.
    expect(isExpiring(q(), T0)).toBe(false);
  });

  it("is not expiring once the card has settled, whatever the clock says", () => {
    expect(isExpiring({ ...q(T0), state: "answered" }, T0)).toBe(false);
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

describe("approval expiry", () => {
  // The gateway drops a held write thirty minutes after it was raised, and the
  // run it was gating dies with it. The stamp rides on both wire shapes; the
  // reference draws no timer at all, so these are the rules for ours.

  const at = (expiresAtMs?: number): AgentApproval => ({ callId: "a1", state: "pending", ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) });

  it("counts down to the stamp the gateway gave it", () => {
    expect(approvalSecondsLeft(at(1_000_000 + 90_000), 1_000_000)).toBe(90);
    expect(approvalSecondsLeft(at(1_000_000), 1_000_000)).toBe(0);
  });

  it("says nothing when the approval carries no stamp", () => {
    expect(approvalSecondsLeft(at(), 1_000_000)).toBeUndefined();
  });

  it("is expiring once the stamp passes, and only while it is open", () => {
    expect(approvalExpiring(at(999), 1_000_000)).toBe(true);
    // Two seconds out, and the countdown rounds to whole seconds the way the
    // question's does — so the boundary is sub-second, not "any time in the
    // future".
    expect(approvalExpiring(at(1_002_000), 1_000_000)).toBe(false);
    // A decided card has no countdown to run out of, whatever the stamp says.
    expect(approvalExpiring({ ...at(999), state: "approved" }, 1_000_000)).toBe(false);
  });
});

describe("seedAnswers", () => {
  // A settled card is the record of a decision. Its answer is on the question,
  // and the card's own state starts empty — so without this a decided question
  // reads as a blank form: what was asked, and not what was answered.
  const q = (over: Partial<AgentQuestion> = {}): AgentQuestion => ({
    callId: "q1",
    questions: [
      { questionId: "scope", question: "范围?", options: [{ label: "全部节点" }, { label: "仅 compute 节点" }] },
    ],
    state: "answered",
    ...over,
  });

  it("puts a chosen label among the picked options", () => {
    expect(seedAnswers(q({ answers: { scope: ["仅 compute 节点"] } }))).toEqual({
      picked: { scope: ["仅 compute 节点"] },
      other: {},
    });
  });

  it("puts anything that is not a label in the free text", () => {
    expect(seedAnswers(q({ answers: { scope: ["先别动,等我确认"] } }))).toEqual({
      picked: {},
      other: { scope: "先别动,等我确认" },
    });
  });

  it("keeps both when the human picked one and wrote something", () => {
    const out = seedAnswers(q({ answers: { scope: ["全部节点", "跳过 GPU 节点"] } }));
    expect(out.picked.scope).toEqual(["全部节点"]);
    expect(out.other.scope).toBe("跳过 GPU 节点");
  });

  it("treats every answer to an optionless question as words", () => {
    // There is nothing to match, so it can only be free text.
    const free: AgentQuestion = { ...q(), questions: [{ questionId: "why", question: "为什么?" }] };
    expect(seedAnswers({ ...free, answers: { why: ["业务要上线了"] } })).toEqual({
      picked: {},
      other: { why: "业务要上线了" },
    });
  });

  it("leaves an unanswered question empty", () => {
    expect(seedAnswers(q())).toEqual({ picked: {}, other: {} });
    expect(seedAnswers(q({ answers: { scope: [] } }))).toEqual({ picked: {}, other: {} });
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
    // The toolResult message is the runtime's real shape: it carries its output
    // in a block of type `text`, and the call it answers in a MESSAGE-level
    // `toolCallId` — never in a `toolCall` block. Pinning the block shape here is
    // what let the pairing branch go untested while it silently dropped every
    // restored result.
    const out = historyToMsgs(
      [
        { role: "assistant", content: [{ type: "text", text: "先查一下。" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "exec", arguments: { cmd: "ceph df" } }] },
        { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "POOL USED: 71%" }] },
        { role: "assistant", content: [{ type: "text", text: "使用率 71%。" }] },
      ],
      nextId,
      T0,
    );
    expect(out).toHaveLength(1);
    const msg = out[0] as AgentMsg;
    expect(msg.blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
    // The result is the card's output, not narration: attaching it must not also
    // leave its text in the turn's prose.
    expect(textOf(msg)).toEqual(["先查一下。", "使用率 71%。"]);
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

describe("toolSummary", () => {
  // The collapsed card names what it ran. Without this the header said only
  // "exec", and the reader had to open every card to find the command that
  // produced the output they were scanning for.

  it("is the command, for the common one-liner", () => {
    expect(toolSummary("kubectl get pods -A")).toBe("kubectl get pods -A");
  });

  it("is the first line of a multi-line command, not all of them", () => {
    // A pipeline written across lines would otherwise push the header apart.
    expect(toolSummary("kubectl get pods -A -o json \\\n  | jq '.items' \\\n  | head")).toBe(
      "kubectl get pods -A -o json \\",
    );
  });

  it("skips leading blank lines rather than showing an empty header", () => {
    expect(toolSummary("\n\n   \nkubectl get nodes")).toBe("kubectl get nodes");
  });

  it("marks a line it had to cut, and says nothing else", () => {
    const long = "kubectl get pods -A -o jsonpath=" + "x".repeat(400);
    const out = toolSummary(long);
    expect(out).toHaveLength(TOOL_SUMMARY_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
    // The marker is ours, not the command's: what precedes it is verbatim.
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it("does not cut a line that only looks long because of its width", () => {
    // Truncation for display is the browser's job; cutting here would take
    // characters a wide card could have shown.
    const line = "kubectl ".repeat(10).trim();
    expect(line.length).toBeLessThan(TOOL_SUMMARY_CHARS);
    expect(toolSummary(line)).toBe(line);
  });

  it("is empty when there is nothing to name", () => {
    expect(toolSummary(undefined)).toBe("");
    expect(toolSummary("")).toBe("");
    expect(toolSummary("   \n  ")).toBe("");
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
