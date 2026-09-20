// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fmtUptime } from "./format";

describe("fmtUptime", () => {
  // The formatter's whole job is naming a quantity correctly. It divided minutes
  // by 60 and printed the result as "d", so an instance four days old read as
  // "102d" — a number that is real, a unit that is 24x off, and no way for the
  // reader to tell.

  it("is minutes and seconds under an hour", () => {
    expect(fmtUptime(0)).toBe("0m 0s");
    expect(fmtUptime(59)).toBe("0m 59s");
    expect(fmtUptime(5 * 60 + 3)).toBe("5m 3s");
    expect(fmtUptime(59 * 60 + 59)).toBe("59m 59s");
  });

  it("is hours and minutes under a day", () => {
    expect(fmtUptime(60 * 60)).toBe("1h 0m");
    expect(fmtUptime(3 * 3600 + 20 * 60)).toBe("3h 20m");
    expect(fmtUptime(23 * 3600 + 59 * 60)).toBe("23h 59m");
  });

  it("is days and hours beyond a day, and a day is 24 hours", () => {
    expect(fmtUptime(24 * 3600)).toBe("1d 0h");
    expect(fmtUptime(4 * 86400 + 6 * 3600 + 54 * 60)).toBe("4d 6h");
  });

  it("reads the real instance correctly", () => {
    // The CR was created 2026-09-16T01:26:35Z; this is what the status route
    // reported an hour or so into 2026-09-20. It used to render "102d 54m".
    expect(fmtUptime(370_499)).toBe("4d 6h");
  });

  it("says nothing rather than guessing when there is no value", () => {
    // The route only reports an uptime for a Ready instance.
    expect(fmtUptime(undefined)).toBe("-");
  });
});
