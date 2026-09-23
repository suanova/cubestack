// Pure model + event folding for the CubePilot agent conversation.
//
// No React and no fetch live here: every function is a plain transformation of
// plain data, so the parts most likely to break (the ordering of a streamed
// turn, the pairing of tool results, the meaning of a missing decision) are the
// parts under unit test rather than under a rendered component.
//
// Contract: cubepilot docs/cubepilot/api.md §4/§5/§7.

import type { MessageKey } from "@/lib/i18n/dictionaries";
import type { AgentQuestionItem, AgentSseEvent, HistoryMessage } from "./types";

export type AgentPhase = "thinking" | "tools" | "streaming" | "done";

/**
 * One element of an assistant turn. A turn is an ordered list of these rather
 * than "a text string plus a list of tools": the agent narrates, calls a tool,
 * narrates again, and flattening that into two arrays renders every tool call
 * after every sentence it was interleaved with.
 */
export type AgentBlock =
  | {
      kind: "text";
      text: string;
      superseded?: string[];
      /** Set only on narration — the agent's between-tool commentary. It names
       *  the block the text belongs to: a later snapshot with the same id
       *  replaces this one's text, a new id starts a new block. Text without it
       *  is the turn's own text: its reply, or a restored assistant message. */
      blockId?: string;
    }
  | { kind: "tool"; callId?: string; name: string; args?: string; output?: string; done: boolean };

export interface AgentApproval {
  callId: string;
  name?: string;
  command?: string;
  level?: string;
  message?: string;
  /** "pending"/"deciding" are the unresolved states the dock shows. */
  state: "pending" | "deciding" | "approved" | "rejected" | "stopped";
  /** Set when the decision POST failed; the card stays answerable. */
  error?: string;
  /** The gateway's stamps for this approval, epoch ms. A session can hold
   *  several at once, and a card that came back from a reload has no arrival
   *  order to sit in, so createdAtMs is what orders them. */
  createdAtMs?: number;
  expiresAtMs?: number;
}

export type AgentQuestionState = "pending" | "submitting" | "answered" | "cancelled" | "expired";

export interface AgentQuestion {
  callId: string;
  questions: AgentQuestionItem[];
  state: AgentQuestionState;
  /** Local deadline in ms, derived from the event's remaining seconds. */
  deadline?: number;
  answers?: Record<string, string[]>;
  /** Set when an answer was refused; the card stays answerable. */
  error?: string;
}

export interface AgentMsg {
  id: number;
  role: "agent";
  blocks: AgentBlock[];
  approvals: AgentApproval[];
  questions: AgentQuestion[];
  phase: AgentPhase;
  /** When the current phase started — drives the status line's seconds. */
  phaseAt: number;
  error?: string;
  stopped?: boolean;
  /**
   * Set when the SSE stream ended without a terminal event. This is a transport
   * failure, not a turn outcome: the run may still be executing and its HITL
   * cards are still answerable, so nothing may treat the turn as over.
   */
  transportLost?: string;
}

export function newAgentMsg(id: number, now: number = Date.now()): AgentMsg {
  return { id, role: "agent", blocks: [], approvals: [], questions: [], phase: "thinking", phaseAt: now };
}

/**
 * One entry of the thread. A user prompt is its own kind — it has no blocks —
 * so the thread type has to be a union; typing it as AgentMsg alone cannot
 * represent the user's own messages.
 */
export type ThreadMsg = { id: number; role: "user"; text: string } | AgentMsg;

/**
 * The lines a fresh conversation opens with: what the session is looking at, and
 * — once the effective approval policy is known — what happens to write
 * operations.
 *
 * The approval line is the part that has to be EARNED. The platform offers two
 * policies — None (writes just run) and Allowlist (only unlisted writes ask) — and
 * a sentence claiming one of them unconditionally is wrong for the other: that is
 * what this used to print, so a deployment with approvals turned off was greeted
 * with a promise to ask.
 *
 * Anything else — a policy this UI does not offer, or "" for a read that failed or
 * has not landed — claims nothing about approvals rather than guessing. The
 * frontend deliberately carries no third policy: the platform's own page offers
 * these two, and inventing a sentence for a value nobody here can set would be
 * copy with no owner.
 *
 * Both surfaces build their greeting from this: the chat pane and the floating
 * panel ask the same question, and a second copy of the answer is where they
 * would drift apart.
 */
export function greetingTexts(
  t: (key: MessageKey, params?: Record<string, string>) => string,
  opts: { exists: boolean; model: string; skills: number; policy: string },
): string[] {
  if (!opts.exists) return [t("cubepilot.chat.greetingNoInstance")];
  const lines = [t("cubepilot.chat.greeting", { tools: String(opts.skills), model: opts.model })];
  if (opts.policy === "None") lines.push(t("cubepilot.chat.approvalNone"));
  else if (opts.policy === "Allowlist") lines.push(t("cubepilot.chat.approvalAllowlist"));
  lines.push(t("cubepilot.chat.greetingMeta"));
  return lines;
}

// ── event folding ────────────────────────────────────────────────────────

/**
 * Build one card, from whichever wire shape described it.
 *
 * Two channels describe the same thing — the `approval_pending` event on the
 * stream and an entry of the pending read after a reload — and they name the id
 * differently (`callId` and `approvalId`), so the caller normalises that and
 * this holds the rest. One projection rather than one per call site: the stamps
 * are the part that a reload depends on, and a second copy of this is where they
 * would go missing again.
 */
export function newApproval(wire: {
  approvalId: string;
  name?: string;
  command?: string;
  level?: string;
  message?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
}): AgentApproval {
  return {
    callId: wire.approvalId,
    name: wire.name,
    command: wire.command,
    level: wire.level,
    message: wire.message,
    state: "pending",
    ...(wire.createdAtMs !== undefined ? { createdAtMs: wire.createdAtMs } : {}),
    ...(wire.expiresAtMs !== undefined ? { expiresAtMs: wire.expiresAtMs } : {}),
  };
}

/**
 * Add a card unless the turn already carries that approval.
 *
 * The same approval reaches the view twice in ordinary use — the stream pushes
 * it, and a reload reads the pending list — and two accounts of one approval are
 * two cards unless the id is the key. Skipping is right rather than replacing:
 * the copy already there has whatever state the user's own click gave it.
 */
export function addApproval(msg: AgentMsg, card: AgentApproval): AgentMsg {
  if (msg.approvals.some((a) => a.callId === card.callId)) return msg;
  return { ...msg, approvals: [...msg.approvals, card] };
}

/** Fold one SSE event onto a message, returning a new message. */
export function applyAgentEvent(msg: AgentMsg, evt: AgentSseEvent, now: number = Date.now()): AgentMsg {
  switch (evt.type) {
    case "message_start":
    case "agent_thinking":
      return setPhase(msg, "thinking", now);
    case "message_delta":
      return appendText(setPhase(msg, "streaming", now), evt.delta);
    case "text_replace":
      return replaceText(setPhase(msg, "streaming", now), evt.delta);
    case "narration":
      return narrate(msg, evt.blockId, evt.text);
    case "tool_call":
      return setPhase(
        {
          ...msg,
          blocks: [
            ...msg.blocks,
            { kind: "tool", callId: evt.callId, name: evt.name, args: fmtToolArgs(evt.arguments), done: false },
          ],
        },
        "tools",
        now,
      );
    case "tool_result":
      return setPhase({ ...msg, blocks: attachToolResult(msg.blocks, evt.callId, evt.output ?? "") }, "tools", now);
    case "approval_pending":
      return setPhase(
        addApproval(
          msg,
          newApproval({
            approvalId: evt.callId,
            name: evt.name,
            command: evt.command,
            level: evt.level,
            message: evt.message,
            createdAtMs: evt.createdAtMs,
            expiresAtMs: evt.expiresAtMs,
          }),
        ),
        "tools",
        now,
      );
    case "approval_resolved":
      return {
        ...msg,
        approvals: msg.approvals.map((a) =>
          a.callId === evt.callId
            ? {
                ...a,
                // `approved` absent means nobody decided — the turn was stopped
                // while the write was parked. Reporting that as a rejection
                // would attribute a decision the user never made.
                state: evt.approved === undefined ? "stopped" : evt.approved ? "approved" : "rejected",
              }
            : a,
        ),
      };
    case "question_pending":
      return setPhase(
        {
          ...msg,
          questions: [
            ...msg.questions,
            newQuestion(evt.callId, evt.question?.questions ?? [], evt.question?.timeoutSeconds, now),
          ],
        },
        "tools",
        now,
      );
    case "question_resolved":
      return {
        ...msg,
        // Settle only the matching card: another question of this turn may still
        // be open.
        questions: msg.questions.map((q) => (q.callId === evt.callId ? { ...q, state: resolveOutcome(evt.message) } : q)),
      };
    case "message_done":
      // Reached ONLY for a confirmed server terminal. A synthesized terminal
      // reports a transport failure, not the end of the turn: the run may still
      // be parked on these very cards, and settling them would take away the
      // only controls that can unblock it. The caller filters those out before
      // folding (the stream-lost path sets `transportLost` instead of folding a
      // terminal), so this case must never see one.
      return {
        ...msg,
        phase: "done",
        // api.md makes the two mutually exclusive, and the reference reads them
        // as an `else if`: a terminal carrying both would otherwise paint a
        // stopped turn as a failed one as well. `stopped` wins, which is also
        // the order `turnStatus` ranks them in.
        error: evt.stopped === true ? undefined : evt.error || undefined,
        stopped: evt.stopped === true,
        // Settle BOTH channels, like the reference's settleBubbleCards. The
        // resolved event is published alongside the terminal but races the
        // stream's close, so a card whose event was lost would otherwise stay
        // live — offering Approve/Reject buttons that POST to a record the settle
        // already deleted, and keeping `waitingOnUser` non-empty so the header
        // reports "waiting" for a turn that is over.
        approvals: msg.approvals.map((a) =>
          a.state === "pending" || a.state === "deciding" ? { ...a, state: "stopped" as const } : a,
        ),
        // The same outcome the server's own settle publishes, so a card looks
        // identical whether its resolved event arrived or was lost.
        questions: msg.questions.map((q) =>
          q.state === "pending" || q.state === "submitting" ? { ...q, state: "cancelled" as const } : q,
        ),
      };
    default:
      // An event this build does not know: a newer API's addition, or one this
      // client has not been taught yet. Ignoring it is the only safe reading —
      // the alternative is returning nothing, which the caller stores as a hole
      // in `msgs` and the thread then crashes on, taking down a conversation
      // that was otherwise fine. `narration` arrived exactly this way.
      return msg;
  }
}

function setPhase(msg: AgentMsg, phase: AgentPhase, now: number): AgentMsg {
  return msg.phase === phase ? msg : { ...msg, phase, phaseAt: now };
}

/**
 * Fold one narration snapshot onto the turn.
 *
 * The text is the block's WHOLE text, not an increment, so this replaces rather
 * than appends — an implementation that appended would print the step once per
 * snapshot. A `blockId` already in the turn is that block; a new one is a new
 * step, appended where it arrived, which is what keeps narration on either side
 * of a tool call on either side of its card.
 */
function narrate(msg: AgentMsg, blockId: string, text: string): AgentMsg {
  const at = msg.blocks.findIndex((b) => b.kind === "text" && b.blockId === blockId);
  if (at >= 0) {
    const blocks = [...msg.blocks];
    const cur = blocks[at] as Extract<AgentBlock, { kind: "text" }>;
    if (cur.text === text) return msg;
    blocks[at] = { ...cur, text };
    return { ...msg, blocks };
  }
  return { ...msg, blocks: [...msg.blocks, { kind: "text", text, blockId }] };
}

/** The block a streamed answer continues: the last one, and only when it is the
 *  turn's own text. A narration block is never continued — the answer is a
 *  different thing, and merging it into the commentary would print the agent's
 *  conclusion inside the sentence introducing a tool call. */
function answerBlock(blocks: AgentBlock[]): number {
  const last = blocks[blocks.length - 1];
  return last?.kind === "text" && last.blockId === undefined ? blocks.length - 1 : -1;
}

function appendText(msg: AgentMsg, delta: string): AgentMsg {
  const blocks = [...msg.blocks];
  const at = answerBlock(blocks);
  if (at >= 0) {
    const cur = blocks[at] as Extract<AgentBlock, { kind: "text" }>;
    blocks[at] = { ...cur, text: cur.text + delta };
  } else {
    blocks.push({ kind: "text", text: delta });
  }
  return { ...msg, blocks };
}

function replaceText(msg: AgentMsg, next: string): AgentMsg {
  const blocks = [...msg.blocks];
  const at = answerBlock(blocks);
  const last = at >= 0 ? (blocks[at] as Extract<AgentBlock, { kind: "text" }>) : undefined;
  if (!last) {
    blocks.push({ kind: "text", text: next });
    return { ...msg, blocks };
  }
  // A replace is a full snapshot, never an append (the gateway rewrites earlier
  // narration after a tool runs). The text it displaces is kept: it is what the
  // user was reading when the rewrite landed, and a rewrite is not a reason to
  // take it away from them. A rewrite that would change nothing is discarded,
  // so a repeated snapshot cannot pile up copies of the same text.
  const superseded =
    last.text && last.text !== next ? [...(last.superseded ?? []), last.text] : last.superseded;
  // No `blockId` carried over: this block is the turn's own text, which is what
  // the answer replaces.
  blocks[at] = {
    kind: "text",
    text: next,
    ...(superseded?.length ? { superseded } : {}),
  };
  return { ...msg, blocks };
}

/** A card for a question the gateway is holding, live or restored.
 *
 *  The deadline is derived from the REMAINDER the server reports, not from an
 *  absolute instant, so a countdown does not depend on this browser's clock
 *  agreeing with the API's. Both paths build their card through here: a restored
 *  card that skipped it had no deadline, so a reload left the question with no
 *  countdown and its controls live past the point the gateway had given it. */
export function newQuestion(
  callId: string,
  questions: AgentQuestionItem[],
  timeoutSeconds: number | undefined,
  now: number,
): AgentQuestion {
  return {
    callId,
    questions,
    state: "pending",
    // Derived from the remainder rather than an absolute deadline: the event
    // carries what is left, so a countdown does not depend on this browser's
    // clock agreeing with the API's.
    ...(timeoutSeconds ? { deadline: now + timeoutSeconds * 1000 } : {}),
  };
}

function resolveOutcome(message: string | undefined): AgentQuestionState {
  if (message === "cancelled") return "cancelled";
  if (message === "expired") return "expired";
  return "answered";
}

/**
 * Attach a tool result to the call it belongs to.
 *
 * Pairing order: an exact `callId` match; otherwise the oldest call that has not
 * finished, then the oldest call with no output yet. The gateway emits calls and
 * results in the same order, so arrival order is the fallback key. A second
 * result on one call is joined rather than overwritten, and a result that
 * matches nothing is dropped — never attached to the newest call, which would
 * clobber a result already recorded.
 */
export function attachToolResult(blocks: AgentBlock[], callId: string | undefined, output: string): AgentBlock[] {
  const tools = blocks
    .map((b, i) => ({ b, i }))
    .filter((x): x is { b: Extract<AgentBlock, { kind: "tool" }>; i: number } => x.b.kind === "tool");
  let target = -1;
  if (callId) {
    target = tools.find((t) => t.b.callId === callId && !t.b.done)?.i ?? tools.find((t) => t.b.callId === callId)?.i ?? -1;
  }
  if (target < 0) {
    target = tools.find((t) => !t.b.done)?.i ?? tools.find((t) => t.b.output === undefined)?.i ?? -1;
  }
  if (target < 0) return blocks;
  const out = [...blocks];
  const b = out[target] as Extract<AgentBlock, { kind: "tool" }>;
  out[target] = { ...b, output: b.output ? `${b.output}\n${output}` : output, done: true };
  return out;
}

// ── selectors ────────────────────────────────────────────────────────────

/** Cards still waiting on the user, across the whole transcript. */
export function openApprovals(msg: AgentMsg): AgentApproval[] {
  return msg.approvals.filter((a) => a.state === "pending" || a.state === "deciding");
}

export function openQuestions(msg: AgentMsg): AgentQuestion[] {
  return msg.questions.filter((q) => q.state === "pending" || q.state === "submitting");
}

/** Seconds left before the gateway expires the question, or undefined if it
 *  carries no deadline. */
export function remainingSeconds(q: AgentQuestion, now: number): number | undefined {
  if (q.deadline === undefined) return undefined;
  return Math.max(0, Math.round((q.deadline - now) / 1000));
}

/**
 * The local countdown has run out but the gateway has not settled the question
 * yet — so it is about to, or already has. Controls are withdrawn rather than
 * letting a click fall into a 409, but this is NOT the same as "expired": only
 * the gateway can say that.
 */
export function isExpiring(q: AgentQuestion, now: number): boolean {
  if (q.state !== "pending" && q.state !== "submitting") return false;
  const left = remainingSeconds(q, now);
  return left === 0;
}

/** Seconds until an approval's own expiry, or undefined when it carries none.
 *
 *  `expiresAtMs` is an absolute instant the gateway stamped (a question's
 *  deadline is derived here from the remainder it was sent), so this is the same
 *  arithmetic over a different field. The gateway expires a held write after
 *  thirty minutes and the run it was gating dies with it, which is worth showing
 *  the reader — the reference does not, and its approval card has no countdown
 *  at all. */
export function approvalSecondsLeft(a: AgentApproval, now: number): number | undefined {
  if (a.expiresAtMs === undefined) return undefined;
  return Math.max(0, Math.round((a.expiresAtMs - now) / 1000));
}

/** The approval's expiry has already passed locally, so the gateway has dropped
 *  the record and a click can only 404. Withdraw the controls rather than let a
 *  decision go nowhere — the same reasoning as `isExpiring`, and the same
 *  wording problem: this is NOT "expired", which only the gateway can say. */
export function approvalExpiring(a: AgentApproval, now: number): boolean {
  if (a.state !== "pending" && a.state !== "deciding") return false;
  return approvalSecondsLeft(a, now) === 0;
}

// ── tool-argument display ────────────────────────────────────────────────

/** Keys whose value must never reach the thread. Matched case-insensitively at
 *  any nesting depth, so `{headers:{authorization:"Bearer …"}}` cannot leak. */
const SECRET_KEY = /pass(word|wd)?|token|secret|api[-_]?key|access[-_]?key|authorization|credential|private[-_]?key/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "••••••" : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * A tool call's arguments as one display line: the command for exec-style
 * calls, otherwise the bare value or `key: value` pairs.
 */
export function fmtToolArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  let value: unknown = args;
  if (typeof value === "string") {
    const raw = value; // the string as it arrived
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return raw; // not JSON: show it as it came
    }
  }
  const safe = redact(value);
  if (safe && typeof safe === "object" && !Array.isArray(safe)) {
    const rec = safe as Record<string, unknown>;
    const cmd = rec.command ?? rec.cmd;
    if (typeof cmd === "string") return cmd;
    const entries = Object.entries(rec).map(
      ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
    );
    return entries.length > 0 ? entries.join("  ") : undefined;
  }
  return typeof safe === "string" ? safe : JSON.stringify(safe);
}

/** How much of a command the collapsed tool card keeps before cutting it. Wide
 *  enough for a real `kubectl … | jq …` line, short enough that a pathological
 *  one-liner cannot be poured into the DOM of every card in the thread. */
export const TOOL_SUMMARY_CHARS = 160;

/**
 * The one line a collapsed tool card shows of what it ran.
 *
 * A command is routinely multi-line — a `kubectl` pipeline with a `jq` filter is
 * eight lines — and the card's header is a single row, so this is the command's
 * first non-empty line. Whatever is still too wide for the card is trimmed by the
 * browser's own ellipsis, which costs the text nothing; only a line past
 * TOOL_SUMMARY_CHARS is cut here, and that is what the trailing marker means. The
 * whole command is one click away in the expanded card.
 */
export function toolSummary(args: string | undefined): string {
  const line = args?.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (!line) return "";
  return line.length > TOOL_SUMMARY_CHARS ? `${line.slice(0, TOOL_SUMMARY_CHARS).trimEnd()}…` : line;
}

/**
 * Split the answers a card already carries into the option labels that were
 * chosen and the words the human typed.
 *
 * A card records its answer on the question (`answers`), and the card's own
 * state starts empty — so without this a DECIDED question reads as a blank form:
 * the reader sees what was asked and not what was answered, which is the one
 * thing a record of a decision is for. An answer is one of the offered labels
 * when it matches one; anything else is free text, because that is the only
 * other thing it can be — a question with no options has nothing to match, so
 * everything given to it is words.
 */
export function seedAnswers(q: AgentQuestion): {
  picked: Record<string, string[]>;
  other: Record<string, string>;
} {
  const picked: Record<string, string[]> = {};
  const other: Record<string, string> = {};
  for (const item of q.questions) {
    const given = q.answers?.[item.questionId];
    if (!given?.length) continue;
    const labels = new Set((item.options ?? []).map((o) => o.label));
    const chosen = given.filter((a) => labels.has(a));
    const typed = given.find((a) => !labels.has(a));
    if (chosen.length) picked[item.questionId] = chosen;
    if (typed) other[item.questionId] = typed;
  }
  return { picked, other };
}

// ── history ──────────────────────────────────────────────────────────────
/**
 * Fold the runtime's history document into messages.
 *
 * `content` has two shapes and both must be normalized: a user message is a
 * plain string, while assistant and toolResult messages are arrays of content
 * blocks. Treating a string as an array iterates it character by character and
 * silently drops the user's prompt.
 */
export function historyToMsgs(items: HistoryMessage[], nextId: () => number, now: number = Date.now()): ThreadMsg[] {
  const out: ThreadMsg[] = [];
  for (const it of items) {
    if (it.role === "user") {
      const text =
        typeof it.content === "string"
          ? it.content
          : it.content
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n");
      if (text.trim()) out.push({ id: nextId(), role: "user", text });
      continue;
    }
    // Reuse the trailing assistant bubble so a text + toolCall + toolResult run
    // stays one bubble; a user message closes it.
    let msg = out[out.length - 1];
    if (!msg || msg.role !== "agent") {
      msg = { ...newAgentMsg(nextId(), now), phase: "done" };
      out.push(msg);
    }
    let agent = msg;
    // A toolResult message carries its output in a block of type `text`, NOT
    // `toolCall`: keying on the block type is the bug this shipped with — the
    // branch never fired, so every tool result was dropped on reload. Key on the
    // ROLE, and take the call id from the message when present; with none,
    // `attachToolResult` falls back to arrival order, as the reference does.
    //
    // The message is handled whole and then skipped: its output is one
    // message-level value, attached once to the call it answers, and it is that
    // card's output — never the turn's narration.
    if (it.role === "toolResult") {
      const result =
        typeof it.content === "string" ? it.content : it.content.map((b) => b.text ?? "").join("\n");
      if (result) {
        agent = { ...agent, blocks: attachToolResult(agent.blocks, it.toolCallId, result) };
        out[out.length - 1] = agent;
      }
      continue;
    }
    const blocks = typeof it.content === "string" ? [{ type: "text" as const, text: it.content }] : it.content;
    for (const b of blocks) {
      if (b.type === "text" && b.text) {
        const last = agent.blocks[agent.blocks.length - 1];
        agent =
          last?.kind === "text"
            ? { ...agent, blocks: [...agent.blocks.slice(0, -1), { ...last, text: `${last.text}\n\n${b.text}` }] }
            : { ...agent, blocks: [...agent.blocks, { kind: "text", text: b.text }] };
      } else if (b.type === "toolCall") {
        // A history call is born finished: its result, if it had one, is a
        // separate toolResult message handled above.
        agent = {
          ...agent,
          blocks: [
            ...agent.blocks,
            { kind: "tool", callId: b.id, name: b.name ?? "tool", args: fmtToolArgs(b.arguments), done: true },
          ],
        };
      }
    }
    out[out.length - 1] = agent;
  }
  return out;
}

// ── status line ──────────────────────────────────────────────────────────

export type StatusTone = "run" | "done" | "stopped" | "lost" | "error" | "wait";

export interface StatusLine {
  tone: StatusTone;
  /** An i18n key under cubepilot.chat.*. Typed as `MessageKey` rather than
   *  `string` so a typo is a compile error instead of the raw key being
   *  rendered into the header. The import is type-only, so this module stays
   *  free of any runtime dependency. */
  key: MessageKey;
  /** Interpolation values for that key. */
  vars?: Record<string, string | number>;
}

/**
 * The newest turn's own state. The header composes this with the states that
 * outrank it (stopping, a failed turn check, waiting on the user, running in
 * another tab).
 *
 * A lost transport is reported before the phase guard because a synthesized
 * terminal can arrive on a path where no event was ever seen, leaving the
 * message with no phase at all.
 */
export function turnStatus(msg: AgentMsg, now: number): StatusLine {
  if (msg.transportLost) return { tone: "lost", key: "cubepilot.chat.statusLost" };
  if (msg.phase === "done") {
    if (msg.stopped) return { tone: "stopped", key: "cubepilot.chat.statusStopped" };
    if (msg.error) return { tone: "error", key: "cubepilot.chat.statusFailed" };
    return { tone: "done", key: "cubepilot.chat.statusDone" };
  }
  const secs = Math.max(0, Math.round((now - msg.phaseAt) / 1000));
  if (msg.phase === "tools") {
    const running = msg.blocks.filter((b) => b.kind === "tool" && !b.done).length;
    // Every tool has returned and the model is digesting what they said. The
    // reference splits this out of "running tools" for the same reason:
    // "Running 0 tool(s)" is a sentence that describes nothing.
    return running > 0
      ? { tone: "run", key: "cubepilot.chat.statusTools", vars: { count: running, secs } }
      : { tone: "run", key: "cubepilot.chat.statusCollating", vars: { secs } };
  }
  if (msg.phase === "streaming") return { tone: "run", key: "cubepilot.chat.statusStreaming", vars: { secs } };
  return { tone: "run", key: "cubepilot.chat.statusThinking", vars: { secs } };
}

/**
 * Whether a restored transcript replaces what is on screen.
 *
 * An empty document never does: read on its own it means "this conversation has
 * not started", and the same read is what the follow loop takes when a turn it was
 * watching ends — adopting it then deletes that turn's output and cards in
 * exchange for nothing, because the runtime simply has not written them yet.
 *
 * Neither does ANY document over a thread that was handed over from the other
 * surface. That thread is the one the reader was just looking at, so it can be
 * AHEAD of the runtime — a turn still streaming, or one the writer has not caught
 * up with — and the pane's own restore is its first read, which makes that read the
 * one chance to drop it. Later reads (the follow loop) see the handoff spent and
 * adopt as usual.
 */
export function adoptsRestoredThread(restored: unknown[], handedOver: boolean): boolean {
  return restored.length > 0 && !handedOver;
}

/** True when the turn is parked on a human, in any part of the transcript. */
export function waitingOnUser(msgs: ThreadMsg[]): "approval" | "question" | null {
  const agentMsgs = msgs.filter((m) => m.role === "agent");
  if (agentMsgs.some((m) => openQuestions(m).length > 0)) return "question";
  if (agentMsgs.some((m) => openApprovals(m).length > 0)) return "approval";
  return null;
}
