// @vitest-environment node
import { describe, expect, it } from "vitest";

import { cronDescription, isValidCron, nextCronRun } from "./cron";

describe("isValidCron", () => {
  it("accepts the supported 5-field shapes", () => {
    expect(isValidCron("0 6 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0,30 8 * * *")).toBe(true);
    expect(isValidCron("0 6 * * 0,7")).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("* * * *")).toBe(false); // 4 fields
    expect(isValidCron("* * * * * *")).toBe(false); // 6 fields (seconds unsupported)
    expect(isValidCron("60 6 * * *")).toBe(false); // minute out of range
    expect(isValidCron("0 24 * * *")).toBe(false); // hour out of range
    expect(isValidCron("0 6 0 * *")).toBe(false); // day-of-month out of range
    expect(isValidCron("0 6 * 13 *")).toBe(false); // month out of range
    expect(isValidCron("0 6 * * 8")).toBe(false); // day-of-week out of range
    expect(isValidCron("1-5 6 * * *")).toBe(false); // ranges unsupported
    expect(isValidCron("*/0 * * * *")).toBe(false); // zero step
    expect(isValidCron("a * * * *")).toBe(false);
  });
});

describe("cronDescription", () => {
  it("is neutral for an empty schedule (manual-only tasks)", () => {
    expect(cronDescription("")).toEqual({ text: null, error: null });
    expect(cronDescription("   ")).toEqual({ text: null, error: null });
  });

  it("flags non-empty expressions that fail the grammar", () => {
    const d = cronDescription("0 6 * *");
    expect(d.text).toBeNull();
    expect(d.error).toContain("Cron");
  });

  it("describes the common shapes", () => {
    expect(cronDescription("0 6 * * *")).toEqual({ text: "每天 06:00", error: null });
    expect(cronDescription("30 8 * * 1")).toEqual({ text: "每周一 08:30", error: null });
    // Day-of-week 7 is the same Sunday as 0.
    expect(cronDescription("30 8 * * 7")).toEqual({ text: "每周日 08:30", error: null });
    expect(cronDescription("15 * * * *")).toEqual({ text: "每小时第 15 分", error: null });
    expect(cronDescription("0 0 1 9 *")).toEqual({ text: "9 月 1 日 00:00", error: null });
    expect(cronDescription("*/5 * * * *")).toEqual({ text: "每 5 分钟", error: null });
  });

  it("falls back to the raw expression for unusual but valid crons", () => {
    const d = cronDescription("5 4 3 2 1");
    expect(d.text).toBe("5 4 3 2 1");
    expect(d.error).toBeNull();
  });
});

describe("nextCronRun", () => {
  const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
    new Date(Date.UTC(y, mo - 1, d, h, mi));

  it("returns null for invalid expressions", () => {
    expect(nextCronRun("* * * *", at(2026, 1, 1, 0))).toBeNull();
  });

  it("never returns the current minute (scans from the next whole minute)", () => {
    expect(nextCronRun("0 6 * * *", at(2026, 1, 1, 6, 0))?.toISOString()).toBe("2026-01-02T06:00:00.000Z");
  });

  it("finds the next daily occurrence in UTC", () => {
    // 2026-01-01 is a Thursday.
    expect(nextCronRun("0 6 * * *", at(2026, 1, 1, 6, 30))?.toISOString()).toBe("2026-01-02T06:00:00.000Z");
  });

  it("supports steps", () => {
    expect(nextCronRun("*/15 * * * *", at(2026, 1, 1, 9, 3))?.toISOString()).toBe("2026-01-01T09:15:00.000Z");
  });

  it("treats day-of-week 0 and 7 as Sunday", () => {
    // 2026-01-04 is a Sunday.
    expect(nextCronRun("0 6 * * 7", at(2026, 1, 3, 0))?.toISOString()).toBe("2026-01-04T06:00:00.000Z");
    expect(nextCronRun("0 6 * * 0", at(2026, 1, 3, 0))?.toISOString()).toBe("2026-01-04T06:00:00.000Z");
  });

  it("or's day-of-month and day-of-week when both are restricted", () => {
    // From Saturday 2026-01-10: Monday Jan 12 (dow) precedes the 15th (dom).
    expect(nextCronRun("0 6 15 * 1", at(2026, 1, 10, 0))?.toISOString()).toBe("2026-01-12T06:00:00.000Z");
    // From Wednesday 2026-08-26: the 28th (dom) precedes Monday Aug 31 (dow).
    expect(nextCronRun("0 6 28 * 1", at(2026, 8, 26, 9))?.toISOString()).toBe("2026-08-28T06:00:00.000Z");
  });

  it("honours the month field", () => {
    expect(nextCronRun("0 0 1 9 *", at(2026, 8, 26, 9))?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns null when the date never occurs (Feb 30)", () => {
    expect(nextCronRun("0 6 30 2 *", at(2026, 1, 1, 0))).toBeNull();
  });
});
