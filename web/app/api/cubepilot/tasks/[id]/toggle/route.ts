// /api/cubepilot/tasks/[id]/toggle — flip spec.state (Enabled ↔ Paused).

import { getTaskCr, k8sErrorResponse, namespaceMissingResponse, patchTaskCrState, taskFromCr, tasksNamespace } from "@/lib/cubepilot/taskcrd";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (_req, _session, ctx) => {
  const { id } = await ctx.params;
  if (!tasksNamespace()) return namespaceMissingResponse();
  let existing;
  try {
    existing = await getTaskCr(id);
  } catch (e) {
    return k8sErrorResponse(e);
  }
  if (!existing) {
    return Response.json({ error: "task not found" }, { status: 404 });
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
