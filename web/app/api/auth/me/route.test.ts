// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, bareGet, setTestSessionSecret } from "@/test/auth";

const { GET } = await import("./route");

describe("GET /api/auth/me", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
    delete process.env.PORTAL_ADMIN_USERS;
  });

  it("returns the authenticated user for a valid session", async () => {
    setTestSessionSecret();
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "tester", isAdmin: false });
  });

  it("marks a user listed in PORTAL_ADMIN_USERS as admin", async () => {
    process.env.PORTAL_ADMIN_USERS = "alice, tester";
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "tester", isAdmin: true });
  });

  it("does not grant admin to similar-looking usernames", async () => {
    process.env.PORTAL_ADMIN_USERS = "tester2,not-tester";
    const res = await GET(await authedGet(), undefined);
    expect(await res.json()).toEqual({ user: "tester", isAdmin: false });
  });

  it("returns 401 without a session", async () => {
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
  });
});
