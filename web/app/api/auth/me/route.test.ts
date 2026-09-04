// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, bareGet, setTestSessionSecret } from "@/test/auth";

const { GET } = await import("./route");

describe("GET /api/auth/me", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("returns the authenticated user for a valid session", async () => {
    setTestSessionSecret();
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "tester" });
  });

  it("returns 401 without a session", async () => {
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
  });
})