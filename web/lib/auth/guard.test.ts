// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedRequest, bareGet, expiredRequest, tamperedRequest } from "@/test/auth";
import { withAuth } from "./guard";

// A minimal protected handler that echoes the verified user.
const protectedHandler = withAuth(async (_req, session) => {
  return Response.json({ user: session.user });
});

describe("withAuth guard", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("lets a valid session through and exposes the user", async () => {
    const res = await protectedHandler(await authedRequest(), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "tester" });
  });

  it("returns 401 for a request with no session cookie", async () => {
    const res = await protectedHandler(await bareGet(), undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 for a tampered cookie", async () => {
    const res = await protectedHandler(await tamperedRequest(), undefined);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired cookie", async () => {
    const res = await protectedHandler(await expiredRequest(), undefined);
    expect(res.status).toBe(401);
  });
})