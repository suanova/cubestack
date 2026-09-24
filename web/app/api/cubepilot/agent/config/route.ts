// /api/cubepilot/agent/config — the caller's assistant selections (GET/PUT),
// read from and written to the caller's AgentInstance CR
// (ai.cubestack.io/v1alpha1, spec.selectedModel / spec.userInstructions —
// field names mirror the CRD, per the reference contract). The PUT creates
// the instance on first save (idempotent, like the reference API's
// POST /api/v1/instances).
//
// The model catalog is the AgentTemplate's provider list (reference: "models
// are inlined in the template"; the operator renders providers into the
// agent's OpenClaw config). A selection is a "<provider>/<modelId>" ref built
// by the operator's ModelKey rule.
//
// A SAVE WRITES TWO OBJECTS, IN THIS ORDER:
//   1. the builtin AgentTemplate — its platform provider (name "cubestack") is
//      pointed at the resolved model API (<gateway>/v1) and given the model ids
//      the gateway serves, so the agent always has one stable provider in front
//      of the gateway; spec.defaultModel names the ref it selects;
//   2. the caller's AgentInstance — selectedModel "<provider>/<model id>" (e.g.
//      "cubestack/qwen38-27b") and userInstructions.
// The model API must resolve and serve at least one model first: an
// unreachable/unconfigured gateway (or an empty catalog) fails the save (503)
// before anything is written, so a CR never carries an endpoint or a model id
// the runtime cannot reach.

import {
  DEFAULT_AGENT_NAME,
  InstanceConflictError,
  agentInstanceName,
  ensureAgentInstance,
  getAgentInstanceCr,
  getAgentTemplateCr,
  getOwnedAgentInstanceCr,
  k8sErrorResponse,
  PLATFORM_MODEL_NAME,
  patchAgentInstanceCr,
  patchAgentTemplateCr,
  platformProviderOps,
  templateProviders,
  type AgentInstanceCr,
  type AgentTemplateCr,
  type JsonPatchOp,
} from "@/lib/cubepilot/agentcrd";
import { gatewayFetch, gatewayOpenAiBase } from "@/lib/cubepilot/gateway";
import { validateInstructions } from "@/lib/cubepilot/instructions";
import { modelKey } from "@/lib/cubepilot/llm";
import { logger } from "@/lib/log";
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

/**
 * The model ids the AI Gateway serves (the chat tab's source, and what the
 * platform provider's entry gets written with). Best effort and bounded — an
 * absent or slow gateway simply means "no models"; the save is what refuses an
 * empty list, so a read-only GET still answers.
 */
async function gatewayModels(): Promise<string[]> {
  try {
    const res = await gatewayFetch("/v1/models", { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => m.id);
  } catch {
    return [];
  }
}

function configFromCr(cr: AgentInstanceCr | null, tmpl: AgentTemplateCr | null, gateway: string[]): AgentConfig {
  return {
    exists: Boolean(cr),
    selectedModel: cr?.spec?.selectedModel ?? "",
    userInstructions: cr?.spec?.userInstructions ?? "",
    providers: templateProviders(tmpl),
    gatewayModels: gateway,
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
    return Response.json({ config: configFromCr(cr, tmpl, await gatewayModels()) });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});

export const PUT = withAuth(async (req, session) => {
  // The caller's selectedModel names the model the instance runs, as a bare
  // gateway model id or the "<provider>/<id>" ref; the agent always runs it
  // through the platform provider, so the ref is rewritten below.
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
  if (patch.userInstructions !== undefined) {
    // The reference refuses these before writing; the CRD has no CEL for the
    // field, so a direct CR write would store instructions the supervisor then
    // declines to render (it keeps the last good value), i.e. the user's edit
    // silently never takes effect.
    const reason = validateInstructions(patch.userInstructions);
    if (reason) {
      return Response.json({ error: reason }, { status: 400 });
    }
  }
  try {
    const name = agentInstanceName(session.user);
    const [existing, tmpl] = await Promise.all([getAgentInstanceCr(name), getAgentTemplateCr(DEFAULT_AGENT_NAME)]);
    if (!tmpl) {
      return Response.json(
        { error: `builtin agent template "${DEFAULT_AGENT_NAME}" not found in the operator namespace` },
        { status: 503 },
      );
    }
    // 1) the model API the platform serves models from — the agent talks to it
    //    through the platform provider, so it is written into the template first.
    const modelApi = await gatewayOpenAiBase();
    if (!modelApi) {
      return Response.json(
        {
          error:
            "cannot resolve the model API (AI Gateway) — set CUBESTACK_GATEWAT_URL or install the gateway in the configured namespace; nothing was saved",
        },
        { status: 503 },
      );
    }
    // selectedModel is written as the "<provider>/<model id>" ref the operator
    // resolves against the template's PROVIDERS, not against the gateway: an
    // external provider added in the LLM card is a first-class choice for the
    // assistant, and reading the catalog from the gateway is what made those
    // selections impossible (the picker offered nothing but platform ids, and
    // this refused anything else). A bare id still means the platform
    // provider's — it is what the select sent before providers were selectable
    // — and a ref the template cannot resolve is refused, because a stored ref
    // the runtime cannot answer fails every turn.
    const served = await gatewayModels();
    if (served.length === 0) {
      return Response.json(
        {
          error:
            "the model API serves no models (its /v1/models is empty or unreachable) — nothing was saved",
        },
        { status: 503 },
      );
    }
    // The template's providers MINUS the platform's: that entry is rewritten from
    // `served` by this same save (platformProviderOps below), so a platform id the
    // template still lists but the gateway no longer serves would pass a check
    // against the template and then disappear from it — leaving a stored selection
    // that no longer resolves. The platform's ids are accepted from `served` only.
    const externalProviders = ((tmpl.spec?.providers ?? []) as Array<{ name?: string; models?: string[] }>).filter(
      (p) => p.name !== PLATFORM_MODEL_NAME,
    );
    const selectable = new Set<string>(
      externalProviders.flatMap((p) => (p.models ?? []).map((id) => modelKey(p.name ?? "", id))),
    );
    for (const id of served) selectable.add(modelKey(PLATFORM_MODEL_NAME, id));
    const requested = patch.selectedModel ?? "";
    // A bare id means the platform provider's — unless the gateway itself serves
    // an id containing a slash (a namespaced model like "meta-llama/Llama-3"),
    // which is a bare id too and would otherwise read as a ref for a provider
    // named "meta-llama".
    const requestedRef =
      requested === ""
        ? ""
        : served.includes(requested) || !requested.includes("/")
          ? modelKey(PLATFORM_MODEL_NAME, requested)
          : requested;
    if (requestedRef !== "" && !selectable.has(requestedRef)) {
      return Response.json(
        {
          error: `unknown model "${requested}" — the template's providers offer: ${[...selectable].join(", ")}`,
        },
        { status: 400 },
      );
    }
    const selectedModel = requestedRef || modelKey(PLATFORM_MODEL_NAME, served[0]);
    const templateOps = platformProviderOps(tmpl.spec?.providers, modelApi, served);
    if (templateOps.length > 0) {
      logger("agent").info("template updated for the platform provider", {
        provider: PLATFORM_MODEL_NAME,
        endpoint: modelApi,
        models: served.length,
        ops: templateOps.length,
      });
    }
    // The template carries the default too: an instance without its own
    // selection runs this ref (CRD: it must name a provider/model listed).
    const defaultOps: JsonPatchOp[] =
      tmpl.spec?.defaultModel === selectedModel
        ? []
        : [{ op: "add", path: "/spec/defaultModel", value: selectedModel }];
    const opsToSend = [...templateOps, ...defaultOps];
    const updatedTmpl = opsToSend.length > 0 ? await patchAgentTemplateCr(DEFAULT_AGENT_NAME, opsToSend) : tmpl;
    if (!existing) {
      const { cr } = await ensureAgentInstance({
        user: session.user,
        selectedModel,
        userInstructions: patch.userInstructions,
      });
      return Response.json({ config: configFromCr(cr, updatedTmpl, served) });
    }
    if (existing.spec?.owner !== session.user) {
      return Response.json({ error: "agent instance name already taken by another user" }, { status: 409 });
    }
    // Clearing a selection ("") removes the field instead of writing an empty
    // string — the reference's `omitempty` does the same, so the CR never keeps
    // empty nodes ("" = template instructions only).
    // 2) the caller's instance: the platform provider selection + the prompt.
    const ops = [
      // Only when the caller named one: a prompt-only update must not re-derive a
      // selection, which would replace an external model with the first platform
      // one the gateway happens to serve.
      ...clearOrAdd(
        patch.selectedModel === undefined ? undefined : selectedModel,
        "/spec/selectedModel",
        existing.spec?.selectedModel,
      ),
      ...clearOrAdd(patch.userInstructions, "/spec/userInstructions", existing.spec?.userInstructions),
    ];
    const cr = ops.length > 0 ? await patchAgentInstanceCr(name, ops) : existing;
    return Response.json({ config: configFromCr(cr, updatedTmpl, served) });
  } catch (e) {
    if (e instanceof InstanceConflictError) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return k8sErrorResponse(e);
  }
});
