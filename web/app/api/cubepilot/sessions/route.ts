// /api/cubepilot/sessions — chat session list (GET) and creation (POST).
// Demo state lives in lib/cubepilot/store (in-memory, per process).

import { createSession, listSessions } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return Response.json({ sessions: listSessions() });
});

export const POST = withAuth(async () => {
  const key = createSession();
  return Response.json({ sessionKey: key }, { status: 201 });
});
