import type { NextRequest } from "next/server";

import { verifyCredentials } from "@/lib/auth/htpasswd";
import { sessionTtlMs } from "@/lib/auth/config";
import { sessionCookieHeader, signSession } from "@/lib/auth/session";

// POST /api/auth/login
// Verifies a username/password pair against the htpasswd Secret and, on
// success, installs a signed session cookie. Returns 401 for bad credentials
// (without setting a cookie) and 500 when the Secret cannot be loaded.
export async function POST(req: NextRequest) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await req.json()) as { username?: unknown; password?: unknown };
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  let user;
  try {
    user = await verifyCredentials(body.username, body.password);
  } catch (err) {
    // Missing/unreadable htpasswd Secret: a clear 500, not a crash.
    console.error("Login failed to load htpasswd:", err);
    return Response.json({ error: "Authentication is not configured" }, { status: 500 });
  }

  if (!user) {
    return Response.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  const token = await signSession(user);
  return Response.json(
    { user },
    {
      headers: {
        "Set-Cookie": sessionCookieHeader(token, Math.floor(sessionTtlMs() / 1000)),
      },
    },
  );
}