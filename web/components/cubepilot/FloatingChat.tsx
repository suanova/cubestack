"use client";

// Global floating AI chat — the bottom-right entry the mockups (cubestack-ui
// copilot.html) sketch as a per-page drawer, made into ONE shared surface:
// the same CubePilot conversation the 智能助手 chat tab owns (one fixed
// session key, so both see the same thread, the same parked cards, and the
// same running turn — the conversation belongs to the user, not to a page).
//
// It is global by MOUNT, not by state: the app shell renders it on every page
// except the /cubepilot chat tab — that tab IS the conversation, so drawing
// this copy of it beside the full pane would show one thread twice. A client
// navigation never touches it (the shell mounts it once), so a turn keeps
// streaming while the user moves between pages.
//
// Everything turn-shaped is delegated to the shared parts: the event fold is
// lib/cubepilot/agentThread, the transcript is AgentThread, the live
// approval/question cards are HitlDock. What remains here is the surface
// itself — the launcher, the compact card, and the session bookkeeping a
// surface needs: restore on open, follow while open, stop-first on send.

import { Box } from "@mui/material";
import { Fragment, useEffect, useRef, useState } from "react";

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
  HistoryMessage,
  PendingApproval,
  SkillInfo,
} from "@/lib/cubepilot/types";
import type { MessageKey } from "@/lib/i18n/dictionaries";
import { useI18n } from "@/lib/i18n";

import { AgentThread } from "./AgentThread";
import { HitlDock, type ApprovalDecision } from "./HitlDock";
import { Btn, CpTextArea, Icons, Pill, monoSx, useToast } from "./ui";

// The same fixed conversation key the chat tab uses (see ChatPane): one
// conversation per user, wherever they open it.
const SESSION_KEY = "agent:main:conv-portal";

// Follow-loop period: the same rhythm the chat tab watches at.
const FOLLOW_INTERVAL_MS = 3000;

// The status line's tone → pill colour, the chat tab's own mapping.
const STATUS_PILL = {
  run: "accent",
  done: "ok",
  stopped: "neutral",
  lost: "warn",
  error: "danger",
  wait: "warn",
} as const;

const enc = encodeURIComponent;

/** The instance meta the greeting and the header line are drawn from. */
interface AgentMeta {
  status: AgentStatus | null;
  config: AgentConfig | null;
  skills: SkillInfo[];
}

/** The instance line under the title: what the agent is looking at. */
function agentRoleLine(status: AgentStatus | null, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  return !status ? t("cubepilot.chat.agentMetaLoading") : !status.exists ? t("cubepilot.chat.agentNotProvisioned") : status.phase || t("cubepilot.chat.agentStarting");
}

/** One quick prompt of the mockup's "try asking me" list (copilot.html). */
const QUICK_PROMPTS = ["fchat.qp1", "fchat.qp2"] as const;

export function FloatingChat() {
  const { t } = useI18n();
  const { showToast, toastView } = useToast();

  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ThreadMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentNotice, setAgentNotice] = useState("");
  /** A turn is running for this session with no stream of this surface's own —
   *  one the chat tab started, or one that outlived a close. */
  const [runningElsewhere, setRunningElsewhere] = useState(false);
  /** The /turn read itself failed: whether a turn is running is simply unknown. */
  const [turnCheckFailed, setTurnCheckFailed] = useState(false);
  /** A stop of that turn is in flight; the server answers /abort only once the
   *  session has settled, so this is a long wait with nothing else moving. */
  const [stoppingElsewhere, setStoppingElsewhere] = useState(false);
  /** The instance's confirm policy is Allowlist, so a durable approval rule
   *  would mean something. False until read (and false when the read fails). */
  const [allowAlwaysOk, setAllowAlwaysOk] = useState(false);
  /** The 1s ticker's clock. A question's countdown is derived from it. */
  const [now, setNow] = useState(() => Date.now());

  const inputEl = useRef<HTMLTextAreaElement | null>(null);
  const threadEl = useRef<HTMLDivElement | null>(null);
  /** Whether a restore has run on this mount at all: the first open greets
   *  (an empty thread with no prompt is the one thing a first-time visitor
   *  must not see); later opens only adopt what the server has in the
   *  meantime and never re-send a greeting over a finished local turn. */
  const loadedRef = useRef(false);
  /** Guards against in-flight fetch/stream from before an (re)open. */
  const genRef = useRef(0);
  const idRef = useRef(0);
  /** The session follow loop; one pending tick (each tick schedules its own
   *  successor, so there is never more than one read in flight). */
  const turnPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The raw history document last rendered, so the follow loop can skip a
   *  re-render (and a re-scroll) when the server's copy has not moved. */
  const lastHistoryRef = useRef<string>("");
  /** The follow loop's own generation, separate from `genRef`: a send bumps
   *  genRef, and a tick already in flight must still be able to schedule its
   *  successor for the conversation the send belongs to. */
  const followGenRef = useRef(0);
  /** True from the moment this surface drives a turn until the server says
   *  that turn has stopped running. While it holds, this surface's own view
   *  of the turn is the truth (its stream wrote it), and the follow loop must
   *  not replace it with the history document, which carries no HITL cards. */
  const ownTurnRef = useRef(false);
  /** Whether the follow loop has been adopting the history document for the
   *  turn it is watching now (a turn this surface did NOT author). */
  const followingRef = useRef(false);

  const nextId = (): number => {
    idRef.current += 1;
    return idRef.current;
  };

  function autoGrow(): void {
    const el = inputEl.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 96) + "px";
  }

  function stopTurnPolling(): void {
    if (turnPollRef.current) {
      clearTimeout(turnPollRef.current);
      turnPollRef.current = null;
    }
  }

  /** Stop the follow loop for good: bump its generation so a tick already in
   *  flight cannot schedule a successor for a conversation this surface has
   *  stopped watching. */
  function stopFollowing(): void {
    followGenRef.current++;
    stopTurnPolling();
  }

  function cancelInflight(): void {
    genRef.current++;
    stopFollowing();
    // The turn and its follow state describe the session this surface is
    // leaving (unmount): retired with it.
    ownTurnRef.current = false;
    followingRef.current = false;
    lastHistoryRef.current = "";
    setSending(false);
    setRunningElsewhere(false);
    setTurnCheckFailed(false);
    setStoppingElsewhere(false);
  }

  /** The instance's real meta (status, config, skills) from the agent CRs.
   *  Applied even when the generation moved while it was in flight: it is
   *  global to the surface (the header line), not part of a conversation
   *  generation. */
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
      const status = stBody as AgentStatus;
      const config = cfgRes.ok ? ((cfgBody as { config?: AgentConfig } | null)?.config ?? null) : null;
      const skills = skRes.ok ? ((skBody as { skills?: SkillInfo[] } | null)?.skills ?? []) : [];
      setAgentStatus(status);
      return { status, config, skills };
    } catch {
      return { status: null, config: null, skills: [] };
    }
  }

  /** The greeting (real data: instance, model, whitelist size) — the same two
   *  text blocks the chat tab opens its conversation with. */
  function greetingMsgs(status: AgentStatus | null, config: AgentConfig | null, skills: SkillInfo[]): ThreadMsg[] {
    const greeting = !status?.exists
      ? t("cubepilot.chat.greetingNoInstance")
      : t("cubepilot.chat.greeting", {
          tools: String(skills.length),
          model: displayModelName(config?.selectedModel || PLATFORM_MODEL_NAME),
        });
    return [
      {
        ...newAgentMsg(nextId()),
        // Nothing is running: the greeting says what the agent is looking at,
        // so its turn is already told.
        phase: "done",
        blocks: [
          { kind: "text", text: greeting },
          { kind: "text", text: t("cubepilot.chat.greetingMeta") },
        ],
      },
    ];
  }

  /** Read the instance's confirm policy once: it decides whether the durable
   *  "always allow" decision is worth offering at all. A failed read leaves it
   *  off: a button that might not hold is worse than a button never seen. */
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

  /** Load the session's history; answers whether there was any. An empty
   *  history is a conversation that has not started, which the caller greets
   *  rather than drawing as a blank thread.
   *
   *  An empty read NEVER replaces what is on screen: a local turn this
   *  surface streamed may be newer than any history flush, and adopting an
   *  empty document would delete it in exchange for nothing. */
  async function loadAgentHistory(key: string): Promise<boolean> {
    const gen = genRef.current;
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/messages`);
      // 404 is "this conversation has not started": an ordinary empty thread,
      // NOT a failure.
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { items?: HistoryMessage[] };
      if (genRef.current !== gen) return true;
      const items = body.items ?? [];
      lastHistoryRef.current = JSON.stringify(items);
      const restored = historyToMsgs(items, nextId);
      if (restored.length > 0) setMsgs(restored);
      return restored.length > 0;
    } catch {
      if (genRef.current === gen) setAgentNotice(t("cubepilot.chat.historyUnavailable"));
      return true; // a failed read is not "an unstarted conversation"
    }
  }

  /** Ask the server whether the session still has a turn in flight — the only
   *  signal that survives a reload or a close. Never folded into "not
   *  running": the route answers 502 exactly when it could not determine. */
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

  function retryTurnCheck(): void {
    setTurnCheckFailed(false);
    void checkTurnElsewhere(SESSION_KEY, genRef.current);
  }

  function dismissTurnCheck(): void {
    setTurnCheckFailed(false);
  }

  /** Re-attach cards the turn is currently blocked on (required after a
   *  restore): a reload or a reopen cannot see the stream that raised them. */
  async function restorePendingHitl(key: string): Promise<void> {
    const gen = genRef.current;
    /** A card with no turn in the thread to hang it on gets its own bubble.
     *  The phase is `done`, never the constructor's `thinking`: this turn is
     *  PARKED, not running. */
    const attachToNewest = (patch: (m: AgentMsg) => AgentMsg): void => {
      setMsgs((m) => {
        const lastIdx = [...m].reverse().findIndex((x) => x.role === "agent");
        if (lastIdx < 0) return [...m, patch({ ...newAgentMsg(nextId()), phase: "done" })];
        const i = m.length - 1 - lastIdx;
        return m.map((x, xi) => (xi === i && x.role === "agent" ? patch(x) : x));
      });
    };
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/approval/pending`);
      if (res.ok && genRef.current === gen) {
        // A LIST, oldest first: a session can hold several pending approvals
        // at once, and the oldest is not the only one this surface offers.
        const { approvals } = (await res.json()) as { approvals?: PendingApproval[] };
        for (const a of approvals ?? []) {
          if (a.approvalId) {
            // Through the fold's own add, so a stream event that already
            // described this approval is not doubled by the read that describes
            // it again.
            const card = newApproval({ ...a, name: a.tool });
            attachToNewest((x) => addApproval(x, card));
          }
        }
      }
      // 404 = no pending approval: silent by contract.
    } catch {
      /* silent */
    }
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/question/pending`);
      // This endpoint's 404 IS "nothing is pending", not a failed read.
      if (res.status !== 404 && !res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.ok && genRef.current === gen) {
        const { questions } = (await res.json()) as {
          questions?: Array<{ id?: string; questions?: AgentQuestionItem[]; timeoutSeconds?: number }>;
        };
        for (const q of questions ?? []) {
          if (!q.id) continue;
          // The response carries what is LEFT of the gateway's deadline, so a
          // restored card gets the same countdown as a streamed one.
          const card = newQuestion(q.id, q.questions ?? [], q.timeoutSeconds, Date.now());
          attachToNewest((x) => ({ ...x, questions: [...x.questions, card] }));
        }
      }
    } catch (e) {
      if (genRef.current === gen) {
        setMsgs((m) => [
          ...m,
          { ...newAgentMsg(nextId()), phase: "done", error: t("cubepilot.chat.pendingQuestionUnavailable", { error: String(e) }) },
        ]);
      }
    }
  }

  /** Re-read the history, but only re-render when the server's copy actually
   *  moved. A naive re-read every 3s would hand `msgs` a new array each time,
   *  and the thread's autoscroll keys on it — the reader would be yanked to
   *  the bottom mid-scrollback for the whole length of a turn. */
  async function refreshHistoryIfChanged(key: string): Promise<void> {
    const gen = genRef.current;
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/messages`);
      if (!res.ok) return;
      const body = (await res.json()) as { items?: HistoryMessage[] };
      if (genRef.current !== gen) return;
      // The stream this surface is driving is the state: a tick that started
      // as a follower can still be waiting on this fetch when the user sends,
      // and replacing the transcript then would take the bubble the stream is
      // writing to with it.
      if (ownTurnRef.current) return;
      // An empty read is not something to adopt: a turn's transcript is never
      // empty once it has said anything, so an empty one means the runtime has
      // not written it yet.
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
   * Watch the conversation for as long as the panel is open.
   *
   * The conversation belongs to the user, not to this surface: the chat tab
   * (or another window) can move it, and a turn this surface started can
   * outlive the stream that started it. Idle ticks cost one small GET; the
   * history is only re-read while a turn is actually running, and only
   * re-rendered when the server's copy has moved. Each tick schedules its own
   * successor rather than riding an interval, so there is never more than one
   * read in flight — an interval would let a slow read overlap its successor
   * and land the older snapshot last, running the transcript backwards.
   */
  function startFollowing(key: string): void {
    stopFollowing();
    const gen = followGenRef.current;

    const tickOnce = async (): Promise<void> => {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(key)}/turn`);
      if (!res.ok || followGenRef.current !== gen) return;
      const { active } = (await res.json()) as { active?: boolean };
      if (followGenRef.current !== gen) return;
      if (ownTurnRef.current) {
        // A turn this surface started. Its stream is the state, and the
        // history document is no substitute: it holds no cards, and it cannot
        // say that the stream died.
        if (active !== true) ownTurnRef.current = false;
        return;
      }
      if (active === true) {
        setRunningElsewhere(true);
        // Keep the transcript moving while the turn runs: without this the
        // view is frozen until the turn ENDS, which is what a reader sees when
        // the turn was started elsewhere.
        followingRef.current = true;
        await refreshHistoryIfChanged(key);
        return;
      }
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
      if (followGenRef.current === gen) {
        turnPollRef.current = setTimeout(() => void tick(), FOLLOW_INTERVAL_MS);
      }
    };

    turnPollRef.current = setTimeout(() => void tick(), FOLLOW_INTERVAL_MS);
  }

  /** Re-establish the conversation's state for this surface on an open.
   *
   *  The first open greets when there is no history yet (an empty thread with
   *  no prompt must not be what a first-time visitor sees). Later opens only
   *  ADOPT what the server has: a local turn this surface streamed is newer
   *  than any history flush, so the greeting is never re-sent over a finished
   *  turn, and loadAgentHistory's empty-read guard keeps the local transcript
   *  until the server's copy catches up (the follow loop's terminal read then
   *  takes the final one). */
  function refreshSession(): void {
    const gen = genRef.current;
    const first = !loadedRef.current;
    loadedRef.current = true;
    void (async () => {
      const meta = await loadAgentMeta();
      if (genRef.current !== gen) return;
      // While we are driving our own turn, the stream is the state: adopting
      // the history document now would take the bubble it is writing to with
      // it (the history carries no HITL cards either).
      const hadHistory = ownTurnRef.current ? true : await loadAgentHistory(SESSION_KEY);
      if (genRef.current !== gen) return;
      if (!hadHistory && first) setMsgs(greetingMsgs(meta.status, meta.config, meta.skills));
      // While we are driving our own turn, the stream is the state: the /turn
      // read would report the turn WE are streaming as "running elsewhere",
      // which would mislabel its status and send a needless stop-first abort
      // into the next send. The follow loop's tick owns that check.
      const running = ownTurnRef.current ? false : await checkTurnElsewhere(SESSION_KEY, gen);
      if (genRef.current !== gen) return;
      if (running) {
        setAgentNotice(t("cubepilot.chat.turnActive"));
        // Armed, so the terminal read that clears the notice and completes the
        // transcript is taken even if the turn ends before the first tick.
        followingRef.current = true;
      }
      startFollowing(SESSION_KEY);
      await restorePendingHitl(SESSION_KEY);
      if (genRef.current === gen) void loadConfirmPolicy();
    })();
  }

  function openPanel(): void {
    if (open) return;
    setOpen(true);
    refreshSession();
  }

  function closePanel(): void {
    setOpen(false);
    // A turn this surface is streaming is NOT cancelled: the stream is the
    // state and it settles on its own (or hands off to the next restore).
    stopFollowing();
  }

  // Focus the composer on open, so Enter starts talking immediately.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputEl.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // The surface lives for the whole visit: retire its in-flight work when the
  // shell unmounts it (entering the chat tab) or the session ends.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    return () => {
      cancelInflight();
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  // ── agent conversation (real SSE via the pilot proxy) ───────────────────

  function handleAgentEvent(evt: AgentSseEvent, msgId: number): void {
    // The session is fixed, so `message_start` has nothing to report here
    // (the chat pane learns its key from it; this surface already knows it).
    setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? applyAgentEvent(x, evt) : x)));
  }

  async function sendAgent(text: string, gen: number, msgId: number): Promise<void> {
    let gotDone = false;
    try {
      const res = await fetch("/api/cubepilot/pilot/api/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, sessionId: SESSION_KEY }),
      });
      if (!res.ok) {
        // Request-phase failure (400/409/503-warming): surfaced as an error on
        // the agent bubble, not a toast.
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
      // The stream ended without the terminal event. That is a transport
      // failure, not a turn outcome: the run may still be executing on the
      // server, so nothing here may end the turn or settle the cards it left
      // parked. The run is re-checked — the server is the only thing that can
      // say whether it is still going.
      if (!gotDone && genRef.current === gen) {
        const reason = t("cubepilot.chat.streamLost");
        setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, transportLost: reason } : x)));
        // Hand the turn to the follow loop: from here the transcript is the
        // only thing that can say what the run did.
        ownTurnRef.current = false;
        followingRef.current = true;
        void checkTurnElsewhere(SESSION_KEY, gen);
      }
    } catch (e) {
      if (genRef.current === gen) {
        setMsgs((list) => list.map((x) => (x.id === msgId && x.role === "agent" ? { ...x, error: String(e instanceof Error ? e.message : e) } : x)));
      }
    }
  }

  // ── HITL actions ─────────────────────────────────────────────────────────

  const patchApproval = (callId: string, fn: (a: AgentApproval) => AgentApproval): void => {
    setMsgs((list) =>
      list.map((x) => (x.role === "agent" ? { ...x, approvals: x.approvals.map((a) => (a.callId === callId ? fn(a) : a)) } : x)),
    );
  };
  const patchQuestion = (callId: string, fn: (q: AgentQuestion) => AgentQuestion): void => {
    setMsgs((list) =>
      list.map((x) => (x.role === "agent" ? { ...x, questions: x.questions.map((q) => (q.callId === callId ? fn(q) : q)) } : x)),
    );
  };

  async function decideApproval(callId: string, decision: ApprovalDecision): Promise<void> {
    // Optimistic: the click answers a card the turn is blocked on, so it must
    // look like it landed immediately.
    patchApproval(callId, (a) => ({ ...a, state: "deciding", error: undefined }));
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(SESSION_KEY)}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The id is required: a session can hold several pending approvals,
        // and the server will not pick one for us.
        body: JSON.stringify({ approvalId: callId, decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 404 || res.status === 409) {
          // The record is gone or was decided elsewhere: nobody decided HERE,
          // which is the neutral "stopped".
          patchApproval(callId, (a) => ({ ...a, state: "stopped", error: undefined }));
          return;
        }
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as { allowlisted?: boolean; approvalId?: string } | null;
      // The approval this settled is the one that was named.
      if (body?.approvalId && body.approvalId !== callId) {
        patchApproval(callId, (a) => ({ ...a, state: "stopped", error: t("cubepilot.chat.approvalWrongRecord", { id: body.approvalId ?? "" }) }));
        return;
      }
      // The approval_resolved event normally follows on the stream; when the
      // stream is already closed the response is the only outcome signal.
      patchApproval(callId, (a) => (a.state === "deciding" ? { ...a, state: decision === "reject" ? "rejected" : "approved" } : a));
      if (decision === "allow-always" && body?.allowlisted !== true) {
        showToast(t("cubepilot.chat.approvalNotAllowlisted"), "error");
      }
    } catch (e) {
      // The card stays answerable, with the reason on it.
      patchApproval(callId, (a) => ({ ...a, state: "pending", error: String(e instanceof Error ? e.message : e) }));
    }
  }

  /** Re-read the session's pending questions after a refused answer: the
   *  refusal (404/409) does not say WHY, and guessing is what loses an answer. */
  async function reopenOrExpireQuestion(callId: string): Promise<void> {
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(SESSION_KEY)}/question/pending`);
      if (res.status === 404) {
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
          deadline: still.timeoutSeconds ? Date.now() + still.timeoutSeconds * 1000 : undefined,
          error: t("cubepilot.chat.questionNotAccepted"),
        }));
        return;
      }
      patchQuestion(callId, (q) => ({ ...q, state: "expired", error: undefined }));
    } catch {
      patchQuestion(callId, (q) => ({ ...q, state: "pending", error: t("cubepilot.chat.questionRefreshFailed") }));
    }
  }

  async function submitQuestion(callId: string, answers: Record<string, string[]>, cancel: boolean): Promise<void> {
    patchQuestion(callId, (q) => ({ ...q, state: "submitting", answers: cancel ? q.answers : answers, error: undefined }));
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(SESSION_KEY)}/question`, {
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

  /** Abort the session's turn, reporting the server's own refusal. */
  async function abortTurn(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await fetch(`/api/cubepilot/pilot/api/v1/sessions/${enc(SESSION_KEY)}/abort`, { method: "POST" });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }

  /** Stop the turn this surface is streaming. Its own stream ends when the
   *  server settles it, and that is the feedback the user gets; a refused
   *  abort is reported, because then the stream will NOT end. */
  async function stopOwn(): Promise<void> {
    const res = await abortTurn();
    if (!res.ok) showToast(res.error, "error");
  }

  async function stopElsewhere(): Promise<void> {
    if (stoppingElsewhere) return;
    const gen = genRef.current;
    setStoppingElsewhere(true);
    const res = await abortTurn();
    if (genRef.current !== gen) return;
    setStoppingElsewhere(false);
    if (!res.ok) {
      // Refused, so the turn is still running: the Stop stays on screen for
      // another try, with the server's own reason reported.
      showToast(res.error, "error");
      return;
    }
    // The stop landed: nothing is running any more, and the turn it ended
    // exists only in the history the abort has just persisted.
    setRunningElsewhere(false);
    // The panel is still open, so the conversation must still be watched:
    // a turn started elsewhere later on has to be noticed by this surface
    // too. Restarting also retires any tick that is already in flight.
    startFollowing(SESSION_KEY);
    genRef.current++;
    await loadAgentHistory(SESSION_KEY);
  }

  // ── send ─────────────────────────────────────────────────────────────────

  function sendMessage(presetText?: string): void {
    const el = inputEl.current;
    const text = (presetText ?? el?.value ?? "").trim();
    if (!text || sending) return;
    // A Stop is in flight, so the turn it is stopping is still running
    // server-side: refusing here is what keeps this send from racing it.
    if (stoppingElsewhere) return;

    const gen = ++genRef.current;
    const agentMsgId = nextId();
    setSending(true);
    void (async () => {
      // A send into a session whose turn is still running is either refused
      // with a 409 or has its text steered into the running turn and
      // swallowed. So the turn is stopped first, and the message goes out on a
      // session that has settled.
      if (runningElsewhere || turnCheckFailed) {
        const res = await abortTurn();
        if (genRef.current !== gen) return;
        if (!res.ok && runningElsewhere) {
          // Refused on a turn the server CONFIRMED: the Stop is on screen and
          // is the control that ends that turn, so the message stays in the
          // box for another try.
          setSending(false);
          return;
        }
        if (res.ok) {
          setRunningElsewhere(false);
          // The panel is still open, so the conversation must still be
          // watched. This loop is also what retires `ownTurnRef` once the
          // turn the send below starts has ended — nothing else does.
          startFollowing(SESSION_KEY);
          await loadAgentHistory(SESSION_KEY);
          if (genRef.current !== gen) return;
        }
      }
      // From here this surface drives the turn, and its own stream is the
      // state: the no-stream status described the turn being left behind.
      setRunningElsewhere(false);
      setTurnCheckFailed(false);
      ownTurnRef.current = true;
      followingRef.current = false;
      setMsgs((m) => [...m, { id: nextId(), role: "user", text }, newAgentMsg(agentMsgId)]);
      setInput("");
      if (el) el.style.height = "auto";
      void sendAgent(text, gen, agentMsgId).finally(() => {
        if (genRef.current === gen) setSending(false);
      });
    })();
  }

  // ── derived ──────────────────────────────────────────────────────────────

  const lastAgent = [...msgs].reverse().find((m): m is AgentMsg => m.role === "agent");
  const waiting = waitingOnUser(msgs);
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

  // Only while something on screen actually moves: a live turn, or a parked
  // card with a countdown to run. An idle panel must not re-render every
  // second for nothing.
  const anyLive =
    msgs.some((m) => m.role === "agent" && m.phase !== "done") ||
    msgs.some((m) => m.role === "agent" && m.questions.some((q) => (q.state === "pending" || q.state === "submitting") && q.deadline !== undefined)) ||
    msgs.some((m) => m.role === "agent" && m.approvals.some((a) => (a.state === "pending" || a.state === "deciding") && a.expiresAtMs !== undefined));
  useEffect(() => {
    if (!open || !anyLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, anyLive]);

  // The cards the transcript is still parked on, from EVERY turn in it — the
  // same collection the chat tab docks, oldest first by the gateway's stamp.
  const dockApprovals = msgs
    .flatMap((m) => (m.role === "agent" ? openApprovals(m) : []))
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  const dockQuestions = msgs.flatMap((m) => (m.role === "agent" ? openQuestions(m) : []));

  // The mockup's quick prompts, offered until the conversation has one.
  const fresh = !msgs.some((m) => m.role === "user");

  return (
    <Fragment>
      {/* Launcher: the mockup's purple "summon the assistant" button, fixed to
          the bottom-right corner of every page the shell serves. */}
      <Box
        component="button"
        type="button"
        data-od-id="fchat-fab"
        aria-expanded={open}
        aria-label={open ? t("fchat.close") : t("fchat.open")}
        title={open ? t("fchat.close") : t("fchat.open")}
        onClick={open ? closePanel : openPanel}
        sx={{
          position: "fixed",
          right: "20px",
          bottom: "20px",
          zIndex: 40,
          width: "52px",
          height: "52px",
          borderRadius: "50%",
          border: 0,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          background: "linear-gradient(135deg, var(--violet), var(--accent))",
          boxShadow: "0 8px 24px color-mix(in oklch, var(--violet) 45%, transparent)",
          cursor: "pointer",
          transition: "transform 120ms ease, box-shadow 120ms ease",
          "&:hover": { transform: "translateY(-1px)" },
          "&:active": { transform: "translateY(0)" },
        }}
      >
        {open ? Icons.close({ size: 20 }) : Icons.spark({ size: 22 })}
      </Box>

      {open ? (
        <Box
          data-od-id="fchat-panel"
          role="dialog"
          aria-label={t("fchat.title")}
          sx={{
            position: "fixed",
            right: "20px",
            bottom: "84px",
            zIndex: 40,
            width: "min(460px, calc(100vw - 40px))",
            height: "min(680px, calc(100dvh - 120px))",
            display: "flex",
            flexDirection: "column",
            bgcolor: "background.default",
            color: "text.primary",
            border: 1,
            borderColor: "divider",
            borderRadius: "16px",
            boxShadow: (theme) =>
              `0 2px 6px ${theme.palette.mode === "dark" ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.08)"}, 0 16px 48px ${
                theme.palette.mode === "dark" ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.14)"
              }`,
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              px: "14px",
              py: "11px",
              borderBottom: 1,
              borderColor: "divider",
              bgcolor: "var(--surface)",
              flex: "none",
            }}
          >
            <Box
              aria-hidden
              sx={{
                width: "28px",
                height: "28px",
                borderRadius: "8px",
                display: "grid",
                placeItems: "center",
                color: "#fff",
                flex: "none",
                bgcolor: "var(--violet-solid)",
              }}
            >
              {Icons.spark({ size: 14 })}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Box sx={{ fontSize: 13.5, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t("fchat.title")}
              </Box>
              <Box sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {agentRoleLine(agentStatus, t)}
              </Box>
            </Box>
            <Box
              component="button"
              type="button"
              data-od-id="fchat-close"
              aria-label={t("fchat.close")}
              onClick={closePanel}
              sx={{
                border: 0,
                bgcolor: "transparent",
                color: "text.secondary",
                p: "4px",
                borderRadius: "6px",
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
                flex: "none",
                "&:hover": { bgcolor: "action.hover", color: "text.primary" },
              }}
            >
              {Icons.close({ size: 16 })}
            </Box>
          </Box>

          {/* The state of the turn, in the card's own frame: the thread scrolls,
              and this line is read exactly when a long turn has been quiet. */}
          <Box
            data-od-id="fchat-status"
            aria-live="polite"
            sx={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              px: "14px",
              py: "7px",
              borderBottom: 1,
              borderColor: "divider",
              flex: "none",
            }}
          >
            <Pill variant={STATUS_PILL[status.tone]} dot pulse={status.tone === "run"}>
              {t(status.key, status.vars)}
            </Pill>
            {turnCheckFailed ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: "4px", ml: "auto" }}>
                <Btn variant="ghost" small onClick={retryTurnCheck}>
                  {t("cubepilot.chat.retry")}
                </Btn>
                <Btn variant="ghost" small onClick={dismissTurnCheck}>
                  {t("cubepilot.chat.dismiss")}
                </Btn>
              </Box>
            ) : null}
          </Box>

          {/* Thread */}
          <Box
            ref={threadEl}
            data-od-id="fchat-thread"
            aria-live="polite"
            sx={{
              flex: "1 1 auto",
              minHeight: "60px",
              overflowY: "auto",
              p: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              bgcolor: "var(--surface)",
            }}
          >
            {agentNotice ? (
              <Box
                sx={{
                  alignSelf: "flex-start",
                  maxWidth: "82%",
                  p: "9px 12px",
                  borderRadius: "var(--radius)",
                  border: "1px dashed",
                  borderColor: "divider",
                  fontSize: 12.5,
                  color: "text.secondary",
                }}
              >
                {agentNotice}
              </Box>
            ) : null}
            {/* The transcript is AgentThread's to draw: its bubbles, its text,
                its tool cards and the cards it settled. */}
            <AgentThread msgs={msgs} sessionKey={SESSION_KEY} now={now} />
            {fresh ? (
              <Box data-od-id="fchat-quick" sx={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <Box sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary" }}>{t("fchat.tryAsk")}</Box>
                {QUICK_PROMPTS.map((key) => (
                  <Box
                    key={key}
                    component="button"
                    type="button"
                    data-od-id={`fchat-qp-${key.slice(-1)}`}
                    onClick={() => sendMessage(t(key))}
                    sx={{
                      textAlign: "left",
                      fontFamily: "inherit",
                      fontSize: 11.5,
                      lineHeight: 1.5,
                      color: "var(--violet-text)",
                      border: 1,
                      borderColor: "divider",
                      borderRadius: "10px",
                      p: "7px 10px",
                      cursor: "pointer",
                      transition: "border-color 120ms ease, background-color 120ms ease",
                      "&:hover": {
                        borderColor: "var(--violet-bd)",
                        bgcolor: "color-mix(in oklch, var(--violet) 7%, transparent)",
                      },
                    }}
                  >
                    👉 {t(key)}
                  </Box>
                ))}
              </Box>
            ) : null}
          </Box>

          {/* Dock + composer */}
          <Box sx={{ p: "10px 12px 12px", borderTop: 1, borderColor: "divider", flex: "none" }}>
            {/* The cards a turn is parked on, docked above the composer: the
                thread scrolls, so a card drawn in it is a card the user has to
                go looking for. */}
            <HitlDock
              approvals={dockApprovals}
              questions={dockQuestions}
              sessionKey={SESSION_KEY}
              now={now}
              allowAlwaysOk={allowAlwaysOk}
              onDecide={(callId, decision) => void decideApproval(callId, decision)}
              onAnswer={(callId, answers, cancel) => void submitQuestion(callId, answers, cancel)}
            />
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                border: 1,
                borderColor: "divider",
                borderRadius: "14px",
                bgcolor: "background.default",
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
                data-od-id="fchat-input"
                sx={{
                  width: "100%",
                  resize: "none",
                  border: 0,
                  boxShadow: "none",
                  bgcolor: "transparent",
                  padding: "6px 4px",
                  minHeight: "32px",
                  maxHeight: "96px",
                  fontSize: 13,
                  "&:focus": { borderColor: "divider", boxShadow: "none" },
                }}
              />
              <Box sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Box sx={{ flex: 1 }} />
                {sending || (runningElsewhere && !turnCheckFailed) ? (
                  <Btn
                    variant="secondary"
                    small
                    disabled={stoppingElsewhere}
                    onClick={() => void (sending ? stopOwn() : stopElsewhere())}
                    data-od-id="fchat-stop"
                  >
                    {t("cubepilot.chat.stop")}
                  </Btn>
                ) : (
                  <Btn variant="primary" small disabled={sending} onClick={() => sendMessage()} data-od-id="fchat-send">
                    {t("cubepilot.chat.send")}
                  </Btn>
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      ) : null}

      {toastView}
    </Fragment>
  );
}
