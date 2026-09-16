// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { plainRequest, setTestSessionSecret } from "@/test/auth";

const { verifyCredentials } = vi.hoisted(() => ({
  verifyCredentials: vi.fn<(u: string, p: string) => Promise<string | null>>(),
}));

vi.mock("@/lib/auth/htpasswd", () => ({ verifyCredentials }));

function loginRequest(body: unknown) {
  setTestSessionSecret();
  return plainRequest(
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    "http://localhost/api/auth/login",
  );
}

const { POST } = await import("./route");

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    setTestSessionSecret();
    verifyCredentials.mockReset();
  });
  afterEach(() => {
    delete process.env.SESSION_SECRET;
    delete process.env.SESSION_COOKIE_SECURE;
  });

  it("sets a signed session cookie and returns success for valid credentials", async () => {
    verifyCredentials.mockResolvedValue("admin");
    const res = await POST(loginRequest({ username: "admin", password: "correct" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "admin" });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/cubestack-session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Max-Age=/);
    // Plain HTTP: no Secure flag, or browsers drop the cookie and login loops.
    expect(setCookie).not.toMatch(/Secure/);
  });

  it("marks the session cookie Secure behind a TLS-terminating proxy", async () => {
    verifyCredentials.mockResolvedValue("admin");
    const res = await POST(
      plainRequest(
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
          body: JSON.stringify({ username: "admin", password: "correct" }),
        },
        "http://localhost/api/auth/login",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Secure/);
  });

  it("marks the session cookie Secure for a direct https request", async () => {
    verifyCredentials.mockResolvedValue("admin");
    const res = await POST(
      plainRequest(
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "correct" }),
        },
        "https://portal.example/api/auth/login",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Secure/);
  });

  it("honours an explicit SESSION_COOKIE_SECURE override", async () => {
    process.env.SESSION_COOKIE_SECURE = "true";
    verifyCredentials.mockResolvedValue("admin");
    // Plain http origin, but the override forces Secure.
    const res = await POST(loginRequest({ username: "admin", password: "correct" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Secure/);
  });

  it("honours an explicit SESSION_COOKIE_SECURE=false override", async () => {
    process.env.SESSION_COOKIE_SECURE = "false";
    verifyCredentials.mockResolvedValue("admin");
    // Forwarded-https origin would normally set Secure; the override wins.
    const res = await POST(
      plainRequest(
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
          body: JSON.stringify({ username: "admin", password: "correct" }),
        },
        "http://localhost/api/auth/login",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/Secure/);
  });

  it("returns 401 for invalid credentials without setting a cookie", async () => {
    verifyCredentials.mockResolvedValue(null);
    const res = await POST(loginRequest({ username: "admin", password: "wrong" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "用户名或密码错误" });
  });

  it("returns 400 for a malformed or missing body", async () => {
    const missing = await POST(loginRequest({}));
    expect(missing.status).toBe(400);
    const notString = await POST(loginRequest({ username: "a", password: 5 }));
    expect(notString.status).toBe(400);
  });

  it("returns 400 when the request has no JSON body at all", async () => {
    const res = await POST(plainRequest({ method: "POST" }, "http://localhost/api/auth/login"));
    expect(res.status).toBe(400);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it("returns 500 without a cookie when the htpasswd Secret cannot be loaded", async () => {
    verifyCredentials.mockRejectedValue(new Error("secret missing"));
    const res = await POST(loginRequest({ username: "admin", password: "x" }));
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "Authentication is not configured" });
  });
})
