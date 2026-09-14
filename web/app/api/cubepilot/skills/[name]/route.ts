// /api/cubepilot/skills/[name] — install/uninstall into the caller's instance
// (POST { action: "install" | "uninstall" }); the reply is the new
// enabledSkills set.

import { listSkills, setSkillEnabled } from "@/lib/cubepilot/store";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export const POST = withAuth<Ctx>(async (req, _session, ctx) => {
  const { name } = await ctx.params;
  if (!listSkills().some((s) => s.name === name)) {
    return Response.json({ error: `skill "${name}" not found` }, { status: 404 });
  }
  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.action !== "install" && body.action !== "uninstall") {
    return Response.json({ error: 'action must be "install" or "uninstall"' }, { status: 400 });
  }
  const skills = setSkillEnabled(name, body.action === "install");
  return Response.json({ skills });
});
