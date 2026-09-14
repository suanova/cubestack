// /api/cubepilot/tasks — task list (GET) and creation (POST).

import {
  createTask,
  listTasks,
  type CreateTaskInput,
} from "@/lib/cubepilot/store";
import { isValidCron } from "@/lib/cubepilot/cron";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return Response.json({ tasks: listTasks() });
});

export const POST = withAuth(async (req, session) => {
  let body: CreateTaskInput;
  try {
    body = (await req.json()) as CreateTaskInput;
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
  const hasTemplate = !!body.templateRef;
  if (!hasTemplate && !(body.prompt ?? "").trim()) {
    return Response.json({ error: "prompt or templateRef is required" }, { status: 400 });
  }
  const task = createTask(session.user, {
    name,
    prompt: body.prompt ?? "",
    schedule,
    templateRef: body.templateRef,
    params: body.params,
  });
  return Response.json({ task }, { status: 201 });
});
