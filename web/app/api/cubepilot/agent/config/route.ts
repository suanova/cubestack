// /api/cubepilot/agent/config — the caller's assistant selections (GET/PUT),
// read from and written to the caller's AgentInstance CR
// (ai.cubestack.io/v1alpha1, spec.selectedModel / spec.userInstructions —
// field names mirror the CRD, per the reference contract). The PUT creates
// the instance on first save (idempotent, like the reference API's
// POST /api/v1/instances).
//
// The model catalog is the union of the AgentTemplate's spec.models (the
// reference's rule: "models are inlined in the AgentTemplate"; the operator
// wires them into the AI gateway) and the system catalog the gateway serves
// (the chat tab's source). The template part resolves offline, so a save never
// depends on the gateway being reachable.

import {
  DEFAULT_AGENT_NAME,
  InstanceConflictError,
  agentInstanceName,
  ensureAgentInstance,
  getAgentInstanceCr,
  getAgentTemplateCr,
  getOwnedAgentInstanceCr,
  k8sErrorResponse,
  patchAgentInstanceCr,
  templateModels,
  type AgentInstanceCr,
  type AgentTemplateCr,
  type JsonPatchOp,
} from "@/lib/cubepilot/agentcrd";
import { gatewayFetch } from "@/lib/cubepilot/gateway";
import { logger } from "@/lib/log";
import type { AgentConfig, TemplateModelOption } from "@/lib/cubepilot/types";
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

/** The selectable catalog: the template's own (external) models first, then the
 *  system catalog the platform serves (the AI Gateway — the same source the chat
 *  tab lists). A name in both keeps the external entry, which carries the
 *  endpoint and the credential reference. */
function catalog(tmpl: AgentTemplateCr | null, system: TemplateModelOption[]): TemplateModelOption[] {
  const own = templateModels(tmpl);
  const seen = new Set(own.map((m) => m.name));
  return [...own, ...system.filter((m) => !seen.has(m.name))];
}

/**
 * The system catalog: the models the AI Gateway serves. Best effort and
 * bounded — an absent or slow gateway simply means "no system models"; the
 * template's own models still work, so nothing here depends on the gateway.
 */
async function systemModels(): Promise<TemplateModelOption[]> {
  try {
    const res = await gatewayFetch("/v1/models", { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({ name: m.id, origin: "system" as const }));
  } catch {
    return [];
  }
}

function configFromCr(cr: AgentInstanceCr | null, tmpl: AgentTemplateCr | null, system: TemplateModelOption[]): AgentConfig {
  return {
    exists: Boolean(cr),
    selectedModel: cr?.spec?.selectedModel ?? "",
    userInstructions: cr?.spec?.userInstructions ?? "",
    models: catalog(tmpl, system),
    templateMissing: !tmpl,
  };
}

export const GET = withAuth(async (_req, session) => {
  try {
    const [cr, tmpl] = await Promise.all([
      getOwnedAgentInstanceCr(session.user),
      getAgentTemplateCr(DEFAULT_AGENT_NAME),
    ]);
    if (!tmpl) {
      logger("agent").warn("builtin AgentTemplate missing — the config page has no catalog or runtime", {
        template: DEFAULT_AGENT_NAME,
        namespace: process.env.CUBESTACK_TASKS_NAMESPACE ?? "cubestack-system",
        hint: "install the CubePilot operator, or point CUBESTACK_TASKS_NAMESPACE at the namespace holding the CRs",
      });
    }
    return Response.json({ config: configFromCr(cr, tmpl, await systemModels()) });
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
      // The template's own models resolve without touching the gateway; only a
      // model we have not seen there costs the (bounded) system lookup.
      const own = templateModels(tmpl).map((m) => m.name);
      if (!own.includes(patch.selectedModel) && !(await systemModels()).some((m) => m.name === patch.selectedModel)) {
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
      return Response.json({ config: configFromCr(cr, tmpl, await systemModels()) });
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
    return Response.json({ config: configFromCr(cr, tmpl, await systemModels()) });
  } catch (e) {
    if (e instanceof InstanceConflictError) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return k8sErrorResponse(e);
  }
});
