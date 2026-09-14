// /api/cubepilot/tasks/[id]/run — start a simulated run; its report
// materializes a few seconds later (see lib/cubepilot/store).

import { getTask, runTask } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (_req, _session, ctx) => {
  const { id } = await ctx.params;
  if (!getTask(id)) {
    return Response.json({ error: "task not found" }, { status: 404 });
  }
  runTask(id, "Manual");
  return Response.json({ started: true });
});
