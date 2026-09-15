// Platform builtin safe-read allowlist (reference: internal/allowlist/
// allowlist.go, issue #116). Hardcoded on purpose: it is the platform default
// and is never stored on an instance — only the rules a user adds live on
// AgentInstance.spec.allowlist. `kubectl` anchors on a read verb (the gateway
// matches each rule against one parsed command, so verb-gating — not a token
// charset — is the security boundary); the read-only shell tools keep a
// plain-word-only arg charset because they run through a real shell.

import type { AllowlistRule } from "./types";

/** One optional kubectl global flag that may precede the subcommand. */
const KUBECTL_GLOBAL_FLAG = `--[A-Za-z0-9][A-Za-z0-9-]*(=[A-Za-z0-9_./:=,%+*?@~"#'-]+)?|-[a-zA-Z0-9](\\s+[A-Za-z0-9_./:=,%+*?@~"#'-]+)?|--namespace\\s+[A-Za-z0-9_./:=,%+*?@~"#'-]+|--context\\s+[A-Za-z0-9_./:=,%+*?@~"#'-]+`;

/** The kubectl subcommands that only read cluster state. */
const KUBECTL_READ_VERBS = "get|list|watch|describe|logs|events|top|api-resources|api-versions|explain|version|diff|cluster-info";

/** kubectl with a read verb after optional global flags; the tail is argv
 *  (separators and substitutions are refused before this rule is consulted). */
export const KUBECTL_READ_ARG_PATTERN = `^((` + KUBECTL_GLOBAL_FLAG + `)\\s+)*(` + KUBECTL_READ_VERBS + `)(\\b[\\s\\S]*)?$`;

/** Only space-separated plain words — no separators. */
export const SAFE_ARG_PATTERN = `^[A-Za-z0-9_./:=,%+*?@~"#'-]+(\\s+[A-Za-z0-9_./:=,%+*?@~"#'-]+)*$`;

// Deliberately no command wrappers (env, xargs, sh, …) that can exec a
// following command, no `date` (can set the clock) and no `curl` (can write).
const SAFE_BINS = ["ls", "cat", "pwd", "grep", "head", "tail", "wc", "jq", "echo", "printf", "which"];

/** The platform builtin read-only rules, in the reference's order. */
export function builtinAllowlist(): AllowlistRule[] {
  return [
    {
      pattern: "kubectl",
      argPattern: KUBECTL_READ_ARG_PATTERN,
      label: "kubectl — read-only operations (get/list/watch/describe/logs/events/top/…)",
      owned: false,
    },
    ...SAFE_BINS.map((bin) => ({
      pattern: bin,
      argPattern: SAFE_ARG_PATTERN,
      label: `${bin} — read-only, plain args`,
      owned: false,
    })),
  ];
}

/** A rule's identity: pattern + argPattern (the reference's merge key). */
export function ruleKey(r: AllowlistRule): string {
  return r.pattern + "|" + (r.argPattern ?? "");
}

/** Union of rule groups, order preserved, keyed by pattern|argPattern; empty
 *  patterns are dropped (the reference's allowlist.Merge). */
export function mergeRules(...groups: AllowlistRule[][]): AllowlistRule[] {
  const seen = new Set<string>();
  const out: AllowlistRule[] = [];
  for (const group of groups) {
    for (const rule of group) {
      if (!rule || typeof rule.pattern !== "string" || rule.pattern.length === 0) continue;
      const key = ruleKey(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rule);
    }
  }
  return out;
}

/** The effective allowlist a user sees: the hardcoded platform defaults first,
 *  then the instance's own rules (marked owned so the UI lets them be removed).
 *
 *  DECISION (agreed with the platform owner): the defaults are ALWAYS in effect
 *  and an instance's own rules only WIDEN the list — an owned list never
 *  replaces the defaults. This intentionally differs from the reference's
 *  Effective(owned, template), which treats a non-empty owned list as
 *  authoritative (the defaults then stop applying unless re-listed). The
 *  runtime that enforces the allowlist must follow the same rule, i.e. evaluate
 *  defaults ∪ instance rules; if it keeps the reference's owned-authoritative
 *  Effective, either align it or materialize the defaults into the CR on the
 *  first add (the reference API's allowlistAlways does the latter). */
export function effectiveAllowlist(owned: AllowlistRule[] | undefined): AllowlistRule[] {
  return mergeRules(
    builtinAllowlist(),
    (owned ?? []).map((r) => ({ ...r, owned: true })),
  );
}

/** One rule as stored on the CR (AgentInstance.spec.allowlist). */
export interface OwnedRuleCr {
  pattern: string;
  argPattern?: string;
}

/** The instance's own (custom) rules as stored on the CR: trimmed, deduped,
 *  empty patterns dropped. */
export function ownedRules(rules: AllowlistRule[] | undefined): OwnedRuleCr[] {
  const sanitized = mergeRules(
    (rules ?? []).map((r) => ({ pattern: r.pattern.trim(), argPattern: r.argPattern?.trim() || undefined, owned: true })),
  );
  return sanitized.map((r) => ({ pattern: r.pattern, ...(r.argPattern ? { argPattern: r.argPattern } : {}) }));
}
