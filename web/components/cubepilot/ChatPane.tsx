"use client";

// 聊天 tab — the unified conversation surface for inference models and the
// CubePilot agent, mirroring public/chat.html: object list (gateway models
// + AI assistant) | chat card | context rail that follows the selected
// object (model: sampling params / cURL; agent: status / tool whitelist /
// recent calls / approval).
//
// Model side: the object list is the real model catalog from the AI Gateway
// (/api/cubepilot/playground/services → gateway /v1/models), and replies are
// real streamed completions proxied through /api/cubepilot/playground/chat
// (SSE). The agent side is canned block playback (greeting, three scenarios
// with action buttons, generic fallback) with no route behind it, matching
// the prototype. Conversations are ephemeral: switching objects resets the
// thread.

import { Box, SxProps, Theme } from "@mui/material";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  agentChips,
  agentGreeting,
  agentScenario,
  getAgentDemo,
  modelChips,
} from "@/lib/cubepilot/store";
import type {
  AgentBlock,
  GatewayModel,
  QuickChip,
} from "@/lib/cubepilot/types";
import { useI18n } from "@/lib/i18n";

import {
  ApiCard,
  CopyBtn,
  gatewayCurl,
  ParamsCard,
  SampleParams,
} from "./Playground";
import { setStoredTab } from "./tabStore";
import { Btn, Card, CardHead, CpTextArea, Icons, Pill, monoSx, useToast } from "./ui";

// The portal tokens have no violet; one hue + color-mix against var(--fg)
// adapts to the theme (dark violet on light, light violet on dark).
const VIOLET = "oklch(0.55 0.2 290)";
const VIOLET_BORDER = `color-mix(in oklch, ${VIOLET} 55%, var(--border))`;
const VIOLET_TEXT = `color-mix(in oklch, ${VIOLET} 75%, var(--fg))`;
const VIOLET_SOFT = `color-mix(in oklch, ${VIOLET} 9%, transparent)`;
const ACCENT_FILL = "color-mix(in oklch, var(--accent) 82%, var(--fg))";
const RO_COLOR = "color-mix(in oklch, oklch(0.6 0.18 155) 75%, var(--fg))";
const RW_COLOR = "color-mix(in oklch, oklch(0.68 0.16 75) 75%, var(--fg))";
const RW_BORDER = "color-mix(in oklch, oklch(0.68 0.16 75) 42%, var(--border))";

// Static demo content, consumed once at module load (never mutated).
const AGENT_DEMO = getAgentDemo();
const MODEL_CHIPS = modelChips();
const AGENT_CHIPS = agentChips();

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

/** One thread message. Agent messages grow block by block during playback. */
type ChatMsg =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "model"; text: string; meta?: string; notice?: boolean }
  | { id: number; role: "agent"; blocks: AgentBlock[]; usedAction: string | null };

const groupLabelSx: SxProps<Theme> = {
  ...monoSx,
  fontSize: 10.5,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "text.secondary",
  pb: "6px",
  pl: "2px",
};

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
  /** Partial reply text while the SSE stream is in flight; null = idle. */
  const [streaming, setStreaming] = useState<string | null>(null);
  const [copied, setCopied] = useState<"endpoint" | "curl" | null>(null);
  const [params, setParams] = useState<SampleParams>({ temperature: 0.7, topP: 0.9, maxTokens: 1024 });

  const inputEl = useRef<HTMLTextAreaElement | null>(null);
  const threadEl = useRef<HTMLDivElement | null>(null);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against in-flight fetch/stream/playback from a previous object.
  const genRef = useRef(0);
  const idRef = useRef(0);

  const agent = AGENT_DEMO.agent;
  const svc = models.find((s) => s.id === svcId) ?? null;
  const endpointText = endpoint ? `${endpoint}/v1/chat/completions` : "";
  const isModel = objKind === "model";

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

  function cancelPlayback(): void {
    genRef.current++;
    if (playTimer.current) clearTimeout(playTimer.current);
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
    cancelPlayback();
    setObjKind("model");
    setSvcId(next.id);
    setMsgs([
      { id: nextId(), role: "model", text: t("cubepilot.playground.switched", { name: next.id }), notice: true },
    ]);
  }

  function selectAgent(): void {
    cancelPlayback();
    setObjKind("agent");
    setSvcId(null);
    setMsgs([]);
    playAgentBlocks(agentGreeting());
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
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    void loadModels();
    return () => {
      cancelPlayback();
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  /** Play canned blocks into a fresh agent message (60ms, then 380ms steps). */
  const playAgentBlocks = useCallback(
    (blocks: AgentBlock[], onDone?: () => void): void => {
      const gen = genRef.current;
      const id = nextId();
      setMsgs((m) => [...m, { id, role: "agent", blocks: [], usedAction: null }]);
      let i = 0;
      const step = () => {
        if (genRef.current !== gen) return;
        if (i >= blocks.length) {
          onDone?.();
          return;
        }
        const block = blocks[i];
        i++;
        setMsgs((m) => m.map((x) => (x.id === id && x.role === "agent" ? { ...x, blocks: [...x.blocks, block] } : x)));
        if (i < blocks.length) playTimer.current = setTimeout(step, 380);
        else onDone?.();
      };
      playTimer.current = setTimeout(step, 60);
    },
    [nextId],
  );

  function clearChat(): void {
    if (!objKind) return;
    cancelPlayback();
    if (isModel) {
      if (svc) setMsgs([{ id: nextId(), role: "model", text: t("cubepilot.playground.cleared"), notice: true }]);
    } else {
      setMsgs([]);
      playAgentBlocks(agentGreeting());
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

  /** Keyword → scenario, same rules as the prototype's detectAgentKey. */
  function detectScenario(text: string): string | null {
    const s = text.toLowerCase();
    if (/ceph|osd|存储|容量/.test(s)) return "ceph";
    if (/gpu|温度|compute|散热|风扇/.test(s)) return "gpu-temp";
    if (/升级|预检/.test(s)) return "pre-upgrade";
    return null;
  }

  const sendMessage = useCallback(
    (presetText?: string, presetKey?: string) => {
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
        setMsgs((m) => [...m, { id: nextId(), role: "user", text }]);
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
        setMsgs((m) => [...m, { id: nextId(), role: "user", text }]);
        setInput("");
        if (el) el.style.height = "auto";
        setSending(true);
        setThinkingText(t("cubepilot.chat.thinkingAgent"));
        playTimer.current = setTimeout(() => {
          if (genRef.current !== gen) return;
          setThinkingText(null);
          playAgentBlocks(agentScenario(presetKey ?? detectScenario(text)), () => {
            if (genRef.current === gen) setSending(false);
          });
        }, 650);
      }
    },
    [msgs, objKind, svc, sending, params, nextId, playAgentBlocks, showToast, t],
  );

  /** Click an action button: append its canned results, mark it used. */
  function clickAction(msgId: number, blockIdx: number, actionIdx: number): void {
    setMsgs((m) =>
      m.map((x) => {
        if (x.id !== msgId || x.role !== "agent") return x;
        const action = x.blocks[blockIdx]?.actions?.[actionIdx];
        if (!action || x.usedAction) return x;
        return { ...x, usedAction: `${blockIdx}:${actionIdx}`, blocks: [...x.blocks, ...action.results] };
      }),
    );
  }

  const chips: QuickChip[] = isModel ? MODEL_CHIPS : AGENT_CHIPS;
  const objName = objKind === "agent" ? agent.name : (svc?.id ?? "—");
  const objRole =
    objKind === "agent"
      ? t("cubepilot.chat.roleAgent", { role: agent.role, beat: String(agent.heartbeat) })
      : svc
        ? t("cubepilot.chat.roleModel")
        : "";

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
            aria-pressed={objKind === "agent"}
            data-od-id={`obj-${agent.id}`}
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
              background: objKind === "agent" ? VIOLET_SOFT : "background.default",
              borderColor: objKind === "agent" ? VIOLET_BORDER : "divider",
              "&:hover": { borderColor: objKind === "agent" ? VIOLET_BORDER : "text.primary" },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <Box sx={{ fontSize: 13.5, fontWeight: 600 }}>{agent.name}</Box>
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
            <Box sx={{ ...monoSx, fontSize: 11, color: "text.secondary", mt: "5px", lineHeight: 1.5 }}>
              {agent.role} · {agent.ro} {t("cubepilot.chat.scopeRo")} + {agent.rw} {t("cubepilot.chat.scopeRw")}
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
                  bgcolor: objKind === "agent" ? VIOLET : ACCENT_FILL,
                }}
              >
                {objKind === "agent" ? Icons.spark({ size: 15 }) : Icons.cube({ size: 15 })}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ fontSize: 14, fontWeight: 650 }}>{objName}</Box>
                <Box sx={{ fontSize: 11, color: "text.secondary" }}>{objRole}</Box>
              </Box>
              {objKind ? (
                <Pill variant="ok" dot sx={{ ml: "4px" }}>
                  {isModel ? t("cubepilot.playground.ready") : t("cubepilot.chat.statusOnline")}
                </Pill>
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
                  onClick={() => sendMessage(c.label, c.key)}
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
                  {m.blocks.map((b, bi) => (
                    <Fragment key={bi}>
                      {b.p ? <Box sx={{ mt: bi === 0 ? 0 : "8px" }}>{b.p}</Box> : null}
                      {b.cmd ? (
                        <Box
                          component="pre"
                          sx={{
                            m: "10px 0 2px",
                            bgcolor: "text.primary",
                            color: "color-mix(in oklch, var(--bg) 85%, transparent)",
                            borderRadius: 6,
                            p: "9px 12px",
                            ...monoSx,
                            fontSize: 11.5,
                            overflowX: "auto",
                            whiteSpace: "pre",
                            lineHeight: 1.7,
                          }}
                        >
                          {b.cmd}
                        </Box>
                      ) : null}
                      {b.out ? (
                        <Box
                          sx={{
                            m: "10px 0 2px",
                            border: 1,
                            borderColor: "divider",
                            borderRadius: 6,
                            bgcolor: "var(--surface)",
                            p: "9px 12px",
                            ...monoSx,
                            fontSize: 11,
                            color: "text.secondary",
                            lineHeight: 1.8,
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {b.out}
                        </Box>
                      ) : null}
                      {b.meta ? (
                        <Box sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", mt: "8px" }}>{b.meta}</Box>
                      ) : null}
                      {b.actions ? (
                        <Box sx={{ display: "flex", gap: "8px", mt: "10px", flexWrap: "wrap" }}>
                          {b.actions.map((a, ai) => {
                            const key = `${bi}:${ai}`;
                            const used = m.usedAction !== null;
                            const isThis = m.usedAction === key;
                            return (
                              <Box
                                key={key}
                                component="button"
                                type="button"
                                disabled={used}
                                onClick={() => clickAction(m.id, bi, ai)}
                                data-od-id={isThis ? "action-done" : "action-btn"}
                                sx={{
                                  fontSize: 12,
                                  fontWeight: 550,
                                  border: 1,
                                  borderRadius: 6,
                                  p: "5px 12px",
                                  cursor: used ? "default" : "pointer",
                                  opacity: used && !isThis ? 0.5 : 1,
                                  ...(a.primary && !used
                                    ? { bgcolor: "text.primary", color: "background.default", borderColor: "text.primary" }
                                    : { bgcolor: "background.default", color: "text.primary", borderColor: "divider" }),
                                  "&:hover": { borderColor: "text.primary" },
                                }}
                              >
                                {isThis ? a.doneLabel : a.label}
                              </Box>
                            );
                          })}
                        </Box>
                      ) : null}
                    </Fragment>
                  ))}
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
            <Btn variant="primary" disabled={sending || !objKind} onClick={() => sendMessage()} data-od-id="send-btn">
              {t("cubepilot.chat.send")}
            </Btn>
          </Box>
        </Card>

        {/* ── context rail ── */}
        {objKind === "agent" ? (
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
                  <Box sx={{ fontSize: 14, fontWeight: 650 }}>{agent.name}</Box>
                  <Box sx={{ fontSize: 11.5, color: "text.secondary" }}>{agent.role}</Box>
                </Box>
                <Box sx={{ ml: "auto", textAlign: "right", ...monoSx, fontSize: 10.5, color: "text.secondary", lineHeight: 1.6 }}>
                  {t("cubepilot.chat.heartbeat", { beat: String(agent.heartbeat) })}
                  <br />
                  {t("cubepilot.chat.statusLabel", { status: t("cubepilot.chat.statusOnline") })}
                </Box>
              </Box>
              <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
                <Box sx={{ p: "12px 18px", borderTop: 1, borderColor: "divider", borderRight: 1 }}>
                  <Box sx={{ fontSize: 11, color: "text.secondary" }}>{t("cubepilot.chat.railRo")}</Box>
                  <Box sx={{ ...monoSx, fontSize: 18, fontWeight: 650, letterSpacing: "-0.02em", mt: "3px" }}>{agent.ro}</Box>
                </Box>
                <Box sx={{ p: "12px 18px", borderTop: 1, borderColor: "divider" }}>
                  <Box sx={{ fontSize: 11, color: "text.secondary" }}>{t("cubepilot.chat.railRw")}</Box>
                  <Box sx={{ ...monoSx, fontSize: 18, fontWeight: 650, letterSpacing: "-0.02em", mt: "3px" }}>{agent.rw}</Box>
                </Box>
              </Box>
            </Card>

            <Card data-od-id="tool-whitelist-card">
              <CardHead
                title={t("cubepilot.chat.railWhitelist")}
                hint={t("cubepilot.chat.railTotal", { count: String(agent.ro + agent.rw) })}
              />
              {AGENT_DEMO.tools.map((tool) => (
                <Box
                  key={tool.name}
                  sx={{ display: "flex", alignItems: "center", gap: "10px", p: "9px 18px", borderTop: 1, borderColor: "divider", fontSize: 12.5 }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>{tool.name}</Box>
                  <Box sx={{ ...monoSx, fontSize: 10.5, color: tool.scope === "ro" ? RO_COLOR : RW_COLOR }}>
                    {tool.scope === "ro" ? t("cubepilot.chat.scopeRo") : t("cubepilot.chat.scopeRw")}
                  </Box>
                </Box>
              ))}
            </Card>

            <Card data-od-id="recent-calls-card">
              <CardHead title={t("cubepilot.chat.railCalls")} hint={t("cubepilot.chat.railCallsWindow")} />
              {AGENT_DEMO.calls.map((c) => (
                <Box
                  key={c.time + c.tool}
                  sx={{ display: "flex", alignItems: "center", gap: "10px", p: "9px 18px", borderTop: 1, borderColor: "divider" }}
                >
                  <Box sx={{ ...monoSx, fontSize: 10.5, color: "text.secondary", flex: "none" }}>{c.time}</Box>
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      ...monoSx,
                      fontSize: 11.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.tool}
                  </Box>
                  <Box
                    sx={{
                      flex: "none",
                      ...monoSx,
                      fontSize: 10,
                      px: "7px",
                      py: "1px",
                      borderRadius: 999,
                      border: 1,
                      borderColor: c.scope === "rw" ? RW_BORDER : "divider",
                      color: c.scope === "rw" ? RW_COLOR : "text.secondary",
                      bgcolor: c.scope === "rw" ? `color-mix(in oklch, oklch(0.68 0.16 75) 10%, transparent)` : "transparent",
                    }}
                  >
                    {c.scope.toUpperCase()}
                  </Box>
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
                <Box sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.6 }}>
                  {t("cubepilot.chat.railApprovalNote")}
                </Box>
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
