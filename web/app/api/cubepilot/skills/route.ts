// /api/cubepilot/skills — the platform skill catalog.

import { listSkills } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  return Response.json({ skills: listSkills() });
});
