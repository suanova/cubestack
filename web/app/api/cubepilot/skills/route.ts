// /api/cubepilot/skills — the platform skill catalog (the agent's tool
// whitelist), from the skills.ai.cubestack.io CRs in the operator namespace.
// enabled = whether the skill loads for the caller's instance: an empty
// spec.enabledSkills is the all-enabled baseline (reachable Platform skills);
// a non-empty list is an explicit allow-set.

import {
  getOwnedAgentInstanceCr,
  k8sErrorResponse,
  listSkillCrs,
  skillEnabled,
} from "@/lib/cubepilot/agentcrd";
import type { SkillInfo } from "@/lib/cubepilot/types";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async (_req, session) => {
  try {
    const [skills, instance] = await Promise.all([
      listSkillCrs(),
      getOwnedAgentInstanceCr(session.user),
    ]);
    const skillsView: SkillInfo[] = skills.map((s) => ({
      name: s.metadata?.name ?? "",
      displayName: s.spec?.displayName || s.metadata?.name || "",
      description: s.spec?.description ?? "",
      enabled: skillEnabled(instance, s),
    }));
    return Response.json({ skills: skillsView });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
