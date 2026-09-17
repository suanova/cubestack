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
// client restores the user's latest session (history + pending HITL cards),
// and polls history while a turn is still in flight after a reload.

import { Box, Popover, SxProps, Theme } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  applyAgentEvent,
  historyToMsgs,
  newAgentMsg,
  openApprovals,
  openQuestions,
  type AgentApproval,
  type AgentQuestion,
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
  SkillInfo,
} from "@/lib/cubepilot/types";
import { useI18n } from "@/lib/i18n";

import { fmtTime } from "./format";
import { HitlDock, type ApprovalDecision } from "./HitlDock";
import { CopyBtn, ParamsPanel, SampleParams } from "./Playground";
import { AgentThread } from "./AgentThread";
import { Btn, Card, CpTextArea, Icons, Pill, monoSx, useToast } from "./ui";

// The portal tokens have no violet; one hue + color-mix against var(--fg)
// adapts to the theme (dark violet on light, light violet on dark).
const VIOLET = "oklch(0.55 0.2 290)";
const VIOLET_BORDER = `color-mix(in oklch, ${VIOLET} 55%, var(--border))`;
const VIOLET_TEXT = `color-mix(in oklch, ${VIOLET} 75%, var(--fg))`;
const VIOLET_SOFT = `color-mix(in oklch, ${VIOLET} 9%, transparent)`;
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
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentSkills, setAgentSkills] = useState<SkillInfo[]>([]);
  const [agentSessionKey, setAgentSessionKey] = useState<string | null>(null);
  const [agentNotice, setAgentNotice] = useState("");
  /** The instance's confirm policy is Allowlist, so a durable approval would
   *  mean something. False until read (and false when the read fails): the
   *  "always allow" button offers a rule that would not apply otherwise. */
  const [allowAlwaysOk, setAllowAlwaysOk] = useState(false);
  /** The 1s ticker's clock. A question's countdown is derived from it, so it has
   *  to move for the card to lock itself up when the gateway's timeout runs out. */
  const [now, setNow] = useState(() => Date.now());

  // Only while a turn is unfinished: the countdown is the one thing on this page
  // that needs a second-by-second clock, and an idle page must not re-render
  // every second for nothing.
  const anyLive = msgs.some((m) => m.role === "agent" && m.phase !== "done");
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyLive]);

  const inputEl = useRef<HTMLTextAreaElement | null>(null);
  const threadEl = useRef<HTMLDivElement | null>(null);
  /** The composer's sampling-params chip; anchors the params popover. */
  const paramsChipRef = useRef<HTMLButtonElement | null>(null);
  // Guards against in-flight fetch/stream from a previous object.
  const genRef = useRef(0);
  const idRef = useRef(0);
  /** Polls history while a turn is in flight after a reload. */
  const turnPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      clearInterval(turnPollRef.current);
      turnPollRef.current = null;
    }
  }

  function cancelInflight(): void {
    genRef.current++;
    stopTurnPolling();
    setStreaming(null);
    setThinkingText(null);
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
      setAgentConfig(config);
      setAgentSkills(skills);
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
    setAgentSessionKey(null);
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
   * Restore the user's latest session after a (re)select: history, an
   * in-flight turn (history polling), and any pending HITL cards.
   */
  async function restoreAgentSession(meta: AgentMeta): Promise<void> {
    const gen = genRef.current;
    try {
      const res = await fetch("/api/cubepilot/pilot/api/v1/sessions");
      if (genRef.current !== gen) return;
      if (!res.ok) {
        // 503 while the instance is warming up: nothing to restore yet.
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsgs(greetingMsgs(meta.status, meta.config, meta.skills));
        setAgentNotice(err?.error ? t("cubepilot.chat.sessionsUnavailable", { error: err.error }) : "");
        return;
      }
      const body = (await res.json()) as { sessions?: Array<{ sessionKey: string; title?: string }> };
      if (genRef.current !== gen) return;
      const first = body.sessions?.[0];
      if (!first) {
        setMsgs(greetingMsgs(meta.status, meta.config, meta.skills));
        return;
      }
      setAgentSessionKey(first.sessionKey);
      await loadAgentHistory(first.sessionKey);
      if (genRef.current !== gen) return;
      try {
        const tRes = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(first.sessionKey)}/turn`);
        if (tRes.ok && genRef.current === gen) {
          const { active } = (await tRes.json()) as { active?: boolean };
          if (active) {
            setAgentNotice(t("cubepilot.chat.turnActive"));
            startTurnPolling(first.sessionKey);
          }
        }
      } catch {
        /* no turn info */
      }
      await restorePendingHitl(first.sessionKey);
    } catch (e) {
      if (genRef.current === gen) {
        setMsgs(greetingMsgs(meta.status, meta.config, meta.skills));
        setAgentNotice(t("cubepilot.chat.sessionsUnavailable", { error: String(e) }));
      }
    }
  }

  async function loadAgentHistory(key: string): Promise<void> {
    const gen = genRef.current;
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/messages`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { items?: HistoryMessage[] };
      if (genRef.current !== gen) return;
      setMsgs(historyToMsgs(body.items ?? [], nextId));
    } catch {
      if (genRef.current === gen) setAgentNotice(t("cubepilot.chat.historyUnavailable"));
    }
  }

  /** Re-attach cards the turn is currently blocked on (required after reload). */
  async function restorePendingHitl(key: string): Promise<void> {
    const gen = genRef.current;
    const attachApproval = (a: { approvalId: string; tool?: string; command?: string; level?: string; message?: string }) => {
      // The card belongs to the turn it was raised in — the newest one here,
      // since restore happens before anything else can arrive.
      const card: AgentApproval = { callId: a.approvalId, name: a.tool, command: a.command, level: a.level, message: a.message, state: "pending" };
      setMsgs((m) => {
        const lastIdx = [...m].reverse().findIndex((x) => x.role === "agent");
        if (lastIdx < 0) return [...m, { ...newAgentMsg(nextId()), approvals: [card] }];
        const i = m.length - 1 - lastIdx;
        return m.map((x, xi) => (xi === i && x.role === "agent" ? { ...x, approvals: [...x.approvals, card] } : x));
      });
    };
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/approval/pending`);
      if (res.ok && genRef.current === gen) {
        const { approval } = (await res.json()) as { approval?: { approvalId?: string; tool?: string; command?: string; level?: string; message?: string } };
        // Property narrowing does not change the object type, so pin the id.
        if (approval && approval.approvalId) attachApproval({ ...approval, approvalId: approval.approvalId });
      }
      // 404 = no pending approval: silent by contract.
    } catch {
      /* silent */
    }
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/question/pending`);
      if (res.ok && genRef.current === gen) {
        const { questions } = (await res.json()) as {
          questions?: Array<{ id?: string; questions?: AgentQuestionItem[] }>;
        };
        for (const q of questions ?? []) {
          if (!q.id) continue;
          setMsgs((m) => {
            const lastIdx = [...m].reverse().findIndex((x) => x.role === "agent");
            if (lastIdx < 0) return m;
            const i = m.length - 1 - lastIdx;
            return m.map((x, xi) =>
              xi === i && x.role === "agent" ? { ...x, questions: [...x.questions, { callId: q.id as string, questions: q.questions ?? [], state: "pending" as const }] } : x,
            );
          });
        }
      }
    } catch {
      /* silent */
    }
  }

  /** Poll history every 3s while a reloaded turn is still in flight. */
  function startTurnPolling(key: string): void {
    stopTurnPolling();
    const gen = genRef.current;
    turnPollRef.current = setInterval(async () => {
      if (genRef.current !== gen) {
        stopTurnPolling();
        return;
      }
      try {
        const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/turn`);
        if (!res.ok || genRef.current !== gen) return;
        const { active } = (await res.json()) as { active?: boolean };
        if (genRef.current !== gen) {
          stopTurnPolling();
          return;
        }
        if (!active) {
          stopTurnPolling();
          setAgentNotice("");
          await loadAgentHistory(key);
          await restorePendingHitl(key);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  }

  /** Load the gateway model catalog; on first load select the first model. */
  async function loadModels(): Promise<void> {
    const gen = ++genRef.current;
    try {
      const res = await fetch("/api/cubepilot/playground/services");
      const body = (await res.json().catch(() => null)) as
        | { models?: GatewayModel[]; endpoint?: string | null; error?: string }
        | null;
      if (genRef.current !== gen) return;
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setModels(body?.models ?? []);
      setEndpoint(body?.endpoint ?? null);
      // First load: default to the first model. The `models` state is still
      // the pre-fetch [] in this closure, so the object is passed directly.
      selectModelService((body?.models ?? [])[0]);
    } catch (e) {
      if (genRef.current === gen) showToast(t("cubepilot.failed", { error: String(e) }), "error");
    }
  }

  // Mount-only: t's identity changes every render (useI18n), and the fetched
  // data is locale-neutral, so a load-once effect is what we want.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    void loadModels();
    void loadAgentMeta();
    // The policy that decides whether a durable approval is on offer: read once,
    // like the rest of the instance meta.
    void loadConfirmPolicy();
    return () => {
      cancelInflight();
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  function clearChat(): void {
    if (!objKind) return;
    cancelInflight();
    if (isModel) {
      if (svc) setMsgs([{ id: nextId(), role: "model", text: t("cubepilot.playground.cleared"), notice: true }]);
    } else {
      // A cleared agent thread starts a fresh server session on next send.
      setAgentSessionKey(null);
      setAgentNotice("");
      setMsgs(greetingMsgs(agentStatus, agentConfig, agentSkills));
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
          if (evt.type === "message_done") gotDone = true;
          if (genRef.current === gen) handleAgentEvent(evt, msgId);
        }
      }
      // The stream may die without the terminal event; per contract the
      // client synthesizes message_done so the UI always resets.
      if (!gotDone && genRef.current === gen) {
        setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, error: t("cubepilot.chat.streamLost") } : x)));
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
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 404 || res.status === 409) {
          // The record is gone: the turn ended (or another client decided) while
          // this click was in flight. Nobody decided, which is the neutral
          // "stopped" — reporting the user's own click as a rejection would
          // attribute to them a decision the server refused.
          patchApproval(callId, (a) => ({ ...a, state: "stopped", error: undefined }));
          return;
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as { allowlisted?: boolean } | null;
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { questions } = (await res.json()) as {
        questions?: Array<{ id?: string; questions?: AgentQuestionItem[]; timeoutSeconds?: number }>;
      };
      const still = (questions ?? []).find((q) => q.id === callId);
      if (still) {
        patchQuestion(callId, (q) => ({
          ...q,
          state: "pending",
          // The gateway's remainder, not this browser's stale one.
          ...(still.timeoutSeconds ? { deadline: Date.now() + still.timeoutSeconds * 1000 } : {}),
          error: t("cubepilot.chat.questionNotAccepted"),
        }));
        return;
      }
      patchQuestion(callId, (q) => ({ ...q, state: "expired", error: undefined }));
    } catch {
      // The re-read failed, so "gone" is not established either. The card stays
      // open and says what went wrong rather than settling on a guess.
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

  async function stopAgent(): Promise<void> {
    if (!agentSessionKey) return;
    try {
      await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(agentSessionKey)}/abort`, { method: "POST" });
    } catch {
      /* best effort — the stream ends on its own */
    }
  }

  // ── send ──

  /* eslint-disable react-hooks/exhaustive-deps */
  const sendMessage = useCallback(
    (presetText?: string) => {
      const el = inputEl.current;
      const text = (presetText ?? el?.value ?? "").trim();
      if (!text || !objKind || sending) return;

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
        setMsgs((m) => [...m, { id: nextId(), role: "user", text }, newAgentMsg(agentMsgId)]);
        setInput("");
        if (el) el.style.height = "auto";
        setSending(true);
        void sendAgent(text, gen, agentMsgId).finally(() => {
          if (genRef.current === gen) {
            setSending(false);
            setThinkingText(null);
          }
        });
      }
    },
    [msgs, objKind, svc, sending, params, nextId, showToast, t, agentSessionKey],
  );
  // sendAgent/handleAgentEvent are plain closures over this render's state;
  // the deps above (incl. agentSessionKey, which sendAgent reads) are what
  // matter for the captured session key and message list.
  /* eslint-enable react-hooks/exhaustive-deps */

  const agentRoleLine = !agentStatus
    ? t("cubepilot.chat.agentMetaLoading")
    : !agentStatus.exists
      ? t("cubepilot.chat.agentNotProvisioned")
      : [agentStatus.phase || t("cubepilot.chat.agentStarting"), agentStatus.lastActivity ? fmtTime(agentStatus.lastActivity) : ""]
          .filter(Boolean)
          .join(" · ");

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
  const dockApprovals = msgs.flatMap((m) => (m.role === "agent" ? openApprovals(m) : []));
  const dockQuestions = msgs.flatMap((m) => (m.role === "agent" ? openQuestions(m) : []));

  return (
    <Box>
      <Box data-od-id="chat-sub" sx={{ fontSize: 12, color: "text.secondary", mb: "14px" }}>
        {t("cubepilot.chat.sub")}
      </Box>
      {toastView}

      <Box sx={chatGridSx(listW)}>
        {/* ── objects ── */}
        <Box data-od-id="object-list" sx={{ "@media (max-width: 1180px)": { mb: "14px" } }}>
          <Box sx={groupLabelSx}>{t("cubepilot.chat.objectsModels")}</Box>
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

          <Box sx={{ ...groupLabelSx, mt: "18px" }}>{t("cubepilot.chat.objectsAgents")}</Box>
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
                  color: VIOLET_TEXT,
                  borderColor: VIOLET_BORDER,
                  bgcolor: `color-mix(in oklch, ${VIOLET} 10%, transparent)`,
                }}
              >
                {t("cubepilot.chat.badgeAgent")}
              </Box>
            </Box>
            <Box sx={{ ...monoSx, fontSize: 11, color: "text.secondary", mt: "5px", lineHeight: 1.5 }} title={agentRoleLine}>
              {agentRoleLine}
            </Box>
          </Box>
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
                  bgcolor: isAgent ? VIOLET : ACCENT_FILL,
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
            <Btn variant="secondary" small disabled={!objKind} onClick={clearChat} data-od-id="clear-chat">
              {t("cubepilot.playground.clear")}
            </Btn>
          </Box>

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
              <AgentThread
                msgs={agentMsgs}
                sessionKey={agentSessionKey}
                now={now}
                onDecideApproval={(msgId, callId, decision) => void decideApproval(callId, decision)}
                onAnswerQuestion={(msgId, callId, answers, cancel) => void submitQuestion(callId, answers, cancel)}
              />
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
                {isAgent && sending ? (
                  <Btn variant="secondary" small onClick={() => void stopAgent()} data-od-id="stop-btn">
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
