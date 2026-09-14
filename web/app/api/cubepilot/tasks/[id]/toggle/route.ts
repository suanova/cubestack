// /api/cubepilot/tasks/[id]/toggle — flip enabled.

import { getTask, toggleTask } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (_req, _session, ctx) => {
  const { id } = await ctx.params;
  if (!getTask(id)) {
    return Response.json({ error: "task not found" }, { status: 404 });
  }
  const task = toggleTask(id)!;
  return Response.json({ task });
});
