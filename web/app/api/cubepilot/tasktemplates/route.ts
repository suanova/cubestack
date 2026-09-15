// /api/cubepilot/tasktemplates — the task templates, from the
// tasktemplates.ai.cubestack.io CRDs.

import { k8sErrorResponse, listTemplateCrs, templateFromCr } from "@/lib/cubepilot/taskcrd";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  let items;
  try {
    items = await listTemplateCrs();
  } catch (e) {
    return k8sErrorResponse(e);
  }
  const taskTemplates = items.map(templateFromCr).filter((t) => t.name);
  return Response.json({ taskTemplates });
});
