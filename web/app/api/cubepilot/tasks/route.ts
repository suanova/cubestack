// /api/cubepilot/tasks — task list (GET) and creation (POST), backed by the
// tasks.ai.cubestack.io CRDs (see lib/cubepilot/taskcrd.ts).

import { isValidCron } from "@/lib/cubepilot/cron";
import {
  createTaskCr,
  getTemplateCr,
  isTaskOwner,
  k8sErrorResponse,
  listTaskCrs,
  renderInstruction,
  resolveParams,
  taskFromCr,
} from "@/lib/cubepilot/taskcrd";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateTaskBody {
  name?: string;
  prompt?: string;
  schedule?: string;
  templateRef?: string;
  params?: Record<string, string>;
}

export const GET = withAuth(async (_req, session) => {
  let items;
  try {
    items = await listTaskCrs();
  } catch (e) {
    return k8sErrorResponse(e);
  }
  // Owner-scoped listing, mirroring the reference API: a user sees only their
  // own tasks (a task runs with its owner's identity).
  const tasks = items
    .filter((cr) => isTaskOwner(cr, session.user))
    .map(taskFromCr)
    .filter((t) => t.id);
  // Newest first, mirroring the reference API's ordering.
  tasks.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return Response.json({ tasks });
});

export const POST = withAuth(async (req, session) => {
  let body: CreateTaskBody;
  try {
    body = (await req.json()) as CreateTaskBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  const schedule = (body.schedule ?? "").trim();
  if (schedule && !isValidCron(schedule)) {
    return Response.json({ error: "invalid cron schedule" }, { status: 400 });
  }
  const templateRef = (body.templateRef ?? "").trim() || undefined;
  if (!templateRef && !(body.prompt ?? "").trim()) {
    return Response.json({ error: "prompt or templateRef is required" }, { status: 400 });
  }
  let instruction: string;
  let params: Record<string, string> | undefined;
  if (templateRef) {
    let tpl;
    try {
      tpl = await getTemplateCr(templateRef);
    } catch (e) {
      return k8sErrorResponse(e);
    }
    if (!tpl) {
      return Response.json({ error: `template "${templateRef}" not found` }, { status: 400 });
    }
    try {
      params = resolveParams(tpl.spec?.paramsSchema ?? [], body.params);
    } catch (e) {
      return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 });
    }
    // The rendered snapshot is what the agent executes (reference behavior).
    instruction = renderInstruction(tpl.spec?.instruction ?? "", params);
  } else {
    instruction = (body.prompt ?? "").trim();
    params = body.params && Object.keys(body.params).length > 0 ? body.params : undefined;
  }
  let created;
  try {
    created = await createTaskCr({ name, instruction, cron: schedule, templateRef, params, owner: session.user });
  } catch (e) {
    return k8sErrorResponse(e);
  }
  return Response.json({ task: taskFromCr(created) }, { status: 201 });
});
