import type { NextRequest } from "next/server";

import { jwtVerify, SignJWT } from "jose";

import { secureCookieOverride, sessionCookieName, sessionSecret, sessionTtlMs } from "./config";

// Signed session cookie. The cookie holds a short JWT (HS256) whose `sub` is
// the authenticated username and whose `exp` bounds its lifetime. A correct
// signature is what proves the caller was issued the cookie by us; verifying
// it (and rejecting tampered/expired values) is what identifies the caller on
// later requests.

/** Claims minted into each session. */
export interface SessionClaims {
  user: string;
  /** ms epoch at which the session was issued. */
  iat: number;
  /** ms epoch at which the session expires. */
  exp: number;
}

/** Decode a session string into its claims, or null if absent/invalid/expired. */
export async function verifySession(token: string): Promise<SessionClaims | null> {
  const { key } = sessionSecret();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      // The login route signs and this verifies in the same process, so there
      // is no clock-skew to absorb: an expired session is rejected as-is.
      clockTolerance: 0,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    return {
      user: payload.sub,
      iat: payload.iat * 1000,
      exp: payload.exp * 1000,
    };
  } catch {
    return null;
  }
}

/** Create the token value for a freshly-authenticated session. */
export async function signSession(user: string): Promise<string> {
  const { key } = sessionSecret();
  const now = Date.now();
  const ttl = sessionTtlMs();
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user)
    .setIssuedAt(now / 1000)
    .setExpirationTime((now + ttl) / 1000)
    .sign(key);
}

/**
 * Whether the session cookie should carry the Secure flag for a request.
 *
 * Browsers drop a Secure cookie set over plain HTTP, which silently breaks
 * login on http-only front ends — so the flag must track how the browser
 * actually reached us, not NODE_ENV:
 *
 *  - X-Forwarded-Proto is set by ingress/TLS terminators (e.g. nginx sets it
 *    to https for a TLS-terminated route that reaches the pod over http).
 *  - For direct connections nextUrl.protocol reflects the real scheme.
 *  - SESSION_COOKIE_SECURE=true|false overrides both when the external scheme
 *    cannot be inferred (a TLS terminator that does not forward the header).
 */
export function secureCookieForRequest(request: NextRequest): boolean {
  const override = secureCookieOverride();
  if (override !== null) return override;
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0].trim() === "https";
  }
  return request.nextUrl.protocol === "https:";
}

/**
 * The Set-Cookie header that installs a session. `secure` marks the cookie
 * Secure (only sent over HTTPS); resolve it per request via
 * secureCookieForRequest. `expires` is a ms epoch; pass a past value (e.g. 0)
 * to clear the cookie.
 */
export function sessionCookieHeader(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${sessionCookieName()}=${token}`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (secure) parts.push("Secure");
  parts.push(`Max-Age=${maxAgeSeconds}`);
  // Clearing: set an epoch expiry too so non-conforming clients still drop it.
  const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  parts.push(`Expires=${expires}`);
  return parts.join("; ");
}

/**
 * Header value that clears (logs out) the session cookie. `secure` must match
 * how the session cookie was originally set so the browser clears the same
 * variant it stored.
 */
export function clearSessionCookieHeader(secure: boolean): string {
  // Max-Age=0 plus a past Expires reliably removes the cookie.
  const parts = [
    `${sessionCookieName()}=`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
