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
 * The length is counted in Unicode code points, matching the reference
 * (`utf8.RuneCountInString`), so non-ASCII instructions get the same usable
 * budget as English text. `String.prototype.length` counts UTF-16 units and
 * would reject a CJK prompt at half the intended limit.
 */
export function validateInstructions(value: string): string | null {
  if (Array.from(value).length > MAX_INSTRUCTION_CHARS) {
    return `instructions exceed the ${MAX_INSTRUCTION_CHARS}-character limit`;
  }
  if (value.includes(MANAGED_START) || value.includes(MANAGED_END)) {
    return "instructions contain a reserved managed-section marker";
  }
  return null;
}
