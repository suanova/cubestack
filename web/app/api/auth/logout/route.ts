import type { NextRequest } from "next/server";

import { clearSessionCookieHeader, secureCookieForRequest } from "@/lib/auth/session";

// POST /api/auth/logout
// Clears the session cookie and returns success, regardless of whether a valid
// session existed (logout is idempotent). Clearing the cookie is a side effect
// a cross-site page could otherwise trigger with a form POST, so same-origin
// callers are enforced: a browser always attaches Origin (and usually Referer)
// to a POST, and a foreign origin is rejected.
//
// The cleared cookie mirrors the session cookie's Secure flag, derived from the
// same scheme check used at login (see secureCookieForRequest). This assumes
// login and logout are reached over the same scheme: a browser refuses to let
// an insecure response overwrite a Secure cookie, so an https-issued session
// logged out over http returns 200 while the session survives. Serve both on
// one canonical scheme (terminate http -> https at the ingress), and pin
// SESSION_COOKIE_SECURE when a TLS terminator does not forward
// X-Forwarded-Proto.
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader(secureCookieForRequest(req)) } },
  );
}

function isSameOrigin(req: NextRequest): boolean {
  // Trust Origin when present, else fall back to Referer. Non-browser clients
  // (curl, tests) send neither; they cannot be CSRF targets, so allow them.
  const candidate = req.headers.get("origin") ?? req.headers.get("referer");
  if (!candidate) return true;
  try {
    return new URL(candidate).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}
