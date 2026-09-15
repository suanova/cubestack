// /api/cubepilot/tasks/[id]/toggle — flip spec.state (Enabled ↔ Paused).

import { getTaskCr, isTaskOwner, k8sErrorResponse, patchTaskCrState, taskFromCr } from "@/lib/cubepilot/taskcrd";
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
  const next = (existing.spec?.state ?? "Enabled") === "Paused" ? "Enabled" : "Paused";
  let updated;
  try {
    updated = await patchTaskCrState(id, next);
  } catch (e) {
    return k8sErrorResponse(e);
  }
  return Response.json({ task: taskFromCr(updated) });
});
