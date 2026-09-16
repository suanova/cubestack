// /api/cubepilot/tasks/[id]/toggle — set spec.state (Enabled ↔ Paused). The
// body carries the state the client wants; without one the current state is
// flipped, which is what the state at the time of the read implies. An explicit
// target keeps a retried request idempotent — a replayed flip would undo the
// first one.

import { getTaskCr, isTaskOwner, k8sErrorResponse, patchTaskCrState, taskFromCr } from "@/lib/cubepilot/taskcrd";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (req, session, ctx) => {
  const { id } = await ctx.params;
  let desired: unknown;
  try {
    desired = ((await req.json()) as { state?: unknown }).state;
  } catch {
    desired = undefined; // no body: flip the current state
  }
  if (desired !== undefined && desired !== "Enabled" && desired !== "Paused") {
    return Response.json({ error: 'state must be "Enabled" or "Paused"' }, { status: 400 });
  }
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
  const current = existing.spec?.state ?? "Enabled";
  const next = desired ?? (current === "Paused" ? "Enabled" : "Paused");
  let updated = existing;
  if (next !== current) {
    try {
      updated = await patchTaskCrState(id, next);
    } catch (e) {
      return k8sErrorResponse(e);
    }
  }
  return Response.json({ task: taskFromCr(updated) });
});
