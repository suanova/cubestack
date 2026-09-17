// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MANAGED_END, MANAGED_START, MAX_INSTRUCTION_CHARS, validateInstructions } from "./instructions";

describe("validateInstructions", () => {
  it("accepts ordinary text", () => {
    expect(validateInstructions("")).toBeNull();
    expect(validateInstructions("回答尽量简短。")).toBeNull();
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    // 20_000 CJK characters are 20_000 code points but 20_000 UTF-16 units too;
    // use an astral character to separate the two counts: one code point, two
    // UTF-16 units.
    const atLimit = "𝄞".repeat(MAX_INSTRUCTION_CHARS);
    expect(atLimit.length).toBe(MAX_INSTRUCTION_CHARS * 2);
    expect(validateInstructions(atLimit)).toBeNull();
    expect(validateInstructions(atLimit + "𝄞")).toContain("character limit");
  });

  it("trims before counting, like the reference", () => {
    // A paste artifact: the content sits exactly at the limit and carries a
    // trailing newline. The reference trims first (`policy.go:25`) and accepts
    // it; counting the raw value would 400 an edit the backend would render.
    const atLimit = "x".repeat(MAX_INSTRUCTION_CHARS);
    expect(validateInstructions(`${atLimit}\n`)).toBeNull();
    expect(validateInstructions(`\n${atLimit}\n`)).toBeNull();
    // ...but trimming must not buy extra budget for real content.
    expect(validateInstructions(`${atLimit}x\n`)).toContain("character limit");
  });

  it("rejects the reserved managed-section markers", () => {
    expect(validateInstructions(`前置内容 ${MANAGED_START} 后置`)).toContain("reserved managed-section marker");
    expect(validateInstructions(`前置内容 ${MANAGED_END} 后置`)).toContain("reserved managed-section marker");
  });
});
