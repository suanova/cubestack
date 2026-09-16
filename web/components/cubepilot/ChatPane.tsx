"use client";

// 聊天 tab — the unified conversation surface for inference models and the
// CubePilot agent, mirroring public/chat.html: object list (gateway models
// + AI assistant) | chat card | context rail that follows the selected
// object (model: sampling params / cURL; agent: status / tool whitelist /
// approval).
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

import { Box, SxProps, Theme } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentConfig,
  AgentQuestionItem,
  AgentSseEvent,
  AgentStatus,
  ConfirmView,
  GatewayModel,
  HistoryMessage,
  QuickChip,
  SkillInfo,
} from "@/lib/cubepilot/types";
import { ruleKey } from "@/lib/cubepilot/allowlist";
import { useI18n } from "@/lib/i18n";

import { fmtTime } from "./format";
import {
  ApiCard,
  CopyBtn,
  gatewayCurl,
  ParamsCard,
  SampleParams,
} from "./Playground";
import { setStoredTab } from "./tabStore";
import { Btn, Card, CardHead, CpInput, CpTextArea, Icons, Pill, monoSx, STATUS_WARN, useToast } from "./ui";

// The portal tokens have no violet; one hue + color-mix against var(--fg)
// adapts to the theme (dark violet on light, light violet on dark).
const VIOLET = "oklch(0.55 0.2 290)";
const VIOLET_BORDER = `color-mix(in oklch, ${VIOLET} 55%, var(--border))`;
const VIOLET_TEXT = `color-mix(in oklch, ${VIOLET} 75%, var(--fg))`;
const VIOLET_SOFT = `color-mix(in oklch, ${VIOLET} 9%, transparent)`;
const ACCENT_FILL = "color-mix(in oklch, var(--accent) 82%, var(--fg))";
const ERROR_COLOR = "#e15c5c";

const CHAT_GRID: SxProps<Theme> = {
  display: "grid",
  gridTemplateColumns: "236px minmax(0,1fr) 300px",
  gap: "14px",
  alignItems: "start",
  "@media (max-width: 1180px)": { gridTemplateColumns: "1fr" },
};

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

/** One agent tool invocation (tool_call + tool_result paired by callId). */
interface AgentToolMsg {
  callId?: string;
  name: string;
  arguments?: string;
  output?: string;
  done: boolean;
}

/** One HITL write-approval card (approval_pending / approval_resolved). */
interface AgentApprovalMsg {
  callId: string;
  name?: string;
  command?: string;
  level?: string;
  message?: string;
  state: "pending" | "deciding" | "approved" | "rejected";
}

/** One ask_user question card (question_pending / question_resolved). */
interface AgentQuestionMsg {
  callId: string;
  questions: AgentQuestionItem[];
  state: "pending" | "submitting" | "answered" | "cancelled" | "expired";
  answers?: Record<string, string[]>;
}

/** One thread message. Agent messages grow with the SSE stream. */
type ChatMsg =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "model"; text: string; meta?: string; notice?: boolean }
  | {
      id: number;
      role: "agent";
      text: string;
      tools: AgentToolMsg[];
      approvals: AgentApprovalMsg[];
      questions: AgentQuestionMsg[];
      thinking: boolean;
      error?: string;
      stopped?: boolean;
      meta?: string;
    };

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
  confirm: ConfirmView | null;
}

/** Format tool_call arguments for display (objects compact, strings as-is). */
function fmtArgs(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

const newAgentMsg = (id: number, extra?: Partial<Extract<ChatMsg, { role: "agent" }>>): Extract<ChatMsg, { role: "agent" }> => ({
  id,
  role: "agent",
  text: "",
  tools: [],
  approvals: [],
  questions: [],
  thinking: false,
  ...extra,
});

/**
 * Normalize the runtime history document into thread messages: user items
 * become user bubbles (string or text blocks), assistant items become agent
 * bubbles, toolResult items attach their output to the matching (or newest
 * open) tool of the preceding agent bubble.
 */
function historyToMsgs(items: HistoryMessage[], nextId: () => number): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const it of items) {
    if (it.role === "user") {
      const text =
        typeof it.content === "string"
          ? it.content
          : it.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      if (text.trim()) out.push({ id: nextId(), role: "user", text });
      continue;
    }
    // The agent bubble of this run: reuse the trailing one so a
    // text + toolCall + toolResult run stays in a single bubble.
    let idx = out.length - 1;
    if (idx < 0 || out[idx].role !== "agent") {
      out.push(newAgentMsg(nextId()));
      idx = out.length - 1;
    }
    let agent = out[idx] as Extract<ChatMsg, { role: "agent" }>;
    const blocks = typeof it.content === "string" ? [{ type: "text" as const, text: it.content }] : it.content;
    for (const b of blocks) {
      if (b.type === "text" && b.text) {
        agent = { ...agent, text: agent.text ? `${agent.text}\n\n${b.text}` : b.text };
      } else if (b.type === "toolCall") {
        if (it.role === "assistant") {
          agent = {
            ...agent,
            tools: [
              ...agent.tools,
              { callId: b.id, name: b.name ?? "tool", arguments: b.arguments !== undefined ? fmtArgs(b.arguments) : undefined, done: false },
            ],
          };
        } else {
          const open = b.id ? agent.tools.findIndex((t) => t.callId === b.id && !t.done) : agent.tools.findIndex((t) => !t.done);
          const i = open >= 0 ? open : agent.tools.length - 1;
          if (i >= 0) {
            const tools: AgentToolMsg[] = [...agent.tools];
            tools[i] = { ...tools[i], output: b.text ?? "", done: true };
            agent = { ...agent, tools };
          }
        }
      }
    }
    // Each block above replaced the bubble with an updated copy — write the
    // accumulated bubble back, or the restored text/tools are dropped.
    out[idx] = agent;
  }
  return out;
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
  const [copied, setCopied] = useState<"endpoint" | "curl" | null>(null);
  const [params, setParams] = useState<SampleParams>({ temperature: 0.7, topP: 0.9, maxTokens: 1024 });

  // Agent (CubePilot) state — real data from the agent CRs + agent API.
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [agentSkills, setAgentSkills] = useState<SkillInfo[]>([]);
  /** The confirmation view: the effective policy + the allowlist the rail shows. */
  const [agentConfirm, setAgentConfirm] = useState<ConfirmView | null>(null);
  const [agentMetaError, setAgentMetaError] = useState("");
  const [agentSessionKey, setAgentSessionKey] = useState<string | null>(null);
  const [agentNotice, setAgentNotice] = useState("");

  const inputEl = useRef<HTMLTextAreaElement | null>(null);
  const threadEl = useRef<HTMLDivElement | null>(null);
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
   * The agent's real meta (instance status, config, skill whitelist) from the
   * agent CRs. Returns the fresh values (the state they set is one render
   * stale inside the calling async flow).
   */
  async function loadAgentMeta(): Promise<AgentMeta> {
    try {
      const [stRes, cfgRes, skRes, cfRes] = await Promise.all([
        fetch("/api/cubepilot/agent/status"),
        fetch("/api/cubepilot/agent/config"),
        fetch("/api/cubepilot/skills"),
        fetch("/api/cubepilot/agent/confirm"),
      ]);
      const [stBody, cfgBody, skBody, cfBody] = await Promise.all([
        stRes.json().catch(() => null),
        cfgRes.json().catch(() => null),
        skRes.json().catch(() => null),
        cfRes.json().catch(() => null),
      ]);
      if (!stRes.ok) throw new Error((stBody as { error?: string } | null)?.error ?? `HTTP ${stRes.status}`);
      // The agent meta is global (the object list entry + the context rail),
      // not part of the conversation generation: apply it even when a model
      // auto-selection bumped that generation while these requests were in
      // flight (otherwise the object entry stays "loading" forever).
      const status = stBody as AgentStatus;
      const config = cfgRes.ok ? ((cfgBody as { config?: AgentConfig } | null)?.config ?? null) : null;
      const skills = skRes.ok ? ((skBody as { skills?: SkillInfo[] } | null)?.skills ?? []) : [];
      const confirm = cfRes.ok ? (cfBody as ConfirmView | null) : null;
      setAgentStatus(status);
      setAgentConfig(config);
      setAgentSkills(skills);
      setAgentConfirm(confirm);
      setAgentMetaError("");
      return { status, config, skills, confirm };
    } catch (e) {
      setAgentMetaError(String(e));
      return { status: null, config: null, skills: [], confirm: null };
    }
  }

  /** The greeting (real data: instance, model, whitelist size). */
  function greetingMsgs(status: AgentStatus | null, config: AgentConfig | null, skills: SkillInfo[]): ChatMsg[] {
    if (!status?.exists) {
      return [newAgentMsg(nextId(), { text: t("cubepilot.chat.greetingNoInstance"), meta: t("cubepilot.chat.greetingMeta") })];
    }
    return [
      newAgentMsg(nextId(), {
        text: t("cubepilot.chat.greeting", {
          tools: String(skills.length),
          model: config?.selectedModel || t("cubepilot.chat.modelDefault"),
        }),
        meta: t("cubepilot.chat.greetingMeta"),
      }),
    ];
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
      setMsgs((m) => {
        const lastIdx = [...m].reverse().findIndex((x) => x.role === "agent");
        if (lastIdx < 0) return [...m, newAgentMsg(nextId(), { approvals: [{ callId: a.approvalId, name: a.tool, command: a.command, level: a.level, message: a.message, state: "pending" }] })];
        const i = m.length - 1 - lastIdx;
        return m.map((x, xi) =>
          xi === i && x.role === "agent"
            ? { ...x, approvals: [...x.approvals, { callId: a.approvalId, name: a.tool, command: a.command, level: a.level, message: a.message, state: "pending" as const }] }
            : x,
        );
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

  function copyText(text: string, which: "endpoint" | "curl"): void {
    const done = () => {
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1400);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  }

  // ── agent conversation (real SSE via the pilot proxy) ───────────────────

  /** Apply one SSE event to the in-flight agent message. */
  function handleAgentEvent(evt: AgentSseEvent, msgId: number): void {
    const update = (fn: (m: Extract<ChatMsg, { role: "agent" }>) => Extract<ChatMsg, { role: "agent" }>) => {
      setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? fn(x) : x)));
    };
    switch (evt.type) {
      case "message_start":
        setAgentSessionKey(evt.sessionId);
        break;
      case "agent_thinking":
        break; // the thinking indicator is already shown
      case "message_delta":
        setThinkingText(null);
        update((m) => ({ ...m, thinking: false, text: m.text + evt.delta }));
        break;
      case "text_replace":
        setThinkingText(null);
        // Replace, never append (the gateway rewrites earlier narration).
        update((m) => ({ ...m, thinking: false, text: evt.delta }));
        break;
      case "tool_call":
        setThinkingText(null);
        update((m) => ({
          ...m,
          thinking: false,
          tools: [...m.tools, { callId: evt.callId, name: evt.name, arguments: evt.arguments !== undefined ? fmtArgs(evt.arguments) : undefined, done: false }],
        }));
        break;
      case "tool_result":
        update((m) => {
          const open = evt.callId ? m.tools.findIndex((x) => x.callId === evt.callId && !x.done) : m.tools.findIndex((x) => !x.done);
          const i = open >= 0 ? open : m.tools.length - 1;
          if (i < 0) return m;
          const tools = [...m.tools];
          tools[i] = { ...tools[i], output: evt.output ?? "", done: true };
          return { ...m, tools };
        });
        break;
      case "approval_pending":
        setThinkingText(null);
        update((m) => ({
          ...m,
          approvals: [...m.approvals, { callId: evt.callId, name: evt.name, command: evt.command, level: evt.level, message: evt.message, state: "pending" }],
        }));
        break;
      case "approval_resolved":
        update((m) => ({
          ...m,
          approvals: m.approvals.map((a) => (a.callId === evt.callId ? { ...a, state: evt.approved ? ("approved" as const) : ("rejected" as const) } : a)),
        }));
        break;
      case "question_pending":
        setThinkingText(null);
        update((m) => ({
          ...m,
          questions: [...m.questions, { callId: evt.callId, questions: evt.question?.questions ?? [], state: "pending" }],
        }));
        break;
      case "question_resolved":
        update((m) => ({
          ...m,
          questions: m.questions.map((q) =>
            q.callId === evt.callId
              ? { ...q, state: evt.message === "cancelled" ? ("cancelled" as const) : evt.message === "expired" ? ("expired" as const) : ("answered" as const) }
              : q,
          ),
        }));
        break;
      case "message_done":
        setThinkingText(null);
        update((m) => ({ ...m, thinking: false, error: evt.error || undefined, stopped: evt.stopped === true }));
        break;
    }
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
        setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, thinking: false, error: t("cubepilot.chat.streamLost") } : x)));
      }
    } catch (e) {
      if (genRef.current === gen) {
        setThinkingText(null);
        setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, thinking: false, error: String(e instanceof Error ? e.message : e) } : x)));
      }
    }
  }

  // ── HITL actions ──

  async function decideApproval(msgId: number, callId: string, decision: "approve" | "reject" | "allow-always"): Promise<void> {
    if (!agentSessionKey) return;
    setMsgs((list) =>
      list.map((x) =>
        x.id === msgId && x.role === "agent"
          ? { ...x, approvals: x.approvals.map((a) => (a.callId === callId ? { ...a, state: "deciding" as const } : a)) }
          : x,
      ),
    );
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(agentSessionKey)}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 404 || res.status === 409) {
          // Expired / already resolved: clear the local card (contract §5.1).
          setMsgs((list) =>
            list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, approvals: x.approvals.filter((a) => a.callId !== callId) } : x)),
          );
          return;
        }
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      // The approval_resolved event normally follows on the stream; when the
      // stream is already closed the response is the only outcome signal.
      setMsgs((list) =>
        list.map((x) =>
          x.id === msgId && x.role === "agent"
            ? { ...x, approvals: x.approvals.map((a) => (a.callId === callId && a.state === "deciding" ? { ...a, state: decision === "reject" ? ("rejected" as const) : ("approved" as const) } : a)) }
            : x,
        ),
      );
    } catch (e) {
      setMsgs((list) =>
        list.map((x) =>
          x.id === msgId && x.role === "agent"
            ? { ...x, approvals: x.approvals.map((a) => (a.callId === callId ? { ...a, state: "pending" as const } : a)) }
            : x,
        ),
      );
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
    }
  }

  async function submitQuestion(msgId: number, callId: string, answers: Record<string, string[]>, cancel: boolean): Promise<void> {
    if (!agentSessionKey) return;
    setMsgs((list) =>
      list.map((x) =>
        x.id === msgId && x.role === "agent"
          ? { ...x, questions: x.questions.map((q) => (q.callId === callId ? { ...q, state: "submitting" as const, answers: cancel ? q.answers : answers } : q)) }
          : x,
      ),
    );
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(agentSessionKey)}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: callId, ...(cancel ? { cancel: true } : { answers }) }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 404 || res.status === 409) {
          setMsgs((list) =>
            list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, questions: x.questions.filter((q) => q.callId !== callId) } : x)),
          );
          return;
        }
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      setMsgs((list) =>
        list.map((x) =>
          x.id === msgId && x.role === "agent"
            ? { ...x, questions: x.questions.map((q) => (q.callId === callId ? { ...q, state: cancel ? ("cancelled" as const) : ("answered" as const) } : q)) }
            : x,
        ),
      );
    } catch (e) {
      setMsgs((list) =>
        list.map((x) =>
          x.id === msgId && x.role === "agent"
            ? { ...x, questions: x.questions.map((q) => (q.callId === callId ? { ...q, state: "pending" as const } : q)) }
            : x,
        ),
      );
      showToast(t("cubepilot.failed", { error: String(e) }), "error");
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
        setMsgs((m) => [...m, { id: nextId(), role: "user", text }, newAgentMsg(agentMsgId, { thinking: true })]);
        setInput("");
        if (el) el.style.height = "auto";
        setSending(true);
        // The thinking indicator lives inside the agent bubble (m.thinking).
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

  const chips: QuickChip[] = (
    isModel
      ? [t("cubepilot.chat.chipModel1"), t("cubepilot.chat.chipModel2"), t("cubepilot.chat.chipModel3")]
      : [t("cubepilot.chat.chipAgent1"), t("cubepilot.chat.chipAgent2"), t("cubepilot.chat.chipAgent3")]
  ).map((label) => ({ label }));

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

  return (
    <Box>
      <Box data-od-id="chat-sub" sx={{ fontSize: 12, color: "text.secondary", mb: "14px" }}>
        {t("cubepilot.chat.sub")}
      </Box>
      {toastView}

      <Box sx={CHAT_GRID}>
        {/* ── objects ── */}
        <Box data-od-id="object-list">
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

          <Card sx={{ p: "12px 14px", mt: "8px" }}>
            <Box sx={{ fontSize: 12, color: "text.secondary", lineHeight: 1.7 }}>{t("cubepilot.chat.objectsNote")}</Box>
          </Card>
        </Box>

        {/* ── chat card ── */}
        <Card data-od-id="chat-card" sx={{ display: "flex", flexDirection: "column", minHeight: 600 }}>
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

          {objKind ? (
            <Box
              data-od-id="quick-chips"
              sx={{ display: "flex", gap: "8px", flexWrap: "wrap", px: "18px", py: "12px", borderBottom: 1, borderColor: "divider" }}
            >
              {chips.map((c) => (
                <Box
                  key={c.label}
                  component="button"
                  type="button"
                  disabled={sending}
                  onClick={() => sendMessage(c.label)}
                  data-od-id="quick-chip"
                  sx={{
                    fontSize: 12.5,
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 999,
                    bgcolor: "background.default",
                    color: "text.primary",
                    p: "5px 13px",
                    cursor: sending ? "default" : "pointer",
                    opacity: sending ? 0.5 : 1,
                    "&:hover": { borderColor: "text.primary" },
                  }}
                >
                  {c.label}
                </Box>
              ))}
            </Box>
          ) : null}

          <Box
            ref={threadEl}
            data-od-id="chat-thread"
            aria-live="polite"
            sx={{
              flex: 1,
              overflowY: "auto",
              p: "18px",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
              height: 480,
              bgcolor: "var(--surface)",
              "@media (max-width: 1180px)": { height: 420 },
            }}
          >
            {agentNotice ? (
              <Box sx={{ ...botMsgSx, fontSize: 12.5, color: "text.secondary", borderStyle: "dashed" }}>{agentNotice}</Box>
            ) : null}
            {msgs.map((m) =>
              m.role === "user" ? (
                <Box key={m.id} sx={userMsgSx}>
                  {m.text}
                </Box>
              ) : m.role === "model" ? (
                <Box key={m.id} sx={botMsgSx}>
                  <Box sx={{ ...monoSx, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--accent-strong)", mb: "6px" }}>
                    MODEL · {svc?.id ?? ""}
                  </Box>
                  {m.text}
                  {m.meta ? (
                    <Box sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", mt: "8px" }}>{m.meta}</Box>
                  ) : null}
                </Box>
              ) : (
                <Box key={m.id} sx={{ ...botMsgSx, borderColor: VIOLET_BORDER }}>
                  <Box sx={{ ...monoSx, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: VIOLET_TEXT, mb: "6px" }}>
                    CUBEPILOT
                  </Box>
                  {m.text ? <Box>{m.text}</Box> : null}
                  {m.thinking && !m.text && m.tools.length === 0 ? (
                    <Box sx={{ fontSize: 12.5, color: "text.secondary" }}>{t("cubepilot.chat.thinkingAgent")}</Box>
                  ) : null}
                  {m.tools.map((tool, ti) => (
                    <Box
                      key={(tool.callId ?? "t") + ti}
                      sx={{
                        m: "9px 0 0",
                        border: 1,
                        borderColor: VIOLET_BORDER,
                        borderRadius: 6,
                        bgcolor: VIOLET_SOFT,
                        p: "8px 12px",
                      }}
                    >
                      <Box sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Box sx={{ color: VIOLET_TEXT, display: "flex" }}>{Icons.tool({ size: 13 })}</Box>
                        <Box sx={{ ...monoSx, fontSize: 11.5, fontWeight: 600 }}>{tool.name}</Box>
                        {!tool.done ? (
                          <Box sx={{ ml: "auto", ...monoSx, fontSize: 10.5, color: "text.secondary" }}>…</Box>
                        ) : null}
                      </Box>
                      {tool.arguments ? (
                        <Box
                          component="pre"
                          sx={{ m: "6px 0 0", ...monoSx, fontSize: 11, overflowX: "auto", whiteSpace: "pre-wrap", color: "text.secondary" }}
                        >
                          {tool.arguments}
                        </Box>
                      ) : null}
                      {tool.output ? (
                        <Box sx={{ m: "6px 0 0", ...monoSx, fontSize: 11, whiteSpace: "pre-wrap", color: "text.secondary", lineHeight: 1.7 }}>
                          {tool.output}
                        </Box>
                      ) : null}
                    </Box>
                  ))}
                  {m.approvals.map((a) => (
                    <Box
                      key={a.callId}
                      data-od-id="approval-item"
                      sx={{ m: "9px 0 0", border: 1, borderColor: `color-mix(in oklch, ${STATUS_WARN} 55%, var(--border))`, borderRadius: 6, p: "10px 12px", bgcolor: `color-mix(in oklch, ${STATUS_WARN} 9%, transparent)`, display: "flex", flexDirection: "column", gap: "7px" }}
                    >
                      <Box sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Box sx={{ fontSize: 12, fontWeight: 600 }}>{t("cubepilot.chat.approvalTitle")}</Box>
                        {a.level ? (
                          <Pill variant={a.level === "write" ? "warn" : "neutral"}>{a.level}</Pill>
                        ) : null}
                        {a.state !== "pending" && a.state !== "deciding" ? (
                          <Pill variant={a.state === "approved" ? "ok" : "danger"}>
                            {a.state === "approved" ? t("cubepilot.chat.approvalApproved") : t("cubepilot.chat.approvalRejected")}
                          </Pill>
                        ) : null}
                      </Box>
                      {a.command ? (
                        <Box component="pre" sx={{ m: 0, ...monoSx, fontSize: 11.5, whiteSpace: "pre-wrap", bgcolor: "var(--surface)", borderRadius: 5, p: "7px 10px" }}>
                          {a.command}
                        </Box>
                      ) : null}
                      {a.message ? <Box sx={{ fontSize: 12, color: "text.secondary" }}>{a.message}</Box> : null}
                      {a.state === "pending" || a.state === "deciding" ? (
                        <Box sx={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                          <Btn small variant="primary" disabled={a.state === "deciding"} onClick={() => void decideApproval(m.id, a.callId, "approve")} data-od-id="approval-approve">
                            {t("cubepilot.chat.approvalApprove")}
                          </Btn>
                          <Btn small disabled={a.state === "deciding"} onClick={() => void decideApproval(m.id, a.callId, "reject")} data-od-id="approval-reject">
                            {t("cubepilot.chat.approvalReject")}
                          </Btn>
                          <Btn small disabled={a.state === "deciding"} onClick={() => void decideApproval(m.id, a.callId, "allow-always")} data-od-id="approval-allow">
                            {t("cubepilot.chat.approvalAllowAlways")}
                          </Btn>
                        </Box>
                      ) : null}
                    </Box>
                  ))}
                  {m.questions.map((q) => (
                    <QuestionCardView
                      key={q.callId}
                      q={q}
                      disabled={q.state !== "pending"}
                      onAnswer={(answers) => void submitQuestion(m.id, q.callId, answers, false)}
                      onCancel={() => void submitQuestion(m.id, q.callId, {}, true)}
                    />
                  ))}
                  {m.error ? (
                    <Box sx={{ ...monoSx, fontSize: 11.5, color: ERROR_COLOR, mt: "8px", whiteSpace: "pre-wrap" }}>{m.error}</Box>
                  ) : null}
                  {m.stopped ? (
                    <Box sx={{ fontSize: 12, color: "text.secondary", mt: "6px" }}>{t("cubepilot.chat.stopped")}</Box>
                  ) : null}
                  {m.meta ? <Box sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", mt: "8px" }}>{m.meta}</Box> : null}
                </Box>
              ),
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

          <Box sx={{ borderTop: 1, borderColor: "divider", p: "12px 14px", display: "flex", gap: "10px", alignItems: "flex-end" }}>
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
                flex: 1,
                resize: "none",
                padding: "10px 12px",
                minHeight: 44,
                maxHeight: 120,
                fontSize: 13.5,
              }}
            />
            {isAgent && sending ? (
              <Btn variant="secondary" onClick={() => void stopAgent()} data-od-id="stop-btn">
                {t("cubepilot.chat.stop")}
              </Btn>
            ) : (
              <Btn variant="primary" disabled={sending || !objKind} onClick={() => sendMessage()} data-od-id="send-btn">
                {t("cubepilot.chat.send")}
              </Btn>
            )}
          </Box>
        </Card>

        {/* ── context rail ── */}
        {isAgent ? (
          <Box sx={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <Card data-od-id="agent-status-card">
              <Box sx={{ display: "flex", alignItems: "center", gap: "12px", p: "16px 18px 14px" }}>
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
                    bgcolor: VIOLET,
                  }}
                >
                  {Icons.spark({ size: 15 })}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Box sx={{ fontSize: 14, fontWeight: 650 }}>CubePilot</Box>
                  <Box sx={{ fontSize: 11.5, color: "text.secondary" }}>{t("cubepilot.chat.agentRole")}</Box>
                </Box>
                <Box sx={{ ml: "auto", textAlign: "right", ...monoSx, fontSize: 10.5, color: "text.secondary", lineHeight: 1.6 }}>
                  {agentStatus?.lastActivity ? (
                    <>
                      {t("cubepilot.chat.lastActivity")}
                      <br />
                      {fmtTime(agentStatus.lastActivity)}
                    </>
                  ) : (
                    t("cubepilot.chat.statusLabel", { status: agentStatus?.phase || "—" })
                  )}
                </Box>
              </Box>
              <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
                <Box sx={{ p: "12px 18px", borderTop: 1, borderColor: "divider", borderRight: 1, minWidth: 0 }}>
                  <Box sx={{ fontSize: 11, color: "text.secondary" }}>{t("cubepilot.chat.railModel")}</Box>
                  <Box sx={{ ...monoSx, fontSize: 12, fontWeight: 650, mt: "3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {agentConfig?.selectedModel || t("cubepilot.chat.modelDefault")}
                  </Box>
                </Box>
                <Box sx={{ p: "12px 18px", borderTop: 1, borderColor: "divider" }}>
                  <Box sx={{ fontSize: 11, color: "text.secondary" }}>{t("cubepilot.chat.railPhase")}</Box>
                  <Box sx={{ ...monoSx, fontSize: 12, fontWeight: 650, mt: "3px" }}>{agentStatus?.phase || "—"}</Box>
                </Box>
              </Box>
            </Card>

            {agentMetaError ? (
              <Card data-od-id="agent-meta-error-card">
                <Box sx={{ p: "10px 18px", fontSize: 12, color: ERROR_COLOR, wordBreak: "break-word" }}>
                  {t("cubepilot.chat.metaError", { error: agentMetaError })}
                </Box>
              </Card>
            ) : null}

            {/* The allowlist only exists under the Allowlist policy: with None
                everything passes (audited), so the card is hidden entirely. */}
            {agentConfirm?.confirmPolicy === "Allowlist" ? (
              <Card data-od-id="allowlist-card">
                <CardHead
                  title={t("cubepilot.chat.railAllowlist")}
                  hint={t("cubepilot.chat.railAllowlistMeta", { count: String(agentConfirm.allowlist.length) })}
                />
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: "6px", p: "12px 18px", borderTop: 1, borderColor: "divider" }}>
                  {agentConfirm.allowlist.map((r) => (
                    <Box
                      key={ruleKey(r)}
                      data-od-id="rail-allowlist-tag"
                      data-owned={r.owned ? "true" : "false"}
                      title={[r.label || r.pattern, r.argPattern ? `argPattern: ${r.argPattern}` : ""].filter(Boolean).join("\n")}
                      sx={{
                        display: "inline-flex",
                        alignItems: "center",
                        border: 1,
                        borderColor: r.owned ? "color-mix(in oklch, var(--accent) 40%, var(--border))" : "divider",
                        bgcolor: r.owned ? "var(--accent-soft)" : "var(--surface)",
                        borderRadius: 999,
                        p: "3px 9px",
                        ...monoSx,
                        fontSize: 11.5,
                      }}
                    >
                      {r.pattern}
                    </Box>
                  ))}
                </Box>
                <Box sx={{ px: "18px", pb: "12px", fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }}>
                  {t("cubepilot.chat.railAllowlistNote")}
                </Box>
              </Card>
            ) : null}

            {/* The agent's tools (skills) — separate from the confirmation
                allowlist above. */}
            <Card data-od-id="tool-whitelist-card">
              <CardHead title={t("cubepilot.chat.railSkills")} hint={t("cubepilot.chat.railTotal", { count: String(agentSkills.length) })} />
              {agentSkills.length === 0 && !agentMetaError ? (
                <Box sx={{ p: "10px 18px", borderTop: 1, borderColor: "divider", fontSize: 12.5, color: "text.secondary" }}>
                  {t("cubepilot.chat.noSkills")}
                </Box>
              ) : null}
              {agentSkills.map((s) => (
                <Box
                  key={s.name}
                  title={s.description}
                  sx={{ display: "flex", alignItems: "center", gap: "10px", p: "9px 18px", borderTop: 1, borderColor: "divider", fontSize: 12.5 }}
                >
                  <Box sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.displayName || s.name}
                  </Box>
                  <Pill variant={s.enabled ? "ok" : "neutral"}>{s.enabled ? t("cubepilot.chat.skillEnabled") : t("cubepilot.chat.skillDisabled")}</Pill>
                </Box>
              ))}
            </Card>

            <Card data-od-id="approval-card">
              <CardHead title={t("cubepilot.chat.railApproval")} hint={t("cubepilot.chat.railApprovalMeta")} />
              <Box
                sx={{
                  p: "13px 18px",
                  borderTop: 1,
                  borderColor: "divider",
                  bgcolor: "var(--surface)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "9px",
                }}
              >
                <Box sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }}>{t("cubepilot.chat.railApprovalNote")}</Box>
                <Box
                  component="button"
                  type="button"
                  onClick={() => setStoredTab("config")}
                  sx={{
                    alignSelf: "flex-start",
                    border: 0,
                    bg: "transparent",
                    p: 0,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 550,
                    color: "var(--accent-strong)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    "&:hover": { textDecoration: "underline", textUnderlineOffset: 3 },
                  }}
                >
                  {t("cubepilot.chat.railApprovalLink")}
                </Box>
              </Box>
            </Card>
          </Box>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <ParamsCard
              params={params}
              onChange={(patch) => setParams((p) => ({ ...p, ...patch }))}
            />
            {endpoint && svc ? (
              <ApiCard
                endpoint={endpoint}
                model={svc.id}
                params={params}
                copied={copied === "curl"}
                onCopy={() => copyText(gatewayCurl(endpoint, svc.id, params), "curl")}
              />
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** One ask_user card: options (radio/checkbox) or free text, submit/cancel. */
function QuestionCardView({
  q,
  disabled,
  onAnswer,
  onCancel,
}: {
  q: AgentQuestionMsg;
  disabled: boolean;
  onAnswer: (answers: Record<string, string[]>) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});

  const toggleOption = (qid: string, multi: boolean | undefined, label: string) => {
    setSel((s) => {
      const cur = s[qid] ?? [];
      const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
      return { ...s, [qid]: next };
    });
  };

  const answerFor = (item: AgentQuestionItem): string[] =>
    item.options && item.options.length > 0 ? (sel[item.questionId] ?? []) : (free[item.questionId] ?? "").trim() ? [(free[item.questionId] ?? "").trim()] : [];

  const ready = q.questions.every((item) => answerFor(item).length > 0);

  const resolvedLabel =
    q.state === "answered" ? t("cubepilot.chat.questionAnswered") : q.state === "cancelled" ? t("cubepilot.chat.questionCancelled") : q.state === "expired" ? t("cubepilot.chat.questionExpired") : "";

  return (
    <Box
      data-od-id="question-item"
      sx={{ m: "9px 0 0", border: 1, borderColor: VIOLET_BORDER, borderRadius: 6, p: "10px 12px", bgcolor: VIOLET_SOFT, display: "flex", flexDirection: "column", gap: "9px" }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Box sx={{ fontSize: 12, fontWeight: 600 }}>{t("cubepilot.chat.questionTitle")}</Box>
        {disabled && resolvedLabel ? (
          <Pill variant={q.state === "answered" ? "ok" : "neutral"}>{resolvedLabel}</Pill>
        ) : null}
      </Box>
      {q.questions.map((item) => (
        <Box key={item.questionId} sx={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          {item.header ? <Box sx={{ ...monoSx, fontSize: 10.5, color: VIOLET_TEXT, fontWeight: 600 }}>{item.header}</Box> : null}
          <Box sx={{ fontSize: 12.5 }}>{item.question}</Box>
          {item.options && item.options.length > 0 ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: "4px", mt: "2px" }}>
              {item.options.map((opt) => {
                const checked = (sel[item.questionId] ?? []).includes(opt.label);
                return (
                  <Box
                    key={opt.label}
                    component="button"
                    type="button"
                    disabled={disabled}
                    onClick={() => toggleOption(item.questionId, item.multiSelect, opt.label)}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      textAlign: "left",
                      fontFamily: "inherit",
                      fontSize: 12.5,
                      color: "text.primary",
                      border: 1,
                      borderColor: checked ? VIOLET : "divider",
                      borderRadius: 6,
                      p: "6px 10px",
                      cursor: disabled ? "default" : "pointer",
                      bgcolor: checked ? "var(--surface)" : "transparent",
                      opacity: disabled && !checked ? 0.55 : 1,
                    }}
                  >
                    <Box
                      aria-hidden
                      sx={{
                        width: 13,
                        height: 13,
                        flex: "none",
                        border: 1,
                        borderColor: checked ? VIOLET : "divider",
                        borderRadius: item.multiSelect ? 3 : "50%",
                        display: "grid",
                        placeItems: "center",
                        color: "#fff",
                        bgcolor: checked ? VIOLET : "transparent",
                        fontSize: 9,
                      }}
                    >
                      {checked ? "✓" : ""}
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      {opt.label}
                      {opt.description ? (
                        <Box sx={{ fontSize: 11, color: "text.secondary" }}>{opt.description}</Box>
                      ) : null}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          ) : (
            <CpInput
              aria-label={item.question}
              value={free[item.questionId] ?? ""}
              disabled={disabled}
              onChange={(e) => setFree((f) => ({ ...f, [item.questionId]: e.target.value }))}
              sx={{ mt: "2px", fontSize: 12.5 }}
            />
          )}
        </Box>
      ))}
      {!disabled ? (
        <Box sx={{ display: "flex", gap: "7px" }}>
          <Btn small variant="primary" disabled={!ready || q.state === "submitting"} data-od-id="question-submit" onClick={() => onAnswer(Object.fromEntries(q.questions.map((i) => [i.questionId, answerFor(i)])))}>
            {t("cubepilot.chat.questionSubmit")}
          </Btn>
          <Btn small disabled={q.state === "submitting"} data-od-id="question-cancel" onClick={onCancel}>
            {t("cubepilot.chat.questionCancel")}
          </Btn>
        </Box>
      ) : null}
    </Box>
  );
}
