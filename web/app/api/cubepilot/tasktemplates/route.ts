// /api/cubepilot/tasktemplates — the preset task templates.

import { listTemplates } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return Response.json({ taskTemplates: listTemplates() });
});
