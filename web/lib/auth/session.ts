import { jwtVerify, SignJWT } from "jose";

import { secureCookies, sessionCookieName, sessionSecret, sessionTtlMs } from "./config";

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
 * The Set-Cookie header that installs a session. `expires` is a ms epoch; pass
 * a past value (e.g. 0) to clear the cookie.
 */
export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  const parts = [
    `${sessionCookieName()}=${token}`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (secureCookies()) parts.push("Secure");
  parts.push(`Max-Age=${maxAgeSeconds}`);
  // Clearing: set an epoch expiry too so non-conforming clients still drop it.
  const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  parts.push(`Expires=${expires}`);
  return parts.join("; ");
}

/** Header value that clears (logs out) the session cookie. */
export function clearSessionCookieHeader(): string {
  // Max-Age=0 plus a past Expires reliably removes the cookie.
  const parts = [
    `${sessionCookieName()}=`,
    "Path=/",
    "SameSite=Lax",
    "HttpOnly",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secureCookies()) parts.push("Secure");
  return parts.join("; ");
}