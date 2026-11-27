import { describe, expect, it } from "vitest";

import { MAX_LOGO_BYTES, MAX_LOGO_EDGE, fitWithin, isValidLogo, logoBytes } from "./logo";

describe("logoBytes", () => {
  it("decodes the base64 payload size", () => {
    // "AAAA" is 3 bytes; "AAAAAA==" is 4 bytes.
    expect(logoBytes("data:image/png;base64,AAAA")).toBe(3);
    expect(logoBytes("data:image/png;base64,AAAAAA==")).toBe(4);
  });

  it("returns 0 for a value that is not a data URL", () => {
    expect(logoBytes("https://example.com/logo.png")).toBe(0);
  });
});

describe("fitWithin", () => {
  it("leaves an image that already fits unchanged", () => {
    expect(fitWithin(320, 120)).toEqual({ width: 320, height: 120 });
  });

  it("scales the longest edge to the cap and keeps the aspect ratio", () => {
    expect(fitWithin(1024, 512)).toEqual({ width: MAX_LOGO_EDGE, height: MAX_LOGO_EDGE / 2 });
  });

  it("never rounds an edge down to zero", () => {
    expect(fitWithin(10000, 10)).toEqual({ width: MAX_LOGO_EDGE, height: 1 });
  });
});

describe("isValidLogo", () => {
  it.each(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"])(
    "accepts a base64 %s data URL",
    (mime) => {
      expect(isValidLogo(`data:${mime};base64,iVBORw0KGgo=`)).toBe(true);
    },
  );

  it.each([
    "https://example.com/logo.png",
    "/logo.png",
    "data:text/html;base64,PGgxPmhpPC9oMT4=",
    "data:image/png,not-base64",
    "data:image/png;base64,",
    "data:image/png;base64,not base64!",
  ])("rejects %s", (value) => {
    expect(isValidLogo(value)).toBe(false);
  });

  it("rejects an image over the size cap", () => {
    const payload = "A".repeat(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 4);
    expect(isValidLogo(`data:image/png;base64,${payload}`)).toBe(false);
  });

  it("accepts an image just under the cap", () => {
    // The longest all-'A' payload whose decoded size stays within the cap.
    const payload = "A".repeat(Math.floor((MAX_LOGO_BYTES * 4) / 3));
    expect(isValidLogo(`data:image/png;base64,${payload}`)).toBe(true);
  });
});
