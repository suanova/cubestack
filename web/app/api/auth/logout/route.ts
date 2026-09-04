import type { NextRequest } from "next/server";

import { clearSessionCookieHeader } from "@/lib/auth/session";

// POST /api/auth/logout
// Clears the session cookie and returns success, regardless of whether a valid
// session existed (logout is idempotent). Clearing the cookie is a side effect
// a cross-site page could otherwise trigger with a form POST, so same-origin
// callers are enforced: a browser always attaches Origin (and usually Referer)
// to a POST, and a foreign origin is rejected.
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader() } },
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