// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fmtSeconds } from "./format";

describe("fmtSeconds", () => {
  // The formatter's whole job is naming a quantity correctly. It divided minutes
  // by 60 and printed the result as "d", so an instance four days old read as
  // "102d" — a number that is real, a unit that is 24x off, and no way for the
  // reader to tell.

  it("is bare seconds under a minute, then minutes and seconds", () => {
    expect(fmtSeconds(0)).toBe("0s");
    expect(fmtSeconds(59)).toBe("59s");
    expect(fmtSeconds(5 * 60 + 3)).toBe("5m 3s");
    expect(fmtSeconds(59 * 60 + 59)).toBe("59m 59s");
  });

  it("is hours and minutes under a day", () => {
    expect(fmtSeconds(60 * 60)).toBe("1h 0m");
    expect(fmtSeconds(3 * 3600 + 20 * 60)).toBe("3h 20m");
    expect(fmtSeconds(23 * 3600 + 59 * 60)).toBe("23h 59m");
  });

  it("is days and hours beyond a day, and a day is 24 hours", () => {
    expect(fmtSeconds(24 * 3600)).toBe("1d 0h");
    expect(fmtSeconds(4 * 86400 + 6 * 3600 + 54 * 60)).toBe("4d 6h");
  });

  it("reads the real instance correctly", () => {
    // The CR was created 2026-09-16T01:26:35Z; this is what the status route
    // reported an hour or so into 2026-09-20. It used to render "102d 54m".
    expect(fmtSeconds(370_499)).toBe("4d 6h");
  });

  it("says nothing rather than guessing when there is no value", () => {
    // The route only reports an uptime for a Ready instance.
    expect(fmtSeconds(undefined)).toBe("-");
  });
});
