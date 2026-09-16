// /api/cubepilot/tasks/[id]/run — ask the operator's scheduler to fire the
// task once, via the cubepilot/manual-run annotation (the run report then
// appears as a TaskRun CR).

import { getTaskCr, isTaskOwner, k8sErrorResponse, markManualRun } from "@/lib/cubepilot/taskcrd";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (_req, session, ctx) => {
  const { id } = await ctx.params;
  let existing;
  try {
    existing = await getTaskCr(id);
  } catch (e) {
    return k8sErrorResponse(e);
  }
  if (!existing) {
    return Response.json({ error: "task not found" }, { status: 404 });
  }
  if (!isTaskOwner(existing, session.user)) {
    return Response.json({ error: "not your task" }, { status: 403 });
  }
  try {
    await markManualRun(existing);
  } catch (e) {
    return k8sErrorResponse(e);
  }
  // 202 Accepted: the trigger is registered, the scheduler owns execution.
  return Response.json({ started: true }, { status: 202 });
});
