// Safety boundary for instructions rendered into the agent workspace's managed
// AGENTS.md section. Mirrors the reference's internal/instructions package: the
// supervisor writes the platform- and user-supplied instructions between two
// markers, so text carrying those markers could break the section it is
// rendered into.

/** Delimiters of the section CubePilot owns inside the instance's AGENTS.md. */
export const MANAGED_START = "<!-- cubepilot:system-prompt:start -->";
export const MANAGED_END = "<!-- cubepilot:system-prompt:end -->";

/** The reference's per-file bootstrap character budget (OpenClaw's default). */
export const MAX_INSTRUCTION_CHARS = 20_000;

/**
 * Refuse instructions that cannot be safely rendered into the managed section,
 * returning the reason or null.
 *
 * Mirrors the reference's Validate, including its ORDER: trim, then count, then
 * check the markers. Three details are load-bearing:
 *
 *  - The value is trimmed BEFORE counting. The reference does this
 *    (`policy.go:25`), and skipping it makes the portal stricter than the
 *    backend: a prompt that is exactly at the limit plus a trailing newline
 *    from a paste is 20,001 code points here and 20,000 after the supervisor
 *    trims it, so the portal would refuse an edit the backend happily renders.
 *  - The length is counted in Unicode code points (`Array.from`), matching the
 *    reference's `utf8.RuneCountInString`. `String.prototype.length` counts
 *    UTF-16 units and would reject a CJK prompt at half the intended budget.
 *  - The limit is inclusive: exactly `MAX_INSTRUCTION_CHARS` is allowed, so the
 *    comparison is `>`.
 *
 * Residual divergence, accepted: Go's `strings.TrimSpace` also trims U+0085
 * (which JavaScript's `trim` does not) and JavaScript's `trim` also trims
 * U+FEFF (which Go does not). The first can only make this check reject, never
 * accept, so it stays on the conservative side — the same trade-off the
 * allowlist screen documents.
 */
export function validateInstructions(value: string): string | null {
  const trimmed = value.trim();
  if (Array.from(trimmed).length > MAX_INSTRUCTION_CHARS) {
    return `instructions exceed the ${MAX_INSTRUCTION_CHARS}-character limit`;
  }
  if (trimmed.includes(MANAGED_START) || trimmed.includes(MANAGED_END)) {
    return "instructions contain a reserved managed-section marker";
  }
  return null;
}
