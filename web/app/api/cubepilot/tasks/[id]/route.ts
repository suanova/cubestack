// /api/cubepilot/tasks/[id] — delete the Task CR (its TaskRuns are the
// scheduler's and outlive the task).

import { deleteTaskCr, getTaskCr, isTaskOwner, k8sErrorResponse } from "@/lib/cubepilot/taskcrd";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withAuth<Ctx>(async (_req, session, ctx) => {
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
    await deleteTaskCr(id);
  } catch (e) {
    return k8sErrorResponse(e);
  }
  return Response.json({ deleted: id });
});
