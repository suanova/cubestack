import { clearSessionCookieHeader } from "@/lib/auth/session";

// POST /api/auth/logout
// Clears the session cookie and returns success, regardless of whether a valid
// session existed (logout is idempotent).
export async function POST() {
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader() } },
  );
}