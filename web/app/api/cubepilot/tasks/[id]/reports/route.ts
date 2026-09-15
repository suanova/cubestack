// /api/cubepilot/tasks/[id]/reports — the task's run reports (TaskRun CRs,
// label cubepilot/task=<id>), newest first.

import {
  getTaskCr,
  isTaskOwner,
  k8sErrorResponse,
  listTaskRunCrs,
  reportFromCr,
  taskFromCr,
} from "@/lib/cubepilot/taskcrd";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth<Ctx>(async (_req, session, ctx) => {
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
  let runs;
  try {
    runs = await listTaskRunCrs(id);
  } catch (e) {
    return k8sErrorResponse(e);
  }
  const taskName = taskFromCr(existing).name;
  const reports = runs.map((r) => reportFromCr(r, taskName)).filter((r) => r.id);
  reports.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return Response.json({ reports });
});
