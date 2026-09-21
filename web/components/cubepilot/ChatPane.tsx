"use client";

// 聊天 tab — the unified conversation surface for inference models and the
// CubePilot agent, mirroring public/chat.html: object list (gateway models
// + AI assistant) | chat card. The chat card fills the viewport height, the
// thread scrolls inside its own scrollbar, and the composer is a floating bar
// docked at the very bottom; sampling params (model mode) collapse into a
// chip in the composer's bottom row and open in a popover.
// There is no context rail: the instance phase/model line lives in the card
// header, and the config tab owns the policy/allowlist detail.
//
// Model side: the object list is the real model catalog from the AI Gateway
// (/api/cubepilot/playground/services → gateway /v1/models), and replies are
// real streamed completions proxied through /api/cubepilot/playground/chat
// (SSE).
//
// Agent side: the real CubePilot agent API (docs/cubepilot/api.md). The
// conversation is the SSE stream of POST /api/v1/messages proxied through
// /api/cubepilot/pilot; sessions, history, and the HITL approval/question
// channels are the same proxy. Instance status, the model in use, and the
// tool whitelist (platform skills) come from the agent CRs via the
// /api/cubepilot/agent/* + /api/cubepilot/skills routes. On (re)select the
// client restores the user's one fixed conversation (history + pending HITL
// cards) — see SESSION_KEY — and polls history while a turn is still in flight
// after a reload.

import { Box, Popover, SxProps, Theme } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  addApproval,
  applyAgentEvent,
  historyToMsgs,
  newAgentMsg,
  newApproval,
  newQuestion,
  openApprovals,
  openQuestions,
  turnStatus,
  waitingOnUser,
  type AgentApproval,
  type AgentMsg,
  type AgentQuestion,
  type StatusLine,
  type ThreadMsg,
} from "@/lib/cubepilot/agentThread";
import { PLATFORM_MODEL_NAME, displayModelName } from "@/lib/cubepilot/types";
import type {
  AgentConfig,
  AgentQuestionItem,
  AgentSseEvent,
  AgentStatus,
  GatewayModel,
  HistoryMessage,
  PendingApproval,
  SkillInfo,
} from "@/lib/cubepilot/types";
import { useI18n } from "@/lib/i18n";

import { HitlDock, type ApprovalDecision } from "./HitlDock";
import { CopyBtn, ParamsPanel, SampleParams } from "./Playground";
import { AgentThread } from "./AgentThread";
import { Btn, Card, CpTextArea, Icons, Pill, monoSx, useToast } from "./ui";

// The agent's identity colour is the violet globals.css derives from --accent,
// so the object list reads that token rather than hardcoding its own hue. The
// mix percentages are the prototype's (chat.html:169,163): the selected row's
// border is the strong 55%, deliberately not the agent bubble's --violet-bd
// (42%) — a row carries no tinted fill of its own, so the border alone has to
// say "selected".
const VIOLET_BORDER = "color-mix(in oklch, var(--violet) 55%, var(--border))";
const VIOLET_SOFT = "color-mix(in oklch, var(--violet) 9%, transparent)";
const ACCENT_FILL = "color-mix(in oklch, var(--accent) 82%, var(--fg))";

// The object list is a draggable pane: the column width is component state,
// and the resizer handle rides the 16px gutter between the two panes.
const LIST_COL_DEFAULT = 157;
const LIST_COL_MIN = 120;
const LIST_COL_MAX = 460;

const chatGridSx = (listW: number): SxProps<Theme> => ({
  display: "grid",
  gridTemplateColumns: `${listW}px 16px minmax(0,1fr)`,
  alignItems: "start",
  "@media (max-width: 1180px)": { gridTemplateColumns: "1fr" },
});

// 14px glyphs for the composer's sampling-params chip (DSH access-mode look).
const SLIDERS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
  </svg>
);
const CHEVRON_DOWN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const userMsgSx: SxProps<Theme> = {
  alignSelf: "flex-end",
  maxWidth: "82%",
  padding: "11px 14px",
  borderRadius: "var(--radius)",
  borderBottomRightRadius: 2,
  bgcolor: "text.primary",
  color: "background.default",
  fontSize: 13.5,
  lineHeight: 1.6,
};

const botMsgSx: SxProps<Theme> = {
  alignSelf: "flex-start",
  maxWidth: "82%",
  padding: "11px 14px",
  borderRadius: "var(--radius)",
  borderBottomLeftRadius: 2,
  bgcolor: "background.default",
  border: 1,
  borderColor: "divider",
  fontSize: 13.5,
  lineHeight: 1.65,
  wordBreak: "break-word",
};

/** One gateway-model reply. Agent turns are `AgentMsg` from
 *  lib/cubepilot/agentThread — the pane does not own their shape any more than
 *  it owns their rendering. */
interface ModelMsg {
  id: number;
  role: "model";
  text: string;
  meta?: string;
  notice?: boolean;
}

/** One row of the thread. */
type ChatMsg = ThreadMsg | ModelMsg;

/** The newest assistant turn — the one whose own state the card header reports
 *  when nothing outranks it. */
const newestAgent = (list: ThreadMsg[]): AgentMsg | undefined =>
  [...list].reverse().find((m): m is AgentMsg => m.role === "agent");

/** How each tone of the status line is dressed. `run` pulses, because a turn
 *  that is going somewhere is the one state that changes on its own. */
const STATUS_PILL = {
  run: "accent",
  done: "ok",
  stopped: "neutral",
  lost: "warn",
  error: "danger",
  wait: "warn",
} as const;

const groupLabelSx: SxProps<Theme> = {
  ...monoSx,
  fontSize: 10.5,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "text.secondary",
  pb: "6px",
  pl: "2px",
};

const enc = encodeURIComponent;

/** Fresh agent meta as returned by loadAgentMeta. */
interface AgentMeta {
  status: AgentStatus | null;
  config: AgentConfig | null;
  skills: SkillInfo[];
}

/**
 * The portal's conversation key — a LITERAL, deliberately.
 *
 * It was a key this browser invented and remembered in localStorage, and that
 * was wrong in a way a user noticed: localStorage is per browser PROFILE, so the
 * same person opening the portal in another browser (or after clearing site
 * data) started a SECOND conversation against the same agent instance. The
 * instance is already per user, so one fixed key means one conversation per
 * user, wherever they open it. (The reference's floating widget does exactly
 * this with a fixed `agent:main:conv-assistant`.)
 *
 * It also cannot collide with a run's session: those live under `…:cron:…` and
 * `…:task-…`, and picking from that list is what once broke the page open.
 */
const SESSION_KEY = "agent:main:conv-portal";

/** How long the follow loop waits between ticks. Short enough that a turn
 *  running in another window looks live; long enough that an idle conversation
 *  is one small GET every few seconds. */
const FOLLOW_INTERVAL_MS = 3000;

export function ChatPane() {
  const { t } = useI18n();
  const { showToast, toastView } = useToast();

  const [models, setModels] = useState<GatewayModel[]>([]);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [objKind, setObjKind] = useState<"model" | "agent" | null>(null);
  const [svcId, setSvcId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  /** Partial reply text while the model SSE stream is in flight; null = idle. */
  const [streaming, setStreaming] = useState<string | null>(null);
  const [copied, setCopied] = useState<"endpoint" | null>(null);
  const [params, setParams] = useState<SampleParams>({ temperature: 0.7, topP: 0.9, maxTokens: 1024 });
  /** Anchor of the sampling-params popover; null = the chip is collapsed. */
  const [paramsAnchor, setParamsAnchor] = useState<HTMLElement | null>(null);
  /** Object-list column width in px; dragged with the pane resizer. */
  const [listW, setListW] = useState(LIST_COL_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef({ x: 0, w: 0 });

  const startResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    resizeStart.current = { x: e.clientX, w: listW };
    setResizing(true);
  };

  // While resizing: track the pointer on window, clamp the column width, and
  // keep the drag from selecting text or scrolling the page (touch).
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent): void => {
      const next = resizeStart.current.w + (e.clientX - resizeStart.current.x);
      setListW(Math.min(LIST_COL_MAX, Math.max(LIST_COL_MIN, next)));
    };
    const onUp = (): void => setResizing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [resizing]);

  // Agent (CubePilot) state — real data from the agent CRs + agent API.
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  // Seeded with the fixed key, never null: a send that found it null would
  // mint a NEW session and quietly leave the user with two conversations again.
  const [agentSessionKey, setAgentSessionKey] = useState<string | null>(SESSION_KEY);
  const [agentNotice, setAgentNotice] = useState("");
  /** A turn is running for this session with no stream of this pane's own — one
   *  another tab started, or one that outlived a reload. The card header says
   *  so and the composer's Stop is the control that ends it. */
  const [runningElsewhere, setRunningElsewhere] = useState(false);
  /** The /turn read itself failed, so whether a turn is running is simply
   *  unknown. Kept apart from `runningElsewhere` so the header never claims a
   *  turn nobody confirmed — and never offers a Stop that would fail for the
   *  same reason the check did. */
  const [turnCheckFailed, setTurnCheckFailed] = useState(false);
  /** A stop of that turn is in flight. The server answers /abort only once the
   *  session has settled, so this is a long wait with nothing else moving: the
   *  header reports it for the whole of it. */
  const [stoppingElsewhere, setStoppingElsewhere] = useState(false);
  /** The instance's confirm policy is Allowlist, so a durable approval would
   *  mean something. False until read (and false when the read fails): the
   *  "always allow" button offers a rule that would not apply otherwise. */
  const [allowAlwaysOk, setAllowAlwaysOk] = useState(false);
  /** The 1s ticker's clock. A question's countdown is derived from it, so it has
   *  to move for the card to lock itself up when the gateway's timeout runs out. */
  const [now, setNow] = useState(() => Date.now());
  /** A "clear this conversation" is in flight. The server answers only once the
   *  session's turn has been stopped and its stream released, so the wait can run
   *  to tens of seconds with nothing else on the page moving. */
  const [clearing, setClearing] = useState(false);

  // Only while a turn is unfinished, or while a parked question still has a
  // countdown to run: those are the only things on this page that need a
  // second-by-second clock, and an idle page must not re-render every second for
  // nothing. A question restored after a reload hangs off a turn that is `done`
  // — it is parked, not running — so without the second clause its expiry never
  // fires and its controls stay live past the deadline the gateway set.
  const anyLive =
    msgs.some((m) => m.role === "agent" && m.phase !== "done") ||
    msgs.some(
      (m) =>
        m.role === "agent" &&
        m.questions.some((q) => (q.state === "pending" || q.state === "submitting") && q.deadline !== undefined),
    ) ||
    // ...and for a held write with an expiry of its own: the gateway drops the
    // record when it passes, so its card counts down too.
    msgs.some(
      (m) =>
        m.role === "agent" &&
        m.approvals.some((a) => (a.state === "pending" || a.state === "deciding") && a.expiresAtMs !== undefined),
    );
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyLive]);

  const inputEl = useRef<HTMLTextAreaElement | null>(null);
  const threadEl = useRef<HTMLDivElement | null>(null);
  // The thread always follows the newest content. requestAnimationFrame so the
  // new block is laid out before the scroll is measured; there is deliberately
  // no "user scrolled up" suppression, matching the reference.
  useEffect(() => {
    const el = threadEl.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [msgs]);
  /** The composer's sampling-params chip; anchors the params popover. */
  const paramsChipRef = useRef<HTMLButtonElement | null>(null);
  // Guards against in-flight fetch/stream from a previous object.
  const genRef = useRef(0);
  const idRef = useRef(0);
  /** The session follow loop; runs for as long as a conversation is on screen.
   *  One pending tick — the loop schedules its next one, so there is at most
   *  this one in flight. */
  const turnPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The raw history document last rendered, so the follow loop can skip a
   *  re-render (and a re-scroll) when the server's copy has not moved. */
  const lastHistoryRef = useRef<string>("");
  /** The follow loop's own generation, separate from `genRef`.
   *
   *  `genRef` is bumped by anything that invalidates in-flight work for the
   *  object on screen — including a send, which starts a new stream. The follow
   *  loop is not that work: it watches the SESSION, and a send does not end the
   *  conversation. Riding on `genRef` meant the first message a user sent killed
   *  the loop for good, so the pane went back to never noticing anything that
   *  happened without it — the bug the loop exists to fix, reintroduced by the
   *  send that follows it. */
  const followGenRef = useRef(0);
  /** True from the moment this pane drives a turn until the server says that turn
   *  has stopped running. While it holds, this pane's own view of the turn is the
   *  truth — its stream wrote it — and the follow loop must not replace it with
   *  the history document, which carries no HITL cards and cannot say that a
   *  stream died. */
  const ownTurnRef = useRef(false);
  /** Whether the follow loop has been adopting the history document for the turn
   *  it is watching now. Only a turn this pane did NOT author is watched that
   *  way, and its terminal read is what completes that transcript. */
  const followingRef = useRef(false);

  const svc = models.find((s) => s.id === svcId) ?? null;
  const endpointText = endpoint ? `${endpoint}/v1/chat/completions` : "";
  const isModel = objKind === "model";
  const isAgent = objKind === "agent";

  const nextId = useCallback((): number => {
    idRef.current += 1;
    return idRef.current;
  }, []);

  function autoGrow() {
    const el = inputEl.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  function stopTurnPolling(): void {
    if (turnPollRef.current) {
      clearTimeout(turnPollRef.current);
      turnPollRef.current = null;
    }
  }

  function cancelInflight(): void {
    genRef.current++;
    followGenRef.current++;
    stopTurnPolling();
    // The turn and its follow state describe the session this pane is leaving.
    ownTurnRef.current = false;
    followingRef.current = false;
    lastHistoryRef.current = "";
    setStreaming(null);
    setThinkingText(null);
    // `sending` too: both sides clear it in a generation-guarded `finally`, so
    // the send in flight here can never clear it — the generation it checks
    // against was just bumped. Left set, the Send of the object the user moved
    // TO stays disabled until a reload. The agent side's stop-then-send await
    // makes that window seconds long rather than milliseconds.
    setSending(false);
    // The no-stream turn state describes the session this pane is leaving. It
    // is retired with it, so a reload of another object cannot inherit a "still
    // running" that was never about it.
    setRunningElsewhere(false);
    setTurnCheckFailed(false);
    setStoppingElsewhere(false);
  }

  function selectModel(modelId: string): void {
    const next = models.find((m) => m.id === modelId);
    if (!next) return;
    selectModelService(next);
  }

  /** Point the chat at a gateway model (the mount path has it directly). */
  function selectModelService(next: GatewayModel | undefined): void {
    if (!next) return;
    cancelInflight();
    setObjKind("model");
    setSvcId(next.id);
    setMsgs([
      { id: nextId(), role: "model", text: t("cubepilot.playground.switched", { name: next.id }), notice: true },
    ]);
  }

  /**
   * The agent's real meta (instance status, config, skills) from the agent
   * CRs. Returns the fresh values (the state they set is one render stale
   * inside the calling async flow).
   */
  async function loadAgentMeta(): Promise<AgentMeta> {
    try {
      const [stRes, cfgRes, skRes] = await Promise.all([
        fetch("/api/cubepilot/agent/status"),
        fetch("/api/cubepilot/agent/config"),
        fetch("/api/cubepilot/skills"),
      ]);
      const [stBody, cfgBody, skBody] = await Promise.all([
        stRes.json().catch(() => null),
        cfgRes.json().catch(() => null),
        skRes.json().catch(() => null),
      ]);
      if (!stRes.ok) throw new Error((stBody as { error?: string } | null)?.error ?? `HTTP ${stRes.status}`);
      // The agent meta is global (the object list entry + the card header),
      // not part of the conversation generation: apply it even when a model
      // auto-selection bumped that generation while these requests were in
      // flight (otherwise the object entry stays "loading" forever).
      const status = stBody as AgentStatus;
      const config = cfgRes.ok ? ((cfgBody as { config?: AgentConfig } | null)?.config ?? null) : null;
      const skills = skRes.ok ? ((skBody as { skills?: SkillInfo[] } | null)?.skills ?? []) : [];
      setAgentStatus(status);
      // config and skills travel in the returned meta and are read from there;
      // they used to have state of their own, which only the agent branch of
      // clearChat read, and that branch is gone with the fixed session key.
      return { status, config, skills };
    } catch {
      return { status: null, config: null, skills: [] };
    }
  }

  /** The greeting (real data: instance, model, whitelist size).
   *
   *  The greeting and its footnote are two text blocks of one agent turn: the
   *  model carries no per-message meta line, and the footnote is not a turn
   *  outcome either — it is the second thing the greeting says. */
  function greetingMsgs(status: AgentStatus | null, config: AgentConfig | null, skills: SkillInfo[]): ChatMsg[] {
    const greeting = !status?.exists
      ? t("cubepilot.chat.greetingNoInstance")
      : t("cubepilot.chat.greeting", {
          tools: String(skills.length),
          model: displayModelName(config?.selectedModel || PLATFORM_MODEL_NAME),
        });
    return [
      {
        ...newAgentMsg(nextId()),
        // Nothing is running: the greeting says what the agent is looking at, so
        // its turn is already told. Leaving it unfinished would start the ticker
        // and report a live turn that does not exist.
        phase: "done",
        blocks: [
          { kind: "text", text: greeting },
          { kind: "text", text: t("cubepilot.chat.greetingMeta") },
        ],
      },
    ];
  }

  /** Read the instance's confirm policy once, which decides whether the durable
   *  "always allow" decision is worth offering at all. A read that fails leaves
   *  it off: the button promises a rule that will stop the asking, and a promise
   *  that might not hold is worse than a button the user never sees. */
  async function loadConfirmPolicy(): Promise<void> {
    try {
      const res = await fetch("/api/cubepilot/agent/confirm");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { confirmPolicy?: string };
      setAllowAlwaysOk(body.confirmPolicy === "Allowlist");
    } catch {
      setAllowAlwaysOk(false);
    }
  }

  function selectAgent(): void {
    cancelInflight();
    setObjKind("agent");
    setSvcId(null);
    setMsgs([]);
    // The key is NOT cleared. It is a literal, not a session this pane has to
    // discover, and the composer is live from the line above while the restore
    // below is asynchronous: a send in that window captured null, went out
    // without a session id, and the API minted a session of its own — a second
    // conversation for a user who is supposed to have exactly one.
    setAgentNotice("");
    void (async () => {
      const gen = genRef.current;
      const meta = await loadAgentMeta();
      if (genRef.current !== gen) return;
      if (meta.status?.exists) {
        await restoreAgentSession(meta);
      } else {
        setMsgs(greetingMsgs(meta.status, meta.config, meta.skills));
      }
    })();
  }

  /**
   * Restore this user's conversation after a (re)select: history, an in-flight
   * turn (history polling), and any pending HITL cards.
   *
   * The key is the fixed SESSION_KEY, so every browser this user opens lands on
   * the same conversation. The runtime's session LIST is never consulted: it also
   * carries the runtime's own sessions (`…:cron:…`, `…:task-…`) whose keys belong
   * to a run, and restoring one of those makes the gateway refuse with
   * "…is owned by …:run:…, not …" — which is what a user saw on opening this
   * page. A key we chose cannot name one of them.
   */
  async function restoreAgentSession(meta: AgentMeta): Promise<void> {
    const gen = genRef.current;
    const key = SESSION_KEY;
    setAgentSessionKey(key);
    const hadHistory = await loadAgentHistory(key);
    if (genRef.current !== gen) return;
    // Nothing under this key yet: a conversation has not started, so greet. An
    // empty thread with no prompt is the one thing a first-time visitor must not
    // see — it reads as a chat that lost its contents.
    if (!hadHistory) setMsgs(greetingMsgs(meta.status, meta.config, meta.skills));
    const running = await checkTurnElsewhere(key, gen);
    if (genRef.current !== gen) return;
    if (running) {
      setAgentNotice(t("cubepilot.chat.turnActive"));
      // Armed, so that the terminal read that clears the notice and completes the
      // transcript is taken even if the turn ends before the loop's first tick.
      followingRef.current = true;
    }
    startFollowing(key);
    await restorePendingHitl(key);
  }

  /**
   * Ask the server whether the session still has a turn in flight — the only
   * signal that survives a reload, since this pane then has no stream to
   * consult. Answers with what it found, because the state it sets is one
   * render stale inside the async flow that calls it.
   *
   * Never folded into "not running": the route answers 502 exactly when it
   * could not determine the answer, and a check that failed is reported as
   * that rather than as a quiet conversation.
   */
  async function checkTurnElsewhere(key: string, gen: number): Promise<boolean> {
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/turn`);
      if (genRef.current !== gen) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { active } = (await res.json()) as { active?: boolean };
      if (genRef.current !== gen) return false;
      setRunningElsewhere(active === true);
      setTurnCheckFailed(false);
      return active === true;
    } catch {
      if (genRef.current !== gen) return false;
      setRunningElsewhere(false);
      setTurnCheckFailed(true);
      return false;
    }
  }

  /** Re-ask after a failed check. Without it the "could not check" status would
   *  have no way back to an answer short of leaving the conversation. */
  function retryTurnCheck(): void {
    if (!agentSessionKey) return;
    setTurnCheckFailed(false);
    void checkTurnElsewhere(agentSessionKey, genRef.current);
  }

  /** Withdraw the status on request. Retry is the way back to an answer, not a
   *  way out of it: for a channel this pane cannot use, every retry fails the
   *  same way and the status would sit in the header of an otherwise working
   *  conversation with no control that removes it. Dismissing claims nothing —
   *  a reload, a session switch or a send all ask again. */
  function dismissTurnCheck(): void {
    setTurnCheckFailed(false);
  }

  /** Load a session's history; answers whether there was any. An empty history
   *  is a conversation that has not started, which the caller greets rather than
   *  drawing as a blank thread. */
  async function loadAgentHistory(key: string): Promise<boolean> {
    const gen = genRef.current;
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/messages`);
      // 404 is "this conversation has not started", which is an ordinary empty
      // thread and NOT a failure (docs/cubepilot/api.md §4.3). Reporting it would
      // make a brand-new conversation look like an erased one.
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { items?: HistoryMessage[] };
      if (genRef.current !== gen) return true;
      const items = body.items ?? [];
      lastHistoryRef.current = JSON.stringify(items);
      const restored = historyToMsgs(items, nextId);
      // An empty document never replaces what is on screen. Read on its own it
      // means "this conversation has not started", and the caller greets — but
      // this same read is what the follow loop takes when a turn it was watching
      // ENDS, and there the view already holds that turn's output and its cards.
      // Empty then means the runtime has not written it yet, or is a read that
      // raced the writer; adopting it deletes the turn in exchange for nothing.
      if (restored.length > 0) setMsgs(restored);
      return restored.length > 0;
    } catch {
      if (genRef.current === gen) setAgentNotice(t("cubepilot.chat.historyUnavailable"));
      return true; // a failed read is not "an unstarted conversation"
    }
  }

  /** Re-attach cards the turn is currently blocked on (required after reload). */
  async function restorePendingHitl(key: string): Promise<void> {
    const gen = genRef.current;
    /** A card with no turn in the thread to hang it on gets its own bubble. The
     *  phase is `done`, never the constructor's `thinking`: this turn is PARKED,
     *  not running, and a live phase would start the 1 Hz ticker and paint a
     *  "thinking" bubble for a turn that is waiting on a human. */
    const attachToNewest = (patch: (m: AgentMsg) => AgentMsg): void => {
      setMsgs((m) => {
        const lastIdx = [...m].reverse().findIndex((x) => x.role === "agent");
        if (lastIdx < 0) return [...m, patch({ ...newAgentMsg(nextId()), phase: "done" })];
        const i = m.length - 1 - lastIdx;
        return m.map((x, xi) => (xi === i && x.role === "agent" ? patch(x) : x));
      });
    };
    const attachApproval = (a: PendingApproval) => {
      // The card belongs to the turn it was raised in — the newest one here,
      // since restore happens before anything else can arrive.
      const card = newApproval({ ...a, name: a.tool });
      // Through the fold's own add, so a stream event that already described
      // this approval is not doubled by the read that describes it again.
      attachToNewest((x) => addApproval(x, card));
    };
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/approval/pending`);
      if (res.ok && genRef.current === gen) {
        // A LIST: the gateway can be holding several for one session, and the
        // oldest is not the only one this pane has to offer.
        const { approvals } = (await res.json()) as { approvals?: PendingApproval[] };
        for (const a of approvals ?? []) {
          if (a.approvalId) attachApproval(a);
        }
      }
      // 404 = no pending approval: silent by contract.
    } catch {
      /* silent */
    }
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/question/pending`);
      // This endpoint's 404 IS "nothing is pending", not a failed read: its body
      // is defined as {"error":"no pending question"}. Anything else is a read
      // that failed, and it is thrown so that it is reported rather than folded
      // into "idle".
      if (res.status !== 404 && !res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.ok && genRef.current === gen) {
        const { questions } = (await res.json()) as {
          questions?: Array<{ id?: string; questions?: AgentQuestionItem[]; timeoutSeconds?: number }>;
        };
        for (const q of questions ?? []) {
          if (!q.id) continue;
          // Through the same constructor the streamed card uses: the response
          // carries what is LEFT of the gateway's deadline, and dropping it left
          // a reloaded question with no countdown and its controls live past the
          // point the gateway had given it.
          const card = newQuestion(q.id, q.questions ?? [], q.timeoutSeconds, Date.now());
          attachToNewest((x) => ({ ...x, questions: [...x.questions, card] }));
        }
      }
    } catch (e) {
      // The read failed, so whether the agent is parked on a question is simply
      // unknown. Staying silent would leave a parked turn looking idle, with no
      // card anywhere — the dock is the only place a live card is drawn — and
      // no way to answer it. The reference says so for the same reason.
      if (genRef.current === gen) {
        setMsgs((m) => [
          ...m,
          { ...newAgentMsg(nextId()), phase: "done", error: t("cubepilot.chat.pendingQuestionUnavailable", { error: String(e) }) },
        ]);
      }
    }
  }

  /**
   * Re-read the history, but only re-render when the server's copy actually
   * moved. A naive reload every 3s would hand `msgs` a new array each time, and
   * the thread's autoscroll keys on it — the reader would be yanked to the bottom
   * mid-scrollback for the whole length of a turn.
   */
  async function refreshHistoryIfChanged(key: string): Promise<void> {
    const gen = genRef.current;
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/messages`);
      if (!res.ok) return;
      const body = (await res.json()) as { items?: HistoryMessage[] };
      if (genRef.current !== gen) return;
      // Re-read the ref rather than trusting the caller's earlier read: a tick
      // that started as a follower can still be waiting on this fetch when the
      // user sends, and replacing the transcript then would take the bubble the
      // stream is writing to with it — every later event would be applied to an
      // id no longer in the list, and the turn would show nothing at all.
      if (ownTurnRef.current) return;
      // An empty read is not something to adopt. A turn's transcript is never
      // empty once it has said anything, so an empty one means the runtime has
      // not written it yet — and replacing the view with it would delete the
      // stream's own output (and the cards it raised) in exchange for nothing.
      // Skipping costs one stale tick; adopting costs the turn.
      const items = body.items ?? [];
      if (items.length === 0) return;
      const raw = JSON.stringify(items);
      if (raw === lastHistoryRef.current) return;
      lastHistoryRef.current = raw;
      setMsgs(historyToMsgs(items, nextId));
    } catch {
      /* a dropped poll is not an error; the next one re-reads */
    }
  }

  /**
   * Watch the conversation for as long as it is the one on screen.
   *
   * The pane cannot infer the conversation's state from its own stream, because
   * the conversation belongs to the user and not to this tab: any of their other
   * windows can move it, and a run this pane started can outlive the stream that
   * started it. A pane that stops watching once it believes nothing is running
   * therefore stops updating for good — which is what a user saw: a transcript
   * frozen half an hour back, a header saying the last turn had finished while a
   * turn was running, and the approval the agent was parked on never drawn. It
   * went unanswered, the run was aborted for being stuck, and the agent's own
   * reply complained the command "被中断" — twice.
   *
   * Idle ticks cost one small GET; the history is only re-read while a turn is
   * actually running, and only re-rendered when the server's copy has moved.
   *
   * Each tick schedules the next one when it is done, rather than the loop being
   * driven by an interval. An interval fires on its own clock whatever the last
   * tick is doing, so a read slower than the period overlaps with the next one —
   * and the two can land in either order, the older snapshot replacing the newer
   * and the transcript running backwards until a later tick repairs it. A chain
   * cannot overlap: there is never more than one read in flight.
   */
  function startFollowing(key: string): void {
    stopTurnPolling();
    const gen = followGenRef.current;

    const tickOnce = async (): Promise<void> => {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/turn`);
      if (!res.ok || followGenRef.current !== gen) return;
      const { active } = (await res.json()) as { active?: boolean };
      if (followGenRef.current !== gen) return;
      if (ownTurnRef.current) {
        // A turn this pane started. Its stream is the state, and the history
        // document is no substitute: it holds no approval or question cards, so
        // adopting it would delete the cards the reader is looking at, and it
        // cannot say that the stream died. The one thing a stream that has
        // already ended cannot tell the pane is whether the run is still going,
        // and that is all this read is for.
        if (active !== true) ownTurnRef.current = false;
        return;
      }
      if (active === true) {
        setRunningElsewhere(true);
        // Keep the transcript moving while the turn runs. Without this the view
        // is frozen until the turn ENDS — which is what a reader sees when the
        // turn was started in ANOTHER browser (one fixed key means one
        // conversation, so that is now the ordinary case) or after their own
        // stream died. The runtime writes a running turn into the history as it
        // goes, so re-reading it is what makes the output appear at all.
        followingRef.current = true;
        await refreshHistoryIfChanged(key);
        return;
      }
      // A poll that fails is not the header's "could not check": the status is
      // already the server's own answer, and one dropped request in a 3s rhythm
      // is not worth replacing it with an alarm. Only a definite "nothing is
      // running" retires the state.
      setRunningElsewhere(false);
      if (followingRef.current) {
        followingRef.current = false;
        setAgentNotice("");
        await loadAgentHistory(key);
        await restorePendingHitl(key);
      }
    };

    const tick = async (): Promise<void> => {
      if (followGenRef.current !== gen) return;
      try {
        await tickOnce();
      } catch {
        /* keep polling */
      }
      // The single place that decides whether the loop lives on, and it asks the
      // loop's OWN generation: a session switch, a clear or a stop bumps it, and
      // a tick already in flight must not schedule a successor for a
      // conversation this pane has left. A send is not one of those — the
      // conversation outlives it.
      if (followGenRef.current === gen) {
        turnPollRef.current = setTimeout(() => void tick(), FOLLOW_INTERVAL_MS);
      }
    };

    turnPollRef.current = setTimeout(() => void tick(), FOLLOW_INTERVAL_MS);
  }

  /** Load the gateway model catalog; on first load select the first model. */
  async function loadModels(): Promise<void> {
    try {
      const res = await fetch("/api/cubepilot/playground/services");
      const body = (await res.json().catch(() => null)) as
        | { models?: GatewayModel[]; endpoint?: string | null; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setModels(body?.models ?? []);
      setEndpoint(body?.endpoint ?? null);
      // The catalog is global — the object list and the endpoint line, neither
      // of which a selection changes — so it is applied whether or not the
      // generation moved while it was in flight, exactly like the agent meta
      // below. It used to ride on that generation, and the mount effect's
      // selection then cancelled the fetch: the list came back empty.
      //
      // Nothing is selected here either. The object the page opens on is the
      // assistant, chosen in the mount effect; which model is "first" is the
      // gateway's order, not a choice.
    } catch (e) {
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
    }
  }

  // Mount-only: t's identity changes every render (useI18n), and the fetched
  // data is locale-neutral, so a load-once effect is what we want.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    void loadModels();
    void loadAgentMeta();
    // The page opens on the assistant. It is the one object here that is not a
    // model, and it is the one this page's own entry is about; a model can be
    // picked from the list below it.
    selectAgent();
    // The policy that decides whether a durable approval is on offer: read once,
    // like the rest of the instance meta.
    void loadConfirmPolicy();
    return () => {
      cancelInflight();
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  /** Clear the MODEL side's local transcript. It is offered only there: the
   *  agent's history lives in the runtime, under one fixed key, so "clear" could
   *  not mean anything for it — dropping the local copy would just bring the
   *  same conversation back on the next select or reload, which is worse than
   *  no button. A button the feature cannot honour is a button that lies. */
  function clearChat(): void {
    if (!isModel) return;
    cancelInflight();
    if (svc) setMsgs([{ id: nextId(), role: "model", text: t("cubepilot.playground.cleared"), notice: true }]);
  }

  /**
   * Start this conversation over (cubepilot #214).
   *
   * The agent's transcript lives in the runtime under one fixed key, so a local
   * "clear" means nothing here — the next read brings the same conversation
   * back. The only thing that does mean something for a fixed key is deleting it
   * server-side, which is what this does; the server stops any turn still running
   * on it and waits for its stream to release before answering.
   *
   * It asks first. The record is gone for good, and there is no undo to offer
   * afterwards — so the question is the last moment the choice can be made.
   *
   * A 409 means a turn is still active: the composer's Stop is the control for
   * that, and the server's own message says so. A 504 means the delete may have
   * landed anyway; the call is idempotent, so trying again is the whole recovery.
   */
  async function clearAgentSession(): Promise<void> {
    const key = agentSessionKey;
    if (!key || clearing) return;
    if (!window.confirm(t("cubepilot.chat.clearConfirm"))) return;
    setClearing(true);
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}`, { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      // Everything on screen described the session that is now gone: its
      // stream, its poll and its cards all belong to it, and none of them can
      // be asked to forget it. Tearing them down and restoring is the path a
      // fresh page takes, and it greets when there is no history left to draw.
      cancelInflight();
      await restoreAgentSession(await loadAgentMeta());
    } catch (e) {
      showToast(t("cubepilot.failed", { error: e instanceof Error ? e.message : String(e) }), "error");
    } finally {
      setClearing(false);
    }
  }

  function copyText(text: string, which: "endpoint"): void {
    const done = () => {
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1400);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  }

  // ── agent conversation (real SSE via the pilot proxy) ───────────────────

  /** Apply one SSE event to the in-flight agent message.
   *
   *  The fold itself is `applyAgentEvent` (lib/cubepilot/agentThread): what an
   *  event means to a turn — text order, tool pairing, how a card settles when a
   *  decision's `approved` field is absent — is model behaviour, and it is the
   *  same behaviour the dock and the thread are drawn from. What is left here is
   *  only what the event means to the PANE: which session it belongs to, and that
   *  the model-side "thinking" indicator is over. */
  function handleAgentEvent(evt: AgentSseEvent, msgId: number): void {
    if (evt.type === "message_start") setAgentSessionKey(evt.sessionId);
    if (evt.type !== "agent_thinking" && evt.type !== "message_start" && evt.type !== "message_done") setThinkingText(null);
    setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? applyAgentEvent(x, evt) : x)));
  }

  async function sendAgent(text: string, gen: number, msgId: number): Promise<void> {
    let gotDone = false;
    // The session this stream turned out to be for. A brand-new chat has no id
    // at send time — the server mints one and reports it in `message_start` —
    // and `agentSessionKey` is the value the RENDER that started this send
    // captured, which is null for a first message. The stream-lost path below
    // needs the id the stream actually reported, or a lost first stream skips
    // the re-check and leaves the header saying "connection lost" with no Stop,
    // while the next send goes straight to POST /messages and meets the 409 (or
    // is steered into the running turn) that the stop-first route exists to
    // prevent.
    let sessionOfTurn: string | null = null;
    try {
      const res = await fetch("/api/cubepilot/pilot/api/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, ...(agentSessionKey ? { sessionId: agentSessionKey } : {}) }),
      });
      if (!res.ok) {
        // Request-phase failure (400/409/503-warming): surfaced as an error
        // on the agent bubble, not a toast (the stream itself carries turn
        // errors as events).
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error(t("cubepilot.chat.emptyStream"));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (genRef.current !== gen) {
          try {
            await reader.cancel();
          } catch {
            /* already closed */
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue; // ": ping" comments too
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt: AgentSseEvent;
          try {
            evt = JSON.parse(payload) as AgentSseEvent;
          } catch {
            continue;
          }
          if (evt.type === "message_start") sessionOfTurn = evt.sessionId;
          if (evt.type === "message_done") gotDone = true;
          if (genRef.current === gen) handleAgentEvent(evt, msgId);
        }
      }
      // The stream ended without the terminal event. That is a transport
      // failure, not a turn outcome: the run may still be executing on the
      // server, so nothing here may end the turn or settle the cards it left
      // parked. The reason is kept on the bubble for diagnostics — the line the
      // user reads is the header's own "connection lost" — and the run is
      // re-checked, because the server is the only thing that can say whether
      // it is still going.
      if (!gotDone && genRef.current === gen) {
        const reason = t("cubepilot.chat.streamLost");
        setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, transportLost: reason } : x)));
        // The stream WAS this pane's view of the turn, and it is gone. Hand the
        // turn to the follow loop: from here the transcript is the only thing
        // that can say what the run did, and while the run is still going the
        // loop keeps reading it. Without this the pane sits on whatever the
        // stream left behind, reporting "still running", while the run it is
        // describing produces everything else unseen. The marker above is the
        // one thing that gives way to that — the header's own line is what says
        // the transport was lost, and the transcript replaces the frozen bubble
        // with what actually happened.
        ownTurnRef.current = false;
        followingRef.current = true;
        // The id the STREAM reported when it has one: this closure's
        // `agentSessionKey` is the send-time render's, which names no session
        // for a first message.
        const key = sessionOfTurn ?? agentSessionKey;
        if (key) void checkTurnElsewhere(key, gen);
      }
    } catch (e) {
      if (genRef.current === gen) {
        setThinkingText(null);
        setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, error: String(e instanceof Error ? e.message : e) } : x)));
      }
    }
  }

  // ── HITL actions ──

  /** Patch one card wherever it lives in the transcript. Cards are identified by
   *  their call id, which is what the dock and the thread both carry, and a call
   *  belongs to exactly one turn. */
  const patchApproval = useCallback(
    (callId: string, fn: (a: AgentApproval) => AgentApproval): void => {
      setMsgs((list) =>
        list.map((x) => (x.role === "agent" ? { ...x, approvals: x.approvals.map((a) => (a.callId === callId ? fn(a) : a)) } : x)),
      );
    },
    [],
  );
  const patchQuestion = useCallback(
    (callId: string, fn: (q: AgentQuestion) => AgentQuestion): void => {
      setMsgs((list) =>
        list.map((x) => (x.role === "agent" ? { ...x, questions: x.questions.map((q) => (q.callId === callId ? fn(q) : q)) } : x)),
      );
    },
    [],
  );

  async function decideApproval(callId: string, decision: ApprovalDecision): Promise<void> {
    if (!agentSessionKey) return;
    // Optimistic: the click answers a card the turn is blocked on, so it must
    // look like it landed immediately.
    patchApproval(callId, (a) => ({ ...a, state: "deciding", error: undefined }));
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(agentSessionKey)}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The id is required: a session can hold several pending approvals, and
        // the server will not pick one for us — an un-named decision is a 400.
        body: JSON.stringify({ approvalId: callId, decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 404 || res.status === 409) {
          // The record is gone or was decided elsewhere while this click was in
          // flight: the turn ended, it expired, or another client answered it
          // first. Nobody decided HERE, which is the neutral "stopped" —
          // reporting the user's own click as a rejection would attribute to
          // them a decision the server refused.
          patchApproval(callId, (a) => ({ ...a, state: "stopped", error: undefined }));
          return;
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as { allowlisted?: boolean; approvalId?: string } | null;
      // The approval this settled is the one that was named. A server that
      // answered for a different one would have let a write through that the
      // user never chose, which is the failure the id exists to prevent — so it
      // is reported rather than recorded as this card's decision.
      if (body?.approvalId && body.approvalId !== callId) {
        patchApproval(callId, (a) => ({ ...a, state: "stopped", error: t("cubepilot.chat.approvalWrongRecord", { id: body.approvalId ?? "" }) }));
        return;
      }
      // The approval_resolved event normally follows on the stream; when the
      // stream is already closed the response is the only outcome signal.
      patchApproval(callId, (a) => (a.state === "deciding" ? { ...a, state: decision === "reject" ? "rejected" : "approved" } : a));
      if (decision === "allow-always" && body?.allowlisted !== true) {
        // The approval took; the durable rule did not. Calling that a success
        // would tell the user it will not ask again, and it will.
        showToast(t("cubepilot.chat.approvalNotAllowlisted"), "error");
      }
    } catch (e) {
      // The card stays answerable, with the reason on it: a toast would leave it
      // looking like nothing had happened, and the user would click again.
      patchApproval(callId, (a) => ({ ...a, state: "pending", error: String(e instanceof Error ? e.message : e) }));
    }
  }

  /**
   * Re-read the session's pending questions after a refused answer.
   *
   * The refusal (404/409) does not say WHY, and guessing is what loses an
   * answer: if the question is still open, the answer was not accepted and the
   * card must stay open for another try, with the server's own fresh deadline;
   * only a question that is really gone is over, and only then is "expired" a
   * statement about anything.
   */
  async function reopenOrExpireQuestion(callId: string): Promise<void> {
    if (!agentSessionKey) return;
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(agentSessionKey)}/question/pending`);
      if (res.status === 404) {
        // This endpoint's 404 IS the "gone" signal, not a failed read: its body
        // is defined as {"error":"no pending question"} — "the question is not
        // there", the same condition an empty list reports. Reading it as a
        // refresh failure would park the card in pending for the rest of the
        // session behind a retry that can never succeed.
        patchQuestion(callId, (q) => ({ ...q, state: "expired", error: undefined }));
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { questions } = (await res.json()) as {
        questions?: Array<{ id?: string; questions?: AgentQuestionItem[]; timeoutSeconds?: number }>;
      };
      const still = (questions ?? []).find((q) => q.id === callId);
      if (still) {
        patchQuestion(callId, (q) => ({
          ...q,
          state: "pending",
          // The gateway's remainder, not this browser's stale one — and cleared
          // outright when the list entry carries none, because that entry is
          // authoritative: keeping the old deadline would lock the card up
          // (isExpiring) while the gateway still calls the question open.
          deadline: still.timeoutSeconds ? Date.now() + still.timeoutSeconds * 1000 : undefined,
          error: t("cubepilot.chat.questionNotAccepted"),
        }));
        return;
      }
      patchQuestion(callId, (q) => ({ ...q, state: "expired", error: undefined }));
    } catch {
      // The re-read itself failed (network, 5xx), so "gone" is not established
      // either. Only a CONFIRMED gone settles the card: a transient failure that
      // hid the controls would leave the user unable to answer a question the
      // agent is still parked on.
      patchQuestion(callId, (q) => ({ ...q, state: "pending", error: t("cubepilot.chat.questionRefreshFailed") }));
    }
  }

  async function submitQuestion(callId: string, answers: Record<string, string[]>, cancel: boolean): Promise<void> {
    if (!agentSessionKey) return;
    patchQuestion(callId, (q) => ({ ...q, state: "submitting", answers: cancel ? q.answers : answers, error: undefined }));
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(agentSessionKey)}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: callId, ...(cancel ? { cancel: true } : { answers }) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 404 || res.status === 409) {
          await reopenOrExpireQuestion(callId);
          return;
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      patchQuestion(callId, (q) => ({ ...q, state: cancel ? "cancelled" : "answered", error: undefined }));
    } catch (e) {
      patchQuestion(callId, (q) => ({ ...q, state: "pending", error: String(e instanceof Error ? e.message : e) }));
    }
  }

  /**
   * Abort the session's turn, reporting the server's own refusal.
   *
   * /abort answers only once the session has settled, so a refusal is an
   * expected outcome and not a crash: 504 means the turn did not settle in
   * time, 502 that the gateway channel was unavailable. Either way the turn is
   * still running, which is what the caller decides with.
   */
  async function abortTurn(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/abort`, { method: "POST" });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }

  /** Stop the turn this pane is streaming. Its own stream ends when the server
   *  settles it, and that is the feedback the user gets, so the answer is not
   *  read here. */
  async function stopAgent(): Promise<void> {
    if (!agentSessionKey) return;
    await abortTurn(agentSessionKey);
  }

  /**
   * Stop the turn this pane is NOT streaming — the one the header reports as
   * still running. Here the answer matters: with nothing on screen moving, a
   * refusal that stayed silent would look like the click never landed.
   */
  async function stopElsewhere(): Promise<void> {
    if (!agentSessionKey || stoppingElsewhere) return;
    const key = agentSessionKey;
    // Captured before the await and re-checked after it: the round trip ends
    // only when the turn has settled, so the user can leave this conversation
    // in the meantime, and an answer for the one they left must not repaint the
    // one they moved to.
    const gen = genRef.current;
    setStoppingElsewhere(true);
    const res = await abortTurn(key);
    if (genRef.current !== gen) return;
    setStoppingElsewhere(false);
    if (!res.ok) {
      // Refused, so the turn is still running: the Stop stays on screen for
      // another try, with the server's own reason reported.
      showToast(res.error, "error");
      return;
    }
    // The stop landed. Nothing is running for this session any more; the poll
    // that was watching for its end has nothing left to watch; and the turn it
    // ended exists only in the history the abort has just persisted. The
    // generation is bumped so a /turn answer still in flight from that poll
    // cannot re-arm the status from its pre-stop snapshot.
    setRunningElsewhere(false);
    stopTurnPolling();
    genRef.current++;
    await loadAgentHistory(key);
  }

  // ── send ──

  /* eslint-disable react-hooks/exhaustive-deps */
  const sendMessage = useCallback(
    (presetText?: string) => {
      const el = inputEl.current;
      const text = (presetText ?? el?.value ?? "").trim();
      if (!text || !objKind || sending) return;
      // A composer Stop is in flight, so the turn it is stopping is still running
      // server-side and its outcome is unknown. Refusing here is what keeps this
      // send from racing it: Enter during the stop bumps the generation, and the
      // stop's continuation then returns early WITHOUT clearing
      // `stoppingElsewhere` — the header would read "Stopping…" and the Stop
      // would stay disabled for the rest of the session. The Send button is not
      // offered in this window; Enter is, which is why the guard has to be here
      // too.
      if (stoppingElsewhere) return;

      if (objKind === "model") {
        if (!svc) return;
        // Real conversation history for the gateway (notice lines and agent
        // messages are UI-only and never part of the prompt).
        const history = msgs
          .filter((m): m is Extract<ChatMsg, { role: "user" | "model" }> => m.role === "user" || (m.role === "model" && !m.notice))
          .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
        const gen = ++genRef.current;
        const userMsgId = nextId();
        setMsgs((m) => [...m, { id: userMsgId, role: "user", text }]);
        setInput("");
        if (el) el.style.height = "auto";
        setSending(true);
        setThinkingText(t("cubepilot.playground.thinking", { name: svc.id }));
        const metaParams = t("cubepilot.playground.metaParams", {
          temperature: String(params.temperature),
          topP: String(params.topP),
          maxTokens: String(params.maxTokens),
        });
        (async () => {
          // Date.now lives in the IIFE body (not the render graph).
          const started = Date.now();
          let full = "";
          try {
            const res = await fetch("/api/cubepilot/playground/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: svc.id,
                messages: [...history, { role: "user", content: text }],
                temperature: params.temperature,
                topP: params.topP,
                maxTokens: params.maxTokens,
              }),
            });
            if (!res.ok) {
              const err = (await res.json().catch(() => null)) as { error?: string } | null;
              throw new Error(err?.error || `HTTP ${res.status}`);
            }
            if (!res.body) throw new Error("empty response body");
            if (genRef.current !== gen) return;
            setThinkingText(null);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (genRef.current !== gen) {
                try {
                  await reader.cancel();
                } catch {
                  /* already closed */
                }
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              let nl: number;
              while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;
                const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
                const delta = chunk.choices?.[0]?.delta?.content ?? "";
                if (delta) {
                  full += delta;
                  setStreaming(full);
                }
              }
            }
            if (genRef.current !== gen) return;
            if (!full) throw new Error(t("cubepilot.playground.emptyReply"));
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            const meta =
              `${svc.id} · ${metaParams} · ` +
              t("cubepilot.playground.metaGenerated", { chars: String(full.length), secs });
            setMsgs((m) => [...m, { id: nextId(), role: "model", text: full, meta }]);
            setStreaming(null);
          } catch (e) {
            if (genRef.current === gen) {
              setThinkingText(null);
              setStreaming(null);
              showToast(t("cubepilot.failed", { error: String(e) }), "error");
            }
          } finally {
            if (genRef.current === gen) setSending(false);
          }
        })();
      } else {
        const gen = ++genRef.current;
        const agentMsgId = nextId();
        const key = agentSessionKey;
        // Held for the whole sequence below, reload included. The stop is a long
        // round trip with nothing visible happening, and the text still sitting
        // in the box is exactly what makes a second Enter look reasonable — so
        // the guard is what keeps that second submission from starting a turn
        // against the session the first one is still stopping. It is set here
        // rather than in the continuation because this render is the last one
        // before the await.
        setSending(true);
        void (async () => {
          // A send into a session whose turn is still running is either refused
          // with a 409 or has its text steered into the running turn and
          // swallowed — neither is what the user asked for. So the turn is
          // stopped first, and the message goes out on a session that has
          // settled. The failed check takes the same route: it confirmed no turn
          // and its stop is refused for the same reason the check failed, so it
          // costs one cheap request and is then the only request left that can
          // re-establish the gateway channel.
          if (key && (runningElsewhere || turnCheckFailed)) {
            const res = await abortTurn(key);
            if (genRef.current !== gen) return;
            if (!res.ok && runningElsewhere) {
              // Refused on a turn the server CONFIRMED. The composer's Stop is
              // on screen and is the control that ends that turn, so the message
              // is held back and stays in the box for another try, rather than
              // racing the turn it was meant to replace.
              setSending(false);
              return;
            }
            if (res.ok) {
              setRunningElsewhere(false);
              stopTurnPolling();
              await loadAgentHistory(key);
              if (genRef.current !== gen) return;
            }
          }
          // This pane is about to drive its own turn, and its own stream is the
          // state from here on: the no-stream status described the turn being
          // left behind.
          setRunningElsewhere(false);
          setTurnCheckFailed(false);
          // From here this pane drives the turn, and the follow loop must leave
          // its transcript alone until the server says the turn is over. Set
          // after the stop-first step, which can return without sending.
          ownTurnRef.current = true;
          followingRef.current = false;
          setMsgs((m) => [...m, { id: nextId(), role: "user", text }, newAgentMsg(agentMsgId)]);
          setInput("");
          if (el) el.style.height = "auto";
          void sendAgent(text, gen, agentMsgId).finally(() => {
            if (genRef.current === gen) {
              setSending(false);
              setThinkingText(null);
            }
          });
        })();
      }
    },
    [msgs, objKind, svc, sending, stoppingElsewhere, runningElsewhere, turnCheckFailed, params, nextId, showToast, t, agentSessionKey],
  );
  // sendAgent/handleAgentEvent are plain closures over this render's state;
  // the deps above (incl. agentSessionKey, which sendAgent reads) are what
  // matter for the captured session key and message list.
  /* eslint-enable react-hooks/exhaustive-deps */

  const agentRoleLine = !agentStatus
    ? t("cubepilot.chat.agentMetaLoading")
    : !agentStatus.exists
      ? t("cubepilot.chat.agentNotProvisioned")
      : agentStatus.phase || t("cubepilot.chat.agentStarting");

  const objName = isAgent ? "CubePilot" : (svc?.id ?? "—");
  const objRole = isAgent ? agentRoleLine : svc ? t("cubepilot.chat.roleModel") : "";

  const agentPillVariant =
    agentStatus?.phase === "Ready" ? "ok" : agentStatus?.phase === "Failed" ? "danger" : agentStatus?.phase ? "warn" : "neutral";

  /** The agent's rows of the thread — what AgentThread draws. */
  const agentMsgs = msgs.filter((m): m is ThreadMsg => m.role === "user" || m.role === "agent");
  // The cards the transcript is still parked on, from EVERY turn in it: a write
  // parked by a turn several bubbles back is still a turn blocked on the user,
  // and its card would otherwise have scrolled away with the bubble that raised
  // it.
  // Oldest first, the order the gateway lists them in: a session can hold
  // several, and createdAtMs is the only stable key they have — a card restored
  // after a reload never saw the arrival order its siblings did.
  const dockApprovals = msgs
    .flatMap((m) => (m.role === "agent" ? openApprovals(m) : []))
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  const dockQuestions = msgs.flatMap((m) => (m.role === "agent" ? openQuestions(m) : []));

  // What the card header says this conversation is doing. The order of the
  // chain is the point, not an accident:
  //  - "stopping" outranks "running" because a confirmed turn IS still running
  //    while its abort settles; testing the run first would show "still running"
  //    for the whole wait and make the click look like it did nothing.
  //  - a failed check is NOT "idle", so it must not fall through to the turn's
  //    own state — and it deliberately carries no Stop, since the stop would
  //    fail for the same reason the check did.
  //  - a turn parked on a human outranks one merely running (the agent is
  //    blocked on the user, and the controls that unblock it are right below),
  //    and it carries no done check: nothing there has finished. It is also what
  //    ranks above a lost transport, which the turn's own state reports first.
  const lastAgent = newestAgent(agentMsgs);
  const waiting = waitingOnUser(agentMsgs);
  const status: StatusLine = stoppingElsewhere
    ? { tone: "run", key: "cubepilot.chat.statusStopping" }
    : turnCheckFailed
      ? { tone: "lost", key: "cubepilot.chat.statusCheckFailed" }
      : waiting
        ? { tone: "wait", key: waiting === "question" ? "cubepilot.chat.statusAwaitAnswer" : "cubepilot.chat.statusAwaitApproval" }
        : runningElsewhere
          ? { tone: "run", key: "cubepilot.chat.statusRunningElsewhere" }
          : lastAgent
            ? turnStatus(lastAgent, now)
            : { tone: "done", key: "cubepilot.chat.statusDone" };

  return (
    <Box>
      <Box data-od-id="chat-sub" sx={{ fontSize: 12, color: "text.secondary", mb: "14px" }}>
        {t("cubepilot.chat.sub")}
      </Box>
      {toastView}

      <Box sx={chatGridSx(listW)}>
        {/* ── objects ── */}
        <Box data-od-id="object-list" sx={{ "@media (max-width: 1180px)": { mb: "14px" } }}>
          <Box sx={groupLabelSx}>{t("cubepilot.chat.objectsAgents")}</Box>
          <Box
            component="button"
            type="button"
            onClick={selectAgent}
            aria-pressed={isAgent}
            data-od-id="obj-cubepilot"
            sx={{
              width: "100%",
              textAlign: "left",
              fontFamily: "inherit",
              color: "text.primary",
              border: 1,
              borderRadius: "var(--radius)",
              p: "12px 14px",
              mb: "8px",
              cursor: "pointer",
              background: isAgent ? VIOLET_SOFT : "background.default",
              borderColor: isAgent ? VIOLET_BORDER : "divider",
              "&:hover": { borderColor: isAgent ? VIOLET_BORDER : "text.primary" },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <Box sx={{ fontSize: 13.5, fontWeight: 600 }}>CubePilot</Box>
              <Box
                sx={{
                  fontSize: 10,
                  fontWeight: 600,
                  px: "7px",
                  py: "1px",
                  borderRadius: 999,
                  border: 1,
                  flex: "none",
                  color: "var(--violet-text)",
                  // The prototype draws this badge at 42% (chat.html:174) while
                  // the selected row beside it uses 55% (chat.html:163) — the
                  // pill sits on a 10% fill, so its border stays light.
                  borderColor: "var(--violet-bd)",
                  bgcolor: "color-mix(in oklch, var(--violet) 10%, transparent)",
                }}
              >
                {t("cubepilot.chat.badgeAgent")}
              </Box>
            </Box>
            <Box sx={{ ...monoSx, fontSize: 11, color: "text.secondary", mt: "5px", lineHeight: 1.5 }} title={agentRoleLine}>
              {agentRoleLine}
            </Box>
          </Box>
          <Box sx={{ ...groupLabelSx, mt: "18px" }}>{t("cubepilot.chat.objectsModels")}</Box>
          {models.map((m) => {
            const active = isModel && m.id === svcId;
            return (
              <Box
                key={m.id}
                component="button"
                type="button"
                onClick={() => selectModel(m.id)}
                aria-pressed={active}
                title={m.id}
                data-od-id={`obj-${m.id}`}
                sx={{
                  width: "100%",
                  textAlign: "left",
                  fontFamily: "inherit",
                  color: "text.primary",
                  border: 1,
                  borderRadius: "var(--radius)",
                  p: "12px 14px",
                  mb: "8px",
                  cursor: "pointer",
                  background: active ? "var(--accent-soft)" : "background.default",
                  borderColor: active ? "var(--accent)" : "divider",
                  "&:hover": { borderColor: active ? "var(--accent)" : "text.primary" },
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                  <Box sx={{ fontSize: 13.5, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.id}
                  </Box>
                  <Box
                    sx={{
                      fontSize: 10,
                      fontWeight: 600,
                      px: "7px",
                      py: "1px",
                      borderRadius: 999,
                      border: 1,
                      flex: "none",
                      color: "var(--accent-strong)",
                      borderColor: "color-mix(in oklch, var(--accent) 40%, var(--border))",
                      bgcolor: "var(--accent-soft)",
                    }}
                  >
                    {t("cubepilot.chat.badgeModel")}
                  </Box>
                </Box>
                <Box sx={{ ...monoSx, fontSize: 11, color: "text.secondary", mt: "5px", lineHeight: 1.5 }}>
                  {m.ownedBy || t("cubepilot.playground.gateway")}
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* ── resizer: drag to resize the object list column ── */}
        <Box
          data-od-id="pane-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={LIST_COL_MIN}
          aria-valuemax={LIST_COL_MAX}
          aria-valuenow={listW}
          aria-label={t("cubepilot.chat.resizeAria")}
          onPointerDown={startResize}
          sx={{
            alignSelf: "stretch",
            position: "relative",
            cursor: "col-resize",
            touchAction: "none",
            zIndex: 5,
            "@media (max-width: 1180px)": { display: "none" },
            "&::before": {
              content: '""',
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              transform: "translateX(-50%)",
              width: resizing ? 3 : 2,
              borderRadius: 2,
              bgcolor: resizing ? "var(--accent)" : "divider",
              transition: "background-color 120ms ease, width 120ms ease",
            },
            "&:hover::before": { bgcolor: "var(--accent)" },
          }}
        />

        {/* ── chat card ── */}
        {/* The card fills the viewport below the app chrome (237px above:
            sticky topbar + page head + tabs + pane sub; the chat tab has no
            page bottom padding), so the thread is the flex filler that
            scrolls inside its own scrollbar and the floating composer sits
            at the window's bottom edge. */}
        <Card
          data-od-id="chat-card"
          sx={{
            display: "flex",
            flexDirection: "column",
            height: "calc(100dvh - 237px)",
            minHeight: 480,
            // Visible so the floating composer's shadow is not clipped at the
            // card's bottom edge.
            overflow: "visible",
            "@media (max-width: 1180px)": { height: "auto" },
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
              px: "18px",
              py: "13px",
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
              <Box
                aria-hidden
                sx={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  display: "grid",
                  placeItems: "center",
                  color: "#fff",
                  flex: "none",
                  bgcolor: isAgent ? "var(--violet-solid)" : ACCENT_FILL,
                }}
              >
                {isAgent ? Icons.spark({ size: 15 }) : Icons.cube({ size: 15 })}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ fontSize: 14, fontWeight: 650 }}>{objName}</Box>
                <Box sx={{ fontSize: 11, color: "text.secondary" }}>{objRole}</Box>
              </Box>
              {objKind ? (
                isAgent ? (
                  <Pill variant={agentPillVariant} dot sx={{ ml: "4px" }}>
                    {agentStatus?.phase || "…"}
                  </Pill>
                ) : (
                  <Pill variant="ok" dot sx={{ ml: "4px" }}>
                    {t("cubepilot.playground.ready")}
                  </Pill>
                )
              ) : null}
            </Box>
            {isModel && svc && endpoint ? (
              <Box
                data-od-id="pg-endpoint"
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  ml: "auto",
                  maxWidth: "100%",
                  ...monoSx,
                  fontSize: 11,
                  color: "text.secondary",
                  bgcolor: "var(--surface)",
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 6,
                  px: "8px",
                  py: "4px",
                }}
              >
                <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {endpointText}
                </Box>
                <CopyBtn
                  text={copied === "endpoint" ? t("cubepilot.playground.copied") : t("cubepilot.playground.copy")}
                  onClick={() => copyText(endpointText, "endpoint")}
                />
              </Box>
            ) : null}
            {/* Model side only: the agent's conversation lives in the runtime under
                one fixed key, so there is nothing here it could clear. */}
            {isModel ? (
              <Btn variant="secondary" small onClick={clearChat} data-od-id="clear-chat">
                {t("cubepilot.playground.clear")}
              </Btn>
            ) : null}
            {/* The agent side's own clear. Its transcript is not here — it is in
                the runtime under one fixed key — so this one DELETEs the session
                rather than dropping a local copy, which is why it is a different
                control with a different question in front of it. */}
            {isAgent ? (
              <Btn
                variant="secondary"
                small
                onClick={() => void clearAgentSession()}
                disabled={clearing || !agentSessionKey}
                data-od-id="clear-agent"
              >
                {t(clearing ? "cubepilot.chat.clearing" : "cubepilot.chat.clear")}
              </Btn>
            ) : null}
          </Box>

          {/* The state of the turn, in the card's own frame rather than in the
              thread below it. It has to be up here: the thread scrolls, and this
              line is read exactly when a long turn has been quiet for a while
              and the user has started to wonder whether it is still going. The
              reference puts it in its header for the same reason. */}
          {isAgent ? (
            <Box
              data-od-id="agent-status"
              aria-live="polite"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                px: "18px",
                py: "9px",
                borderBottom: 1,
                borderColor: "divider",
              }}
            >
              <Pill variant={STATUS_PILL[status.tone]} dot pulse={status.tone === "run"}>
                {t(status.key, status.vars)}
              </Pill>
              {/* The two ways on from a check that could not answer, beside the
                  status they belong to. Retry is the way back to an answer, and
                  Dismiss the way out of an alarm that cannot resolve itself —
                  a channel this pane cannot use fails every retry the same way,
                  and without it the status would sit here forever. */}
              {turnCheckFailed ? (
                <Box sx={{ display: "flex", alignItems: "center", gap: "4px", ml: "auto" }}>
                  <Btn variant="ghost" small onClick={retryTurnCheck} data-od-id="turn-retry">
                    {t("cubepilot.chat.retry")}
                  </Btn>
                  <Btn variant="ghost" small onClick={dismissTurnCheck} data-od-id="turn-dismiss">
                    {t("cubepilot.chat.dismiss")}
                  </Btn>
                </Box>
              ) : null}
            </Box>
          ) : null}

          <Box
            ref={threadEl}
            data-od-id="chat-thread"
            aria-live="polite"
            sx={{
              // 480px basis keeps the thread sized when the card has no
              // definite height (narrow layout); otherwise it flex-fills and
              // scrolls inside its own scrollbar.
              flex: "1 1 480px",
              minHeight: 160,
              overflowY: "auto",
              p: "18px",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
              bgcolor: "var(--surface)",
            }}
          >
            {agentNotice ? (
              <Box sx={{ ...botMsgSx, fontSize: 12.5, color: "text.secondary", borderStyle: "dashed" }}>{agentNotice}</Box>
            ) : null}
            {/* The agent's side of the thread is AgentThread's to draw: its
                bubbles, its text, its tool cards and the cards it settled. The
                pane owns which of the two conversations is on screen, not what a
                turn looks like — drawing it here as well would print every
                message twice (AgentThread draws the user's too). */}
            {isAgent ? (
              <AgentThread msgs={agentMsgs} sessionKey={agentSessionKey} now={now} />
            ) : (
              msgs.map((m) =>
                m.role === "model" ? (
                  <Box key={m.id} sx={botMsgSx}>
                    <Box sx={{ ...monoSx, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent-strong)", mb: "6px" }}>
                      MODEL · {svc?.id ?? ""}
                    </Box>
                    {m.text}
                    {m.meta ? (
                      <Box sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", mt: "8px" }}>{m.meta}</Box>
                    ) : null}
                  </Box>
                ) : m.role === "user" ? (
                  <Box key={m.id} sx={userMsgSx}>
                    {m.text}
                  </Box>
                ) : null,
              )
            )}
            {thinkingText ? <Box sx={{ ...botMsgSx, color: "text.secondary" }}>{thinkingText}</Box> : null}
            {streaming !== null && svc ? (
              <Box
                data-od-id="pg-streaming"
                sx={{ ...botMsgSx, "@keyframes cpBlink": { "50%": { opacity: 0 } } }}
              >
                <Box sx={{ ...monoSx, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent-strong)", mb: "6px" }}>
                  MODEL · {svc.id}
                </Box>
                {streaming}
                <Box
                  component="span"
                  aria-hidden
                  sx={{ color: "var(--accent)", animation: "cpBlink 0.9s steps(1) infinite" }}
                >
                  ▍
                </Box>
              </Box>
            ) : null}
          </Box>

          {/* Composer: a floating bar pinned to the window's bottom edge (the
              DSH look) — a rounded card with a soft shadow instead of a flat
              top-border row; the thread scrolls above it. In model mode the
              sampling params collapse into a chip in the bar's bottom row
              (DSH's access-mode look) and open in a popover. */}
          <Box sx={{ p: "10px 14px 12px", flex: "none" }}>
            {/* The cards a turn is parked on, docked above the composer rather
                than in the bubble that raised them: the thread scrolls, so a
                card drawn in it is a card the user has to go looking for — and
                the turn stays parked for exactly as long as they are looking. */}
            {isAgent ? (
              <HitlDock
                approvals={dockApprovals}
                questions={dockQuestions}
                sessionKey={agentSessionKey}
                now={now}
                allowAlwaysOk={allowAlwaysOk}
                onDecide={(callId, decision) => void decideApproval(callId, decision)}
                onAnswer={(callId, answers, cancel) => void submitQuestion(callId, answers, cancel)}
              />
            ) : null}
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                border: 1,
                borderColor: "divider",
                borderRadius: "16px",
                bgcolor: "background.default",
                boxShadow: (theme) =>
                  `0 1px 2px ${theme.palette.mode === "dark" ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.05)"}, 0 8px 20px ${
                    theme.palette.mode === "dark" ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.09)"
                  }`,
                p: "6px 8px",
                "&:focus-within": { borderColor: "var(--accent)" },
              }}
            >
              <CpTextArea
                ref={inputEl}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoGrow();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={t("cubepilot.chat.placeholder")}
                aria-label={t("cubepilot.chat.placeholder")}
                data-od-id="chat-input"
                sx={{
                  width: "100%",
                  resize: "none",
                  border: 0,
                  boxShadow: "none",
                  bgcolor: "transparent",
                  padding: "6px 4px",
                  minHeight: 34,
                  maxHeight: 120,
                  fontSize: 13.5,
                  "&:focus": { borderColor: "divider", boxShadow: "none" },
                }}
              />
              <Box sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {isModel ? (
                  <Box
                    ref={paramsChipRef}
                    component="button"
                    type="button"
                    data-od-id="params-chip"
                    aria-haspopup="dialog"
                    aria-expanded={paramsAnchor !== null}
                    onClick={() => setParamsAnchor(paramsAnchor ? null : paramsChipRef.current)}
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      height: 28,
                      px: "8px",
                      border: "none",
                      borderRadius: "24px",
                      bgcolor: "transparent",
                      color: "text.secondary",
                      fontSize: 13,
                      lineHeight: "20px",
                      fontWeight: 500,
                      cursor: "pointer",
                      flex: "none",
                      "&:hover": { bgcolor: "action.hover" },
                      "&:focus-visible": { boxShadow: "0 0 0 2px var(--border)" },
                    }}
                  >
                    {SLIDERS_ICON}
                    <Box component="span">{t("cubepilot.playground.paramsTitle")}</Box>
                    <Box
                      component="span"
                      sx={{
                        display: "inline-flex",
                        color: "text.disabled",
                        transform: paramsAnchor !== null ? "rotate(180deg)" : "none",
                        transition: "transform 120ms ease",
                      }}
                    >
                      {CHEVRON_DOWN_ICON}
                    </Box>
                  </Box>
                ) : null}
                <Box sx={{ flex: 1 }} />
                {/* Stop is offered for a turn this pane is streaming, and for
                    one it merely knows about — a turn that survived a reload, or
                    that another tab started, is still this session's turn and
                    this is still the control that ends it. Only a CONFIRMED one:
                    when the check itself failed, nothing established that a turn
                    is running, and the abort would need the very channel whose
                    absence is what failed the check, so Send stays and the
                    header offers Retry instead. */}
                {isAgent && (sending || (runningElsewhere && !turnCheckFailed)) ? (
                  <Btn
                    variant="secondary"
                    small
                    disabled={stoppingElsewhere}
                    onClick={() => void (sending ? stopAgent() : stopElsewhere())}
                    data-od-id="stop-btn"
                  >
                    {t("cubepilot.chat.stop")}
                  </Btn>
                ) : (
                  <Btn variant="primary" small disabled={sending || !objKind} onClick={() => sendMessage()} data-od-id="send-btn">
                    {t("cubepilot.chat.send")}
                  </Btn>
                )}
              </Box>
            </Box>
            <Popover
              open={paramsAnchor !== null}
              anchorEl={paramsAnchor}
              onClose={() => setParamsAnchor(null)}
              anchorOrigin={{ vertical: "top", horizontal: "left" }}
              transformOrigin={{ vertical: "bottom", horizontal: "left" }}
              slotProps={{
                paper: {
                  sx: {
                    p: "10px 12px",
                    border: 1,
                    borderColor: "divider",
                    borderRadius: "var(--radius)",
                    bgcolor: "background.default",
                  },
                },
              }}
            >
              <Box sx={{ width: 320 }}>
                <ParamsPanel params={params} onChange={(patch) => setParams((p) => ({ ...p, ...patch }))} />
              </Box>
            </Popover>
          </Box>
        </Card>
      </Box>
    </Box>
  );
}
