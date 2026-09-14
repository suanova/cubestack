// /api/cubepilot/tasks/[id]/reports — a task's run reports, newest first.

import { getTask, listReports } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth<Ctx>(async (_req, _session, ctx) => {
  const { id } = await ctx.params;
  if (!getTask(id)) {
    return Response.json({ error: "task not found" }, { status: 404 });
  }
  return Response.json({ reports: listReports(id) });
});
