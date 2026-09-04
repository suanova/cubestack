// @vitest-environment node
import { describe, expect, it } from "vitest";

// Logout requires no session; it always clears the cookie.
const { POST } = await import("./route");

describe("POST /api/auth/logout", () => {
  it("returns ok and clears the session cookie", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Max-Age=0 + expired Expires: the cookie is dropped, not extended.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/cubestack-session=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
  });
})