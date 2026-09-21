"use client";

// The human-in-the-loop cards: the write approvals and ask-user questions a turn
// is parked on, and the dock they are drawn in.
//
// An unresolved card docks above the composer. The composer does not scroll, and
// each card carries its own scroller for a long command or a tall form with the
// decision buttons left OUTSIDE it — a card whose buttons have to be scrolled
// for is one the turn waits on for no reason. A settled card is a record of what
// was let through instead, so it leaves the dock and AgentThread draws it inside
// the bubble that raised it; that is why the two cards are exported from here
// rather than being private to the dock.

import { Box } from "@mui/material";
import { useState } from "react";

import {
  approvalExpiring,
  approvalSecondsLeft,
  isExpiring,
  remainingSeconds,
  seedAnswers,
  type AgentApproval,
  type AgentQuestion,
} from "@/lib/cubepilot/agentThread";
import type { AgentQuestionItem } from "@/lib/cubepilot/types";
import { useI18n } from "@/lib/i18n";

import { fmtSeconds } from "./format";
import { Btn, CpInput, Pill, STATUS_WARN, monoSx } from "./ui";

export type ApprovalDecision = "approve" | "reject" | "allow-always";
export type ApprovalHandler = (callId: string, decision: ApprovalDecision) => void;
/** `cancel` is the dismiss path: let the agent continue without an answer. */
export type AnswerHandler = (callId: string, answers: Record<string, string[]>, cancel: boolean) => void;

/** One write-approval card: awaiting a decision, or the record of one that was
 *  made (or that the turn's end settled as made by nobody).
 *
 *  The decision handlers are optional because a settled card draws no controls:
 *  the dock is the only place a live card is drawn, and it always passes them. */
export function ApprovalCard({
  approval,
  now,
  allowAlwaysOk = false,
  onDecide,
}: {
  approval: AgentApproval;
  /** The dock's 1 Hz ticker: the countdown below is a live number. */
  now: number;
  allowAlwaysOk?: boolean;
  onDecide?: ApprovalHandler;
}) {
  const { t } = useI18n();
  const open = approval.state === "pending" || approval.state === "deciding";
  const deciding = approval.state === "deciding";
  // The gateway expires a held write (thirty minutes) and the run it was gating
  // dies with it — which is how a command ends up "interrupted" with nothing the
  // user did. A countdown is what says the choice is not open forever. The
  // reference draws no timer here at all; this is ours, from the stamp the
  // approval now carries.
  const secsLeft = approvalSecondsLeft(approval, now);
  const expiring = approvalExpiring(approval, now);
  // A settle nobody decided is NOT a rejection: it comes either from a decision
  // that lost its race with the server's own settle (404) or from the server
  // closing the record when the turn ended, and in both cases the user made no
  // call to report back to them.
  const label =
    approval.state === "approved"
      ? t("cubepilot.chat.approvalApproved")
      : approval.state === "rejected"
        ? t("cubepilot.chat.approvalRejected")
        : t("cubepilot.chat.approvalStopped");
  const tone = approval.state === "approved" ? "ok" : approval.state === "rejected" ? "danger" : "neutral";
  // A settled card is a RECORD, so it collapses to its one-line header and opens
  // only if the reader wants the command back — the shape a tool card already
  // has. An open card is a CONTROL and is never collapsed: its buttons are the
  // reason the turn is waiting on the user, and a collapsed control is one they
  // have to go looking for.
  const [expanded, setExpanded] = useState(false);
  const showBody = open || expanded;
  const locked = deciding || expiring;
  return (
    <Box
      data-od-id="approval-item"
      sx={{
        border: 1,
        borderColor: `color-mix(in oklch, ${STATUS_WARN} 55%, var(--border))`,
        borderRadius: 2,
        bgcolor: `color-mix(in oklch, ${STATUS_WARN} 9%, transparent)`,
        p: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "7px",
        minWidth: 0,
      }}
    >
      <Box
        data-od-id="approval-head"
        {...(open
          ? {}
          : {
              component: "button" as const,
              type: "button" as const,
              onClick: () => setExpanded((v) => !v),
              "aria-expanded": expanded,
              title: expanded ? t("cubepilot.chat.collapseTool") : t("cubepilot.chat.expandTool"),
            })}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
          ...(open
            ? {}
            : {
                width: "100%",
                border: 0,
                bgcolor: "transparent",
                color: "text.primary",
                fontFamily: "inherit",
                textAlign: "left" as const,
                p: 0,
                cursor: "pointer",
              }),
        }}
      >
        <Box sx={{ fontSize: 12, fontWeight: 600 }}>{t("cubepilot.chat.approvalTitle")}</Box>
        {approval.level ? <Pill variant={approval.level === "write" ? "warn" : "neutral"}>{approval.level}</Pill> : null}
        {open && secsLeft !== undefined ? (
          <Pill variant={expiring ? "warn" : "violet"} data-od-id="approval-countdown">
            {expiring ? t("cubepilot.chat.questionExpiring") : t("cubepilot.chat.approvalExpiresIn", { time: fmtSeconds(secsLeft) })}
          </Pill>
        ) : null}
        {open ? null : <Pill variant={tone} sx={{ ml: "auto" }}>{label}</Pill>}
        {open ? null : (
          <Box component="span" aria-hidden sx={{ ...monoSx, fontSize: 10, color: "text.secondary", flex: "none" }}>
            {expanded ? "▾" : "▸"}
          </Box>
        )}
      </Box>
      {/* What the write is, and why the agent wants it: the part that scrolls
          when the dock cannot give the card its full height. What the command
          itself is must stay readable, so the box scrolls rather than growing
          the composer by a screenful. */}
      {showBody ? (
        <Box sx={{ maxHeight: 160, overflow: "auto", display: "flex", flexDirection: "column", gap: "7px" }}>
          {approval.command ? (
            <Box
              component="pre"
              data-od-id="approval-command"
              sx={{
                m: 0,
                ...monoSx,
                fontSize: 11.5,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                bgcolor: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 2,
                p: "7px 10px",
              }}
            >
              {approval.command}
            </Box>
        ) : null}
        {approval.message ? <Box sx={{ fontSize: 12, color: "text.secondary" }}>{approval.message}</Box> : null}
      </Box>
      ) : null}
      {/* The decision row is the control this card exists for, so it sits
          outside the scroller above. */}
      {open ? (
        <Box sx={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
          <Btn
            small
            variant="ok"
            disabled={locked}
            onClick={() => onDecide?.(approval.callId, "approve")}
            data-od-id="approval-approve"
          >
            {deciding ? t("cubepilot.chat.approvalDeciding") : t("cubepilot.chat.approvalApprove")}
          </Btn>
          <Btn small disabled={locked} onClick={() => onDecide?.(approval.callId, "reject")} data-od-id="approval-reject">
            {t("cubepilot.chat.approvalReject")}
          </Btn>
          {/* Only under an Allowlist policy: with None nothing is held back, and
              with AlwaysAsk every call is asked about, so a durable rule would
              mean nothing either way. The pane hides it when the policy could
              not be read. */}
          {allowAlwaysOk ? (
            <Btn small disabled={locked} onClick={() => onDecide?.(approval.callId, "allow-always")} data-od-id="approval-allow">
              {t("cubepilot.chat.approvalAllowAlways")}
            </Btn>
          ) : null}
        </Box>
      ) : null}
      {/* Under the buttons, where the reader is looking when the click fails. */}
      {approval.error ? (
        <Box sx={{ fontSize: 12, color: "var(--danger)", whiteSpace: "pre-wrap" }}>{approval.error}</Box>
      ) : null}
    </Box>
  );
}

/** One ask-user card: the questions the agent is blocked on, and the same card
 *  kept afterwards as the record of what was asked and answered. */
export function QuestionCard({
  question,
  now,
  onAnswer,
}: {
  question: AgentQuestion;
  /** The pane's 1s ticker, which drives the countdown. */
  now: number;
  onAnswer?: AnswerHandler;
}) {
  const { t } = useI18n();
  // Seeded once, from the answer the card already carries. The card is drawn
  // twice in its life — live in the dock, then settled in the thread — and the
  // settled copy is the record of what was decided: starting empty there left it
  // showing the question with nothing chosen and nothing typed.
  const [initial] = useState(() => seedAnswers(question));
  const [picked, setPicked] = useState<Record<string, string[]>>(initial.picked);
  /** Free text per question, offered only where the gateway says so (`isOther`). */
  const [other, setOther] = useState<Record<string, string>>(initial.other);

  const settled = question.state === "answered" || question.state === "cancelled" || question.state === "expired";
  const busy = question.state === "submitting";
  // The local countdown has run out but the gateway has not settled the question
  // yet, so it is about to (or already has). Withdraw the controls rather than
  // let a click fall into a 409 — but do NOT claim "expired": only the gateway
  // can say that, and a client that says it for it leaves the user believing an
  // answer of theirs was thrown away.
  const expiring = isExpiring(question, now);
  const locked = settled || expiring || busy;

  const secs = remainingSeconds(question, now);
  const pill = settled
    ? {
        variant: question.state === "answered" ? ("ok" as const) : ("neutral" as const),
        label:
          question.state === "answered"
            ? t("cubepilot.chat.questionAnswered")
            : question.state === "cancelled"
              ? t("cubepilot.chat.questionCancelled")
              : t("cubepilot.chat.questionExpired"),
      }
    : expiring
      ? { variant: "warn" as const, label: t("cubepilot.chat.questionExpiring") }
      : {
          // The card's own hue. It was the accent, which put a blue chip on a
          // violet card while the sibling approval card's chip is amber to match
          // ITS card — one rule for the pair rather than two.
          variant: "violet" as const,
          // Built from two pieces rather than one interpolated key: the time is
          // a live number, not a sentence. Formatted like every other duration
          // on the page ("13m 22s"), not as raw seconds — a fifteen-minute
          // question read "802s".
          label: secs === undefined ? t("cubepilot.chat.questionAwaiting") : `${t("cubepilot.chat.questionAwaiting")} · ${fmtSeconds(secs)}`,
        };

  const toggle = (item: AgentQuestionItem, label: string): void => {
    setPicked((p) => {
      const cur = p[item.questionId] ?? [];
      const next = item.multiSelect
        ? cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label]
        : cur.includes(label)
          ? [] // Clicking the only choice again clears it, like the reference.
          : [label];
      return { ...p, [item.questionId]: next };
    });
  };

  /** What this question's answer is: the picked options, plus the free text
   *  where the gateway accepts it. */
  const answerFor = (item: AgentQuestionItem): string[] => {
    const free = (other[item.questionId] ?? "").trim();
    return [...(picked[item.questionId] ?? []), ...(free ? [free] : [])];
  };
  const ready = question.questions.every((item) => answerFor(item).length > 0);
  const answersFor = (): Record<string, string[]> =>
    Object.fromEntries(question.questions.map((item) => [item.questionId, answerFor(item)]));

  return (
    <Box
      data-od-id="question-item"
      sx={{
        border: 1,
        borderColor: "var(--violet-bd)",
        borderRadius: 2,
        bgcolor: "color-mix(in oklch, var(--violet) 9%, transparent)",
        p: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "9px",
        minWidth: 0,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <Box sx={{ fontSize: 12, fontWeight: 600 }}>{t("cubepilot.chat.questionTitle")}</Box>
        <Pill variant={pill.variant}>{pill.label}</Pill>
      </Box>
      {/* The form is what scrolls when it is taller than the room the dock can
          give it; the buttons below are not. */}
      <Box sx={{ maxHeight: 260, overflow: "auto", display: "flex", flexDirection: "column", gap: "9px" }}>
        {question.questions.map((item) => (
          <Box key={item.questionId} sx={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              {item.header ? (
                <Box sx={{ ...monoSx, fontSize: 10.5, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--violet-text)", fontWeight: 600 }}>
                  {item.header}
                </Box>
              ) : null}
              {item.multiSelect ? (
                <Box sx={{ fontSize: 11, color: "text.secondary" }}>{t("cubepilot.chat.questionMultiHint")}</Box>
              ) : null}
            </Box>
            <Box sx={{ fontSize: 12.5 }}>{item.question}</Box>
            {item.options && item.options.length > 0 ? (
              // A column, not a wrapping row: these labels are phrases of
              // varying length ("全部节点(含 GPU 节点)"), so a row breaks into a
              // ragged grid, and each option already carries its description on
              // a second line. The reference wraps — this is ours.
              <Box role="group" aria-label={item.question} sx={{ display: "flex", flexDirection: "column", gap: "6px", mt: "2px" }}>
                {item.options.map((o) => {
                  const active = (picked[item.questionId] ?? []).includes(o.label);
                  return (
                    <Box
                      key={o.label}
                      component="button"
                      type="button"
                      disabled={locked}
                      aria-pressed={active}
                      title={o.description}
                      onClick={() => toggle(item, o.label)}
                      sx={{
                        fontFamily: "inherit",
                        fontSize: 12.5,
                        textAlign: "left",
                        color: active ? "#fff" : "text.primary",
                        border: 1,
                        borderColor: active ? "var(--accent)" : "divider",
                        borderRadius: 2,
                        p: "6px 10px",
                        cursor: locked ? "default" : "pointer",
                        bgcolor: active ? "var(--accent)" : "transparent",
                        opacity: locked && !active ? 0.55 : 1,
                      }}
                    >
                      {o.label}
                      {o.description ? (
                        <Box component="span" sx={{ display: "block", fontSize: 11, opacity: 0.75, mt: "2px" }}>
                          {o.description}
                        </Box>
                      ) : null}
                    </Box>
                  );
                })}
              </Box>
            ) : null}
            {/* Where the human may answer in their own words: `ask_user` says so
                per question, and a question offering no options is free-text-only
                whether or not the flag arrived. Both are read off the ITEM — the
                contract puts `isOther` on the question (api.md §4.6), and reading
                it off the prompt above found nothing, so this entry never
                appeared. */}
            {item.isOther || (item.options?.length ?? 0) === 0 ? (
              <CpInput
                aria-label={t("cubepilot.chat.questionOther")}
                placeholder={t("cubepilot.chat.questionOther")}
                value={other[item.questionId] ?? ""}
                disabled={locked}
                onChange={(e) => setOther((o) => ({ ...o, [item.questionId]: e.target.value }))}
                sx={{ fontSize: 12.5, mt: "2px" }}
              />
            ) : null}
          </Box>
        ))}
      </Box>
      {settled ? null : (
        <Box sx={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
          <Btn
            small
            variant="primary"
            disabled={!ready || locked}
            data-od-id="question-submit"
            onClick={() => onAnswer?.(question.callId, answersFor(), false)}
          >
            {busy ? t("cubepilot.chat.questionSending") : t("cubepilot.chat.questionSubmitted")}
          </Btn>
          <Btn small disabled={locked} data-od-id="question-cancel" onClick={() => onAnswer?.(question.callId, {}, true)}>
            {t("cubepilot.chat.questionCancel")}
          </Btn>
        </Box>
      )}
      {question.error ? (
        <Box sx={{ fontSize: 12.5, color: "var(--danger)", whiteSpace: "pre-wrap" }}>{question.error}</Box>
      ) : null}
    </Box>
  );
}

/**
 * The dock: every card the transcript is still parked on, oldest turn first.
 *
 * It collects from the WHOLE transcript, not the newest bubble: a write parked
 * by a turn several bubbles back is still a turn blocked on the user, and its
 * card would otherwise have scrolled away with the bubble that raised it. */
export function HitlDock({
  approvals,
  questions,
  sessionKey,
  now,
  allowAlwaysOk,
  onDecide,
  onAnswer,
}: {
  approvals: AgentApproval[];
  questions: AgentQuestion[];
  /** Call ids are only unique within a session — the same reason AgentThread's
   *  tool keys carry one. Without it, a card's picked options would follow the
   *  reader into another conversation that happens to reuse the id. */
  sessionKey: string | null;
  now: number;
  allowAlwaysOk: boolean;
  onDecide: ApprovalHandler;
  onAnswer: AnswerHandler;
}) {
  if (approvals.length === 0 && questions.length === 0) return null;
  const key = (callId: string): string => `${sessionKey ?? ""}-${callId}`;
  return (
    <Box
      data-od-id="hitl-dock"
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        mb: "8px",
        // The dock caps its own height and scrolls past it. Unstacked, several
        // cards (a reload can attach a pending approval AND a pending question)
        // push the composer down until the cards leave the visible area — which
        // is the one thing the dock exists to prevent: these buttons are the
        // only way to answer a turn that is parked on the user.
        maxHeight: "min(50vh, 420px)",
        overflowY: "auto",
      }}
    >
      {approvals.map((a) => (
        <ApprovalCard key={key(a.callId)} approval={a} now={now} allowAlwaysOk={allowAlwaysOk} onDecide={onDecide} />
      ))}
      {questions.map((q) => (
        <QuestionCard key={key(q.callId)} question={q} now={now} onAnswer={onAnswer} />
      ))}
    </Box>
  );
}
