// /api/cubepilot/tasks/[id] — delete (historical reports are dropped with it).

import { deleteTask, getTask } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withAuth<Ctx>(async (_req, _session, ctx) => {
  const { id } = await ctx.params;
  if (!getTask(id) || !deleteTask(id)) {
    return Response.json({ error: "task not found" }, { status: 404 });
  }
  return Response.json({ deleted: id });
});
