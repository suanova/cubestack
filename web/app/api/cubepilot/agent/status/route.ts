// /api/cubepilot/agent/status — the caller's instance status, from the
// AgentInstance CR (spec + status). status.phase is filled by the operator as
// it converges (Creating → Ready / Failed); empty = not observed yet.

import { getOwnedAgentInstanceCr, k8sErrorResponse } from "@/lib/cubepilot/agentcrd";
import type { AgentStatus } from "@/lib/cubepilot/types";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async (_req, session) => {
  try {
    const cr = await getOwnedAgentInstanceCr(session.user);
    if (!cr) {
      return Response.json({ exists: false, user: session.user } satisfies AgentStatus);
    }
    const phase = cr.status?.phase ?? "";
    const startedAt = cr.metadata?.creationTimestamp;
    // The operator reports whether the template offers a usable provider
    // (endpoint + model ids + an existing credential Secret); false means every
    // turn fails, so the config page surfaces it instead of a silent Ready.
    const modelCondition = (cr.status?.conditions ?? []).find((c) => c.type === "ModelConfigured");
    const uptimeSeconds =
      phase === "Ready" && startedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
        : undefined;
    return Response.json({
      exists: true,
      id: cr.metadata?.name,
      phase,
      startedAt,
      uptimeSeconds,
      user: cr.spec?.owner ?? session.user,
      message: cr.status?.message,
      modelConfigured: modelCondition ? modelCondition.status === "True" : undefined,
      modelMessage: modelCondition?.message,
      podName: cr.status?.podName,
      pvcName: cr.status?.pvcName,
    } satisfies AgentStatus);
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
