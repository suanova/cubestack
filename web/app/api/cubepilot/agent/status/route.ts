// /api/cubepilot/agent/status — the caller's instance runtime status.

import { getStatus } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async (_req, session) => {
  return Response.json(getStatus(session.user));
});
