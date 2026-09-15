// /api/cubepilot/skills/[name] — install/uninstall a skill into the caller's
// instance (POST { action: "install" | "uninstall" }); the reply is the new
// skills view. Set semantics mirror the reference API (handlers_platform.go):
// an empty spec.enabledSkills is the all-enabled baseline, so uninstalling on
// the baseline materializes the allow-list to the baseline skills minus the
// one (later publishes do not re-enable it).

import {
  agentInstanceName,
  baselineSkillNames,
  getAgentInstanceCr,
  getSkillCr,
  k8sErrorResponse,
  listSkillCrs,
  patchAgentInstanceCr,
  skillInBaseline,
  withSkillDisabled,
  withSkillEnabled,
  type SkillCr,
} from "@/lib/cubepilot/agentcrd";
import type { SkillInfo } from "@/lib/cubepilot/types";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

function skillsView(skills: SkillCr[], enabled: string[]): SkillInfo[] {
  return skills.map((s) => ({
    name: s.metadata?.name ?? "",
    displayName: s.spec?.displayName || s.metadata?.name || "",
    description: s.spec?.description ?? "",
    // Empty list = the all-enabled baseline (reachable Platform skills).
    enabled: enabled.length === 0 ? skillInBaseline(s) : enabled.includes(s.metadata?.name ?? ""),
  }));
}

export const POST = withAuth<Ctx>(async (req, session, ctx) => {
  const { name } = await ctx.params;
  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.action !== "install" && body.action !== "uninstall") {
    return Response.json({ error: 'action must be "install" or "uninstall"' }, { status: 400 });
  }
  try {
    const skill = await getSkillCr(name);
    if (!skill) {
      return Response.json({ error: `skill "${name}" not found` }, { status: 404 });
    }
    // Only reachable, Platform-visible skills can be installed (phase 1).
    if (body.action === "install") {
      if (skill.status?.phase === "Unreachable") {
        return Response.json({ error: "skill is unreachable (missing content)" }, { status: 409 });
      }
      if (skill.spec?.visibility !== "Platform") {
        return Response.json({ error: "phase 1 supports only Platform-visible skills" }, { status: 409 });
      }
    }
    const instance = await getAgentInstanceCr(agentInstanceName(session.user));
    if (!instance) {
      return Response.json({ error: "provision your instance on the Agent Config page first" }, { status: 409 });
    }
    if (instance.spec?.owner !== session.user) {
      return Response.json({ error: "not your instance" }, { status: 403 });
    }
    const current = instance.spec?.enabledSkills ?? [];
    const next =
      body.action === "install"
        ? withSkillEnabled(instance, name)
        : withSkillDisabled(instance, name, baselineSkillNames(await listSkillCrs()));
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      await patchAgentInstanceCr(instance.metadata?.name as string, [
        { op: "add", path: "/spec/enabledSkills", value: next },
      ]);
    }
    const skills = await listSkillCrs();
    return Response.json({ skills: skillsView(skills, next) });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
