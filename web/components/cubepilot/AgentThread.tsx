"use client";

// The agent's side of the thread: one bubble per turn, its blocks in the order
// they arrived, a card per tool call, and the turn's closing text as a panel.
//
// The blocks themselves come from lib/cubepilot/agentThread — the model already
// decided that a turn is an ordered list of text and tool blocks rather than a
// text string plus a tools array. This file only draws them, and draws them in
// array order: flattening tools into their own list is what made a turn's
// narration render as a paragraph above a tool call it had actually followed.
//
// Approvals and questions dock under the composer while they are still open —
// an agent bubble is a record of what happened, and a card that still needs an
// answer belongs where the answer can be given without hunting for it. Once
// settled, the card is exactly that record, and this is where it is drawn: next
// to the work it let through, not in the composer.

import { Box } from "@mui/material";
import { Fragment, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { toolSummary } from "@/lib/cubepilot/agentThread";
import type { AgentApproval, AgentBlock, AgentMsg, AgentQuestion, ThreadMsg } from "@/lib/cubepilot/agentThread";
import { useI18n } from "@/lib/i18n";

import { ApprovalCard, QuestionCard } from "./HitlDock";
import { Icons, Pill, monoSx } from "./ui";

/** A user turn, right-aligned and inverted (prototype chat.html:208). */
const userBubbleSx = {
  alignSelf: "flex-end",
  maxWidth: "82%",
  p: "11px 14px",
  borderRadius: "var(--radius)",
  borderBottomRightRadius: 2,
  bgcolor: "text.primary",
  color: "background.default",
  fontSize: 13.5,
  lineHeight: 1.6,
} as const;

/** An agent turn, left-aligned, bordered in the agent's own hue
 *  (prototype chat.html:210 — the same 42% mix globals.css names --violet-bd).
 *
 *  minWidth is a FLOOR, and it is load-bearing. A bubble with only maxWidth is
 *  shrink-to-fit, so a turn whose whole content is one collapsed tool card
 *  collapses to that card: measured at 193px inside a 1442px thread, held for
 *  as long as the model took to write its closing text, then jumping to 1153px.
 *  The card looked broken for those seconds. The floor keeps the transcript's
 *  left edge stable while the turn is still producing; `min()` stops it from
 *  beating maxWidth on a narrow screen, where 82% is the smaller of the two. */
const agentBubbleSx = {
  alignSelf: "flex-start",
  minWidth: "min(560px, 82%)",
  maxWidth: "82%",
  p: "11px 14px",
  borderRadius: "var(--radius)",
  borderBottomLeftRadius: 2,
  bgcolor: "background.default",
  border: "1px solid var(--violet-bd)",
  fontSize: 13.5,
  lineHeight: 1.65,
  wordBreak: "break-word",
} as const;

/** One tool invocation: a header that can be collapsed, then — only once the
 *  reader asks for it — the command it ran and what came back. */
function ToolCard({
  block,
  running,
  open,
  onToggle,
}: {
  block: Extract<AgentBlock, { kind: "tool" }>;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  // A tool that never returned because the turn ended is not "running" forever:
  // it is stopped, and saying so is the difference between "wait" and "gone".
  const pill = running
    ? { variant: "accent" as const, label: t("cubepilot.chat.toolRunning"), pulse: true }
    : block.done
      ? { variant: "ok" as const, label: t("cubepilot.chat.toolDone"), pulse: false }
      : { variant: "neutral" as const, label: t("cubepilot.chat.toolStopped"), pulse: false };
  // What it ran, on the header itself: "exec" alone names the tool and not the
  // work, and a reader had to open every card — and close it again — to find out
  // which command produced the output they were scanning for. The card is still
  // collapsed by default; this is the label on the closed drawer.
  const summary = toolSummary(block.args);
  return (
    <Box
      data-od-id="tool-card"
      sx={{ border: 1, borderColor: "var(--violet-bd)", borderRadius: "6px", bgcolor: "color-mix(in oklch, var(--violet) 9%, transparent)", overflow: "hidden" }}
    >
      <Box
        component="button"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? t("cubepilot.chat.collapseTool") : t("cubepilot.chat.expandTool")}
        data-od-id="tool-card-head"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          border: 0,
          bgcolor: "transparent",
          color: "text.primary",
          fontFamily: "inherit",
          textAlign: "left",
          p: "8px 12px",
          cursor: "pointer",
        }}
      >
        <Box sx={{ color: "var(--violet-text)", display: "flex", flex: "none" }}>{Icons.tool({ size: 13 })}</Box>
        <Box sx={{ ...monoSx, fontSize: 11.5, fontWeight: 600, flex: "none", whiteSpace: "nowrap" }}>
          {block.name}
        </Box>
        {summary ? (
          <Box
            component="span"
            data-od-id="tool-card-command"
            // The full summary on hover, for a command the row is too narrow to
            // finish. Not the whole args: a multi-line command would put eight
            // lines in a tooltip, and the open card is where that belongs.
            title={summary}
            sx={{
              ...monoSx,
              fontSize: 11.5,
              fontWeight: 400,
              color: "text.secondary",
              // Shrinks before anything else: the tool's name and its status must
              // both stay whole, and only the command has a longer form behind a
              // click.
              minWidth: 0,
              flex: "1 1 auto",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </Box>
        ) : (
          <Box component="span" sx={{ flex: "1 1 auto" }} />
        )}
        <Pill variant={pill.variant} dot pulse={pill.pulse} sx={{ flex: "none" }}>
          {pill.label}
        </Pill>
        <Box component="span" aria-hidden sx={{ ...monoSx, fontSize: 10, color: "text.secondary", flex: "none" }}>
          {open ? "▾" : "▸"}
        </Box>
      </Box>
      {open ? (
        <Box sx={{ px: "12px", pb: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {block.args ? (
            <Box
              component="pre"
              sx={{
                m: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                lineHeight: 1.7,
                // The command, in the softened treatment the fenced blocks got:
                // a tinted box with a violet left bar, not an inverted --fg block.
                bgcolor: "color-mix(in oklch, var(--violet) 8%, var(--surface))",
                borderLeft: "2px solid var(--violet-text)",
                borderRadius: "6px",
                p: "8px 10px",
                overflowX: "auto",
                whiteSpace: "pre",
              }}
            >
              {block.args}
            </Box>
          ) : null}
          {block.output !== undefined ? (
            <Box
              data-od-id="tool-output"
              sx={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.8,
                bgcolor: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                p: "8px 10px",
                // A long listing is the point of the card, but it must not push
                // the rest of the turn off the screen: it scrolls in place.
                maxHeight: 220,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                color: "text.secondary",
              }}
            >
              {block.output}
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

/** The agent's text as Markdown.
 *
 *  react-markdown rather than the hand-rolled Markdown.tsx: that one is a
 *  subset parser whose inline splitter mangles `**bold with `code` inside**`,
 *  which is ordinary LLM output, and agent output is arbitrary Markdown rather
 *  than the demo content it was written for. remarkBreaks keeps single newlines
 *  as breaks — chat text relies on it. Raw HTML is escaped by default.
 *
 *  Inline code is styled by CSS on the wrapper, NOT by a `code` component:
 *  react-markdown v10 passes no `inline` flag, and a fenced block written
 *  without a language carries no className either, so a component-level test
 *  cannot tell inline from block. CSS can — `pre code` resets what `& code` sets. */
function AgentMarkdown({ text }: { text: string }) {
  return (
    <Box
      sx={{
        fontSize: 13.5,
        lineHeight: 1.7,
        wordBreak: "break-word",
        "& > p:first-of-type": { mt: 0 },
        "& code": {
          fontFamily: "var(--font-mono)",
          fontSize: "0.92em",
          bgcolor: "color-mix(in oklch, var(--fg) 7%, transparent)",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          px: "4px",
        },
        "& pre code": { bgcolor: "transparent", border: 0, px: 0, fontSize: "inherit" },
      }}
    >
      <ReactMarkdown
        // remarkGfm MUST come first and MUST be present: without it a GFM table
        // renders as its raw pipe syntax, and the agent's answers are full of
        // them — its inspection replies lead with a service table. The renderer
        // this replaced (Markdown.tsx) handled tables, so omitting this was a
        // regression, not a simplification. remarkBreaks keeps single newlines
        // as breaks; chat text relies on it.
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => <Box component="p" sx={{ m: "8px 0" }}>{children}</Box>,
          ul: ({ children }) => <Box component="ul" sx={{ m: "8px 0", pl: "20px" }}>{children}</Box>,
          ol: ({ children }) => <Box component="ol" sx={{ m: "8px 0", pl: "20px" }}>{children}</Box>,
          li: ({ children }) => <Box component="li" sx={{ mt: "3px" }}>{children}</Box>,
          h1: ({ children }) => <Box component="h4" sx={{ m: "14px 0 6px", fontSize: 15, fontWeight: 650, lineHeight: 1.4 }}>{children}</Box>,
          h2: ({ children }) => <Box component="h5" sx={{ m: "14px 0 6px", fontSize: 14, fontWeight: 650, lineHeight: 1.4 }}>{children}</Box>,
          h3: ({ children }) => <Box component="h6" sx={{ m: "14px 0 6px", fontSize: 14, fontWeight: 650, lineHeight: 1.4 }}>{children}</Box>,
          // Tables carry the same treatment as Markdown.tsx's, so the chat and
          // the task reports render a table the same way.
          table: ({ children }) => (
            <Box sx={{ overflowX: "auto", my: "8px" }}>
              <Box component="table" sx={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%" }}>
                {children}
              </Box>
            </Box>
          ),
          thead: ({ children }) => <Box component="thead">{children}</Box>,
          tbody: ({ children }) => <Box component="tbody">{children}</Box>,
          tr: ({ children }) => <Box component="tr">{children}</Box>,
          th: ({ children }) => (
            <Box
              component="th"
              sx={{ textAlign: "left", borderBottom: "1px solid var(--border)", px: "10px", py: "6px", color: "text.secondary", fontWeight: 600 }}
            >
              {children}
            </Box>
          ),
          td: ({ children }) => (
            <Box component="td" sx={{ borderBottom: "1px solid var(--border)", px: "10px", py: "6px", verticalAlign: "top" }}>
              {children}
            </Box>
          ),
          a: ({ children, href }) => (
            <Box
              component="a"
              href={href}
              target="_blank"
              rel="noreferrer"
              sx={{ color: "var(--accent-strong)", textDecoration: "underline", textUnderlineOffset: "2px" }}
            >
              {children}
            </Box>
          ),
          // The same softened treatment Task 3 gave Markdown.tsx's fenced
          // blocks: a --surface box with a violet left bar, not the inverted
          // --fg block that was the loudest thing on the page.
          pre: ({ children }) => (
            <Box
              component="pre"
              sx={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                lineHeight: 1.7,
                bgcolor: "var(--surface)",
                border: "1px solid var(--border)",
                borderLeft: "2px solid var(--violet-text)",
                color: "var(--fg)",
                borderRadius: "6px",
                p: "10px 12px",
                overflowX: "auto",
                whiteSpace: "pre",
                m: "8px 0",
              }}
            >
              {children}
            </Box>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </Box>
  );
}

/** A card the dock no longer carries: it was decided, or the turn's end settled
 *  it with nobody having decided. Either way it is over, and what it records is
 *  the outcome of the work it introduced. */
const settledApproval = (a: AgentApproval): boolean => a.state !== "pending" && a.state !== "deciding";
const settledQuestion = (q: AgentQuestion): boolean => q.state !== "pending" && q.state !== "submitting";

/** One agent turn. */
function AgentBubble({
  msg,
  mi,
  sessionKey,
  now,
  openedTools,
  onToggleTool,
}: {
  msg: AgentMsg;
  mi: number;
  sessionKey: string | null;
  /** The pane's 1s ticker. A settled question shows no countdown, so nothing
   *  here needs it yet — but the card is the same component the dock draws live
   *  ones with, and it takes the same clock. */
  now: number;
  openedTools: Record<string, boolean>;
  onToggleTool: (key: string, open: boolean) => void;
}) {
  const { t } = useI18n();
  // The turn's closing text becomes a panel only when the turn also ran a tool:
  // with no tool in between there is nothing to close out, and boxing every
  // single-paragraph reply would make an ordinary answer look like a report.
  const ranTools = msg.blocks.some((b) => b.kind === "tool");
  // The LAST block must be text: "the turn ended with words". Testing only "this
  // is the last text block" would highlight a turn's *opening* sentence when the
  // turn ended with a tool — reachable from `historyToMsgs`, whose restored
  // assistant bubble is [text, tool(done)], and from any stream that stops right
  // after a tool_result.
  const endsWithText = msg.blocks[msg.blocks.length - 1]?.kind === "text";
  const lastTextIndex = msg.blocks.reduce((acc, b, i) => (b.kind === "text" ? i : acc), -1);
  // Only a confirmed, clean end makes the closing text "the answer". A stopped
  // or failed turn is labelled as a reply, so a mid-turn snapshot can never
  // read as the result disappearing.
  const settled = msg.phase === "done" && !msg.stopped && !msg.error && !msg.transportLost;

  // What this turn was let through — the cards it settled — sits between the
  // tool log and the closing answer, not under it. The reference draws them
  // there (ChatThread.tsx: tool cards, the resolved confirm, the resolved
  // questions, the superseded disclosure, then the answer panel), and it reads
  // the right way round: a record of "this write was allowed" belongs to the
  // work it permitted, not as a footnote to the conclusion. Putting it last also
  // pushed the answer panel up the screen, which is what a user noticed.
  //
  // The dock carries a card only while it is open; the same components draw
  // both, so a decided card looks the same in either place.
  const lastToolIndex = msg.blocks.reduce((acc, b, i) => (b.kind === "tool" ? i : acc), -1);
  const settledCards = (
    <>
      {msg.approvals.filter(settledApproval).map((a) => (
        <Box key={a.callId} sx={{ mt: "9px" }}>
          <ApprovalCard approval={a} />
        </Box>
      ))}
      {msg.questions.filter(settledQuestion).map((q) => (
        <Box key={q.callId} sx={{ mt: "9px" }}>
          <QuestionCard question={q} now={now} />
        </Box>
      ))}
    </>
  );

  return (
    <Box data-od-id="agent-bubble" sx={agentBubbleSx}>
      <Box
        sx={{
          ...monoSx,
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--violet-text)",
          mb: "6px",
        }}
      >
        CUBEPILOT
      </Box>
      {/* How this turn ended, when that is not simply "it ended". The header
          carries the two-word version of these; the bubble is where the detail
          lives, and where a turn that failed or was stopped is explained at all.
          A lost transport is not a turn outcome — the run may still be
          executing — so it gets the amber headline and keeps the stream's own
          reason underneath it as diagnostics, rather than presenting that reason
          as the turn's error. A stopped turn neither finished nor failed, so it
          gets the muted marker. A turn that ended cleanly gets none of them: an
          ordinary reply must not sprout a line saying so. */}
      {msg.error ? (
        <Box data-od-id="agent-error" sx={{ fontSize: 12.5, color: "var(--danger)", mb: "8px", whiteSpace: "pre-wrap" }}>
          {msg.error}
        </Box>
      ) : null}
      {msg.transportLost ? (
        <Box data-od-id="agent-lost" sx={{ mb: "8px" }}>
          <Box sx={{ fontSize: 12.5, color: "var(--warn)" }}>{t("cubepilot.chat.statusLost")}</Box>
          <Box sx={{ fontSize: 11.5, color: "text.secondary", mt: "2px", whiteSpace: "pre-wrap" }}>{msg.transportLost}</Box>
        </Box>
      ) : null}
      {msg.stopped ? (
        <Box data-od-id="agent-stopped" sx={{ fontSize: 12.5, color: "text.secondary", mb: "8px" }}>
          {t("cubepilot.chat.statusStopped")}
        </Box>
      ) : null}
      {/* The turn has produced nothing yet. Without this the bubble is a label
          over an empty box, which reads as a rendering fault rather than as a
          turn that is thinking. The header's "Thinking… {secs}s" answers a
          different question — whether the turn is still going — and does not
          stand in for it. */}
      {msg.phase === "thinking" && msg.blocks.length === 0 ? (
        <Box data-od-id="agent-thinking" sx={{ fontSize: 12.5, color: "text.secondary" }}>
          {t("cubepilot.chat.thinkingAgent")}
        </Box>
      ) : null}
      {msg.blocks.map((b, bi) => {
        if (b.kind === "tool") {
          const running = !b.done && msg.phase !== "done";
          const key = `${sessionKey ?? ""}-${b.callId || `p${mi}-${bi}`}`;
          const open = openedTools[key] ?? running;
          return (
            <Fragment key={bi}>
              <Box data-od-block="tool" sx={{ mt: bi > 0 ? "8px" : 0 }}>
                <ToolCard block={b} running={running} open={open} onToggle={() => onToggleTool(key, !open)} />
              </Box>
              {bi === lastToolIndex ? settledCards : null}
            </Fragment>
          );
        }
        const isPanel = ranTools && endsWithText && bi === lastTextIndex;
        return (
          <Box key={bi} data-od-block="text" sx={{ mt: bi > 0 ? "8px" : 0 }}>
            {b.superseded?.length ? (
              <Box component="details" data-od-id="superseded" sx={{ mb: "6px" }}>
                <Box component="summary" sx={{ ...monoSx, fontSize: 11, color: "text.secondary", cursor: "pointer" }}>
                  {t("cubepilot.chat.earlier", { count: b.superseded.length })}
                </Box>
                {b.superseded.map((s, si) => (
                  <Box key={si} sx={{ mt: "6px", fontSize: 12.5, color: "text.secondary", whiteSpace: "pre-wrap" }}>
                    {s}
                  </Box>
                ))}
              </Box>
            ) : null}
            {isPanel ? (
              <Box
                sx={{
                  border: "1px solid",
                  borderRadius: "6px",
                  p: "9px 11px",
                  ...(settled
                    ? { bgcolor: "var(--accent-soft)", borderColor: "color-mix(in oklch, var(--accent) 32%, var(--border))" }
                    : { bgcolor: "var(--surface)", borderColor: "var(--border)" }),
                }}
              >
                <Box
                  sx={{
                    ...monoSx,
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    mb: "4px",
                    color: settled ? "var(--accent-strong)" : "text.secondary",
                  }}
                >
                  {settled ? t("cubepilot.chat.finalResult") : t("cubepilot.chat.reply")}
                </Box>
                <AgentMarkdown text={b.text} />
              </Box>
            ) : (
              <AgentMarkdown text={b.text} />
            )}
          </Box>
        );
      })}
      {/* A turn with no tool blocks has no "after the last tool" to hang the
          settled cards on; the end of the bubble is where they read as the
          turn's own record. */}
      {lastToolIndex < 0 ? settledCards : null}
    </Box>
  );
}

export function AgentThread({
  msgs,
  sessionKey,
  now,
}: {
  msgs: ThreadMsg[];
  sessionKey: string | null;
  // `now` dates a running turn's status line (Task 7) and the countdown of any
  // question on a card. There are no decision dispatchers and no composer slot
  // to pass: the dock owns every card that can still be answered, and the ones
  // this component draws are settled, which is to say controls-free.
  now: number;
}) {
  const [openedTools, setOpenedTools] = useState<Record<string, boolean>>({});
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 }}>
      {msgs.map((m, mi) =>
        m.role === "user" ? (
          <Box key={m.id} sx={userBubbleSx}>
            {m.text}
          </Box>
        ) : (
          <AgentBubble
            key={m.id}
            msg={m}
            mi={mi}
            sessionKey={sessionKey}
            now={now}
            openedTools={openedTools}
            onToggleTool={(key, open) => setOpenedTools((prev) => ({ ...prev, [key]: open }))}
          />
        ),
      )}
    </Box>
  );
}
