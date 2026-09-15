// /api/cubepilot/agent/config — the caller's assistant selections (GET/PUT),
// read from and written to the caller's AgentInstance CR
// (ai.cubestack.io/v1alpha1, spec.selectedModel / spec.userInstructions —
// field names mirror the CRD, per the reference contract). The PUT creates
// the instance on first save (idempotent, like the reference API's
// POST /api/v1/instances).
//
// The model catalog is the AgentTemplate's spec.models (the reference's rule:
// "models are inlined in the AgentTemplate"; the operator wires them into the
// AI gateway), so a save never depends on the gateway being reachable.

import {
  DEFAULT_AGENT_NAME,
  InstanceConflictError,
  agentInstanceName,
  ensureAgentInstance,
  getAgentInstanceCr,
  getAgentTemplateCr,
  k8sErrorResponse,
  patchAgentInstanceCr,
  templateModels,
  type AgentInstanceCr,
  type AgentTemplateCr,
  type JsonPatchOp,
} from "@/lib/cubepilot/agentcrd";
import type { AgentConfig } from "@/lib/cubepilot/types";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One JSON-Patch op for a selection field: an explicit value is written, ""
 *  removes the field (only when it is present), undefined is a no-op. */
function clearOrAdd(value: string | undefined, path: string, current: string | undefined): JsonPatchOp[] {
  if (value === undefined) return [];
  if (value !== "") return [{ op: "add", path, value }];
  return current !== undefined ? [{ op: "remove", path }] : [];
}

function configFromCr(cr: AgentInstanceCr | null, tmpl: AgentTemplateCr | null): AgentConfig {
  return {
    exists: Boolean(cr),
    selectedModel: cr?.spec?.selectedModel ?? "",
    userInstructions: cr?.spec?.userInstructions ?? "",
    models: templateModels(tmpl),
  };
}

export const GET = withAuth(async (_req, session) => {
  try {
    const [cr, tmpl] = await Promise.all([
      getAgentInstanceCr(agentInstanceName(session.user)),
      getAgentTemplateCr(DEFAULT_AGENT_NAME),
    ]);
    return Response.json({ config: configFromCr(cr, tmpl) });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});

export const PUT = withAuth(async (req, session) => {
  let patch: { selectedModel?: string; userInstructions?: string } = {};
  try {
    const body = (await req.json()) as { config?: { selectedModel?: string; userInstructions?: string } };
    patch = body.config ?? {};
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (patch.selectedModel !== undefined && typeof patch.selectedModel !== "string") {
    return Response.json({ error: "selectedModel must be a string" }, { status: 400 });
  }
  if (patch.userInstructions !== undefined && typeof patch.userInstructions !== "string") {
    return Response.json({ error: "userInstructions must be a string" }, { status: 400 });
  }
  try {
    const name = agentInstanceName(session.user);
    const [existing, tmpl] = await Promise.all([getAgentInstanceCr(name), getAgentTemplateCr(DEFAULT_AGENT_NAME)]);
    // Fail at save time, not at chat time: an explicit selectedModel outside
    // the template's models would leave the instance unable to resolve a
    // model. "" = Runtime Default (clear the override), always allowed.
    if (patch.selectedModel) {
      const known = templateModels(tmpl).map((m) => m.name);
      if (!known.includes(patch.selectedModel)) {
        return Response.json(
          { error: `model "${patch.selectedModel}" is not in the ${DEFAULT_AGENT_NAME} template (add it under Agent Config -> LLM Config first)` },
          { status: 400 },
        );
      }
    }
    if (!existing) {
      const { cr } = await ensureAgentInstance({
        user: session.user,
        selectedModel: patch.selectedModel,
        userInstructions: patch.userInstructions,
      });
      return Response.json({ config: configFromCr(cr, tmpl) });
    }
    if (existing.spec?.owner !== session.user) {
      return Response.json({ error: "agent instance name already taken by another user" }, { status: 409 });
    }
    // Clearing a selection ("") removes the field instead of writing an empty
    // string — the reference's `omitempty` does the same, so the CR never keeps
    // empty nodes ("" = Runtime Default / template instructions only).
    const ops = [
      ...clearOrAdd(patch.selectedModel, "/spec/selectedModel", existing.spec?.selectedModel),
      ...clearOrAdd(patch.userInstructions, "/spec/userInstructions", existing.spec?.userInstructions),
    ];
    const cr = ops.length > 0 ? await patchAgentInstanceCr(name, ops) : existing;
    return Response.json({ config: configFromCr(cr, tmpl) });
  } catch (e) {
    if (e instanceof InstanceConflictError) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return k8sErrorResponse(e);
  }
});
