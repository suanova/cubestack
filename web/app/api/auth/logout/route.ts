import type { NextRequest } from "next/server";

import { clearSessionCookieHeader, secureCookieForRequest } from "@/lib/auth/session";

// POST /api/auth/logout
// Clears the session cookie and returns success, regardless of whether a valid
// session existed (logout is idempotent).
//
// No CSRF origin check here: logout is a harmless, idempotent side effect (the
// worst a cross-origin form POST could force is a logged-out browser), and an
// origin/host comparison against request.url misfires behind a reverse proxy or
// ingress that rewrites the host, silently returning 403 and leaving the
// session cookie live — which reads as "logged out" in the UI while the
// session persists. The session cookie is already SameSite=Lax, which stops
// cross-site POSTs from carrying it, so a cross-site logout POST has no
// session cookie attached and clears nothing.
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
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader(secureCookieForRequest(req)) } },
  );
}
