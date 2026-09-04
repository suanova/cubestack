// @vitest-environment node
import { describe, expect, it } from "vitest";

import { plainRequest } from "@/test/auth";

// Logout requires no session; it always clears the cookie for same-origin
// callers and rejects cross-site requests (CSRF).
const { POST } = await import("./route");

function logoutPost(init?: RequestInit) {
  return plainRequest({ method: "POST", ...init }, "http://localhost/api/auth/logout");
}

describe("POST /api/auth/logout", () => {
  it("returns ok and clears the session cookie for a same-origin caller", async () => {
    const res = await POST(logoutPost({ headers: { origin: "http://localhost" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Max-Age=0 + expired Expires: the cookie is dropped, not extended.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/cubestack-session=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
  });

  it("allows non-browser clients that send no Origin/Referer", async () => {
    const res = await POST(logoutPost());
    expect(res.status).toBe(200);
  });

  it("rejects a cross-site request (attacker origin) without clearing the cookie", async () => {
    const res = await POST(logoutPost({ headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a mismatched Referer (older browsers)", async () => {
    const res = await POST(logoutPost({ headers: { referer: "https://evil.example/logout" } }));
    expect(res.status).toBe(403);
  });
})