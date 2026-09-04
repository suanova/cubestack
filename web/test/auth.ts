import { SignJWT } from "jose";
import type { NextRequest } from "next/server";

import { sessionCookieName, sessionSecret } from "@/lib/auth/config";
import { signSession } from "@/lib/auth/session";

// Test helper for authenticated route-handler requests.
//
// The auth guard and routes sign/verify session cookies with SESSION_SECRET.
// We pin it here so `signSession` and route-side `verifySession` agree, then
// build Request-like objects that carry a valid, tampered, or expired session
// cookie. We avoid constructing a real `next/server` NextRequest (it isn't
// instantiable outside the Next server/edge runtime), and instead hand back a
// minimal object exposing the surface the guarded routes use: method, url,
// nextUrl, headers, cookies.get(), json(), and body.

export const TEST_SESSION_SECRET = "unit-test-session-secret";

export function setTestSessionSecret(): void {
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
}

function buildRequest(init?: RequestInit, url = "http://localhost", cookie?: string): NextRequest {
  const method = init?.method ?? "GET";
  const bodyStr = typeof init?.body === "string" ? init.body : undefined;
  const nextUrl = new URL(url);
  const headers = new Headers(init?.headers);
  if (cookie) headers.set("cookie", cookie);

  // Match NextRequest's cookie API: `cookies.get(name)` returns an object
  // `{ name, value }` (the guard reads `cookie?.value`).
  const valueFor = (name: string): { name: string; value: string } | undefined => {
    if (!cookie) return undefined;
    for (const part of cookie.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === name) return { name: k, value: rest.join("=") };
    }
    return undefined;
  };

  const req = {
    method,
    url,
    nextUrl,
    headers,
    cookies: { get: valueFor },
    body: bodyStr ?? null,
    json: async () => {
      // Mirror NextRequest.json(): an absent/empty body rejects with a
      // SyntaxError instead of resolving undefined.
      if (bodyStr === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return JSON.parse(bodyStr);
    },
  } as unknown as NextRequest;
  return req;
}

/**
 * A request carrying a valid signed session cookie for user "tester". `url` is
 * optional for tests that inspect the request URL/search (e.g. the perses
 * proxy), defaulting to a neutral localhost URL.
 */
export async function authedRequest(init?: RequestInit, url = "http://localhost"): Promise<NextRequest> {
  setTestSessionSecret();
  const token = await signSession("tester");
  return buildRequest(init, url, `${sessionCookieName()}=${token}`);
}

/** A GET request carrying a valid signed session cookie. */
export function authedGet(): Promise<NextRequest> {
  return authedRequest({ method: "GET" });
}

/** A GET request carrying no session cookie (must be rejected by the guard). */
export function bareGet(): Promise<NextRequest> {
  setTestSessionSecret();
  return Promise.resolve(buildRequest({ method: "GET" }));
}

/** A request with no session cookie (e.g. the public login route's request). */
export function plainRequest(init?: RequestInit, url = "http://localhost"): NextRequest {
  return buildRequest(init, url);
}

/**
 * A request carrying a cookie whose signature is invalid (tampered), so the
 * guard must reject it.
 */
export async function tamperedRequest(init?: RequestInit, url = "http://localhost"): Promise<NextRequest> {
  setTestSessionSecret();
  const token = await signSession("tester");
  // Flip the last character of the JWT signature to break the HMAC.
  const broken = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  return buildRequest(init, url, `${sessionCookieName()}=${broken}`);
}

/**
 * A request carrying a cookie signed with a valid key but already expired, so
 * the guard must reject it.
 */
export async function expiredRequest(init?: RequestInit, url = "http://localhost"): Promise<NextRequest> {
  setTestSessionSecret();
  const key = sessionSecret().key;
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("tester")
    .setIssuedAt((Date.now() / 1000) - 10)
    .setExpirationTime((Date.now() / 1000) - 5)
    .sign(key);
  return buildRequest(init, url, `${sessionCookieName()}=${expired}`);
}