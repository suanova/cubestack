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
//   1. the builtin AgentTemplate — the platform provider entry for the Gateway
//      serving the selection ("cubestack" for the public Gateway,
//      "cubestack-<suffix>" for the others, e.g. "cubestack-private") is pointed
//      at that Gateway's model API (<gateway>/v1) and given the ids it serves, so
//      the agent always has a stable provider in front of each Gateway;
//      spec.defaultModel names the ref it selects;
//   2. the caller's AgentInstance — selectedModel "<provider>/<model id>" (e.g.
//      "cubestack/qwen38-27b", "cubestack-private/dsv4-api") and
//      userInstructions.
// Each Gateway has its own entry: a provider has a single endpoint, and the
// entries are shared by every instance, so one save must never replace another
// Gateway's entry.
// The platform half is optional: a cluster can run the assistant on the
// providers the template declares with no AI Gateway at all, and then only (2)
// is written. A save never stores a platform endpoint or model id it could not
// resolve — an unreachable gateway leaves the platform's models unselectable
// (and asking for one anyway is refused with 503 naming the gateway), while the
// template's own providers stay selectable.

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
import { gatewayCatalogs, gatewayOpenAiBaseOf, platformProviderNameOf } from "@/lib/cubepilot/gateway";
import { validateInstructions } from "@/lib/cubepilot/instructions";
import { modelKey } from "@/lib/cubepilot/llm";
import { logger } from "@/lib/log";
import { isPlatformProviderName, type AgentConfig } from "@/lib/cubepilot/types";
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

type PlatformCatalog = Awaited<ReturnType<typeof gatewayCatalogs>>;

/** One platform provider entry: the AgentTemplate provider `name`, the endpoint
 *  it points at and the ids that endpoint serves. */
interface PlatformEntry {
  name: string;
  endpoint: string;
  models: string[];
}

/**
 * The platform's provider entries — one per Gateway that answered with at
 * least one model, public first. Each Gateway is written under its own name
 * (see platformProviderNameOf): a provider has a single endpoint, so sharing
 * one entry between the public and private catalogues would replace one
 * catalogue with the other on every save and strand the other's selections.
 */
function platformEntries(catalogs: PlatformCatalog): PlatformEntry[] {
  return catalogs.flatMap(({ base, models }) =>
    models.length > 0
      ? [
          {
            name: platformProviderNameOf(base),
            endpoint: gatewayOpenAiBaseOf(base),
            models: models.map((m) => m.id),
          },
        ]
      : [],
  );
}

/**
 * The model ids the platform's AI Gateways serve — the union of the entries,
 * merged by id, so a model published to either one is offered. Best effort —
 * an absent or slow gateway simply means "no models" from it. The call itself
 * is memoized and bounded by the gateway module, so a slow gateway is not paid
 * for on every read.
 */
function servedModels(entries: PlatformEntry[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { models } of entries) {
    for (const id of models) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function configFromCr(cr: AgentInstanceCr | null, tmpl: AgentTemplateCr | null, entries: PlatformEntry[]): AgentConfig {
  return {
    exists: Boolean(cr),
    selectedModel: cr?.spec?.selectedModel ?? "",
    userInstructions: cr?.spec?.userInstructions ?? "",
    providers: templateProviders(tmpl),
    gatewayModels: servedModels(entries),
    gatewayProviders: entries,
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
    return Response.json({ config: configFromCr(cr, tmpl, platformEntries(await gatewayCatalogs())) });
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
    // 1) the model APIs the platform serves models from — the agent talks to
    //    them through the platform providers, so the one serving this selection
    //    is written into the template first. Writing an entry needs both halves:
    //    a base to point it at, and the ids to list. An install with no AI
    //    Gateway (the assistant running on the providers the template declares)
    //    is a supported shape, so a missing gateway means "no platform models in
    //    this save", never a refusal — the platform is a capability of the
    //    cluster, not a precondition of a save.
    const entries = platformEntries(await gatewayCatalogs());
    // selectedModel is written as the "<provider>/<model id>" ref the operator
    // resolves against the template's PROVIDERS, not against the gateway: an
    // external provider added in the LLM card is a first-class choice for the
    // assistant, and reading the catalog from the gateway is what made those
    // selections impossible (the picker offered nothing but platform ids, and
    // this refused anything else). A bare id still means the platform
    // provider's — it is what the select sent before providers were selectable
    // — and a ref the template cannot resolve is refused, because a stored ref
    // the runtime cannot answer fails every turn.
    // The template's providers MINUS the platform's: those entries are rewritten
    // from the live catalogues by this same save (platformProviderOps below), so
    // a platform id the template still lists but the gateway no longer serves
    // would pass a check against the template and then disappear from it —
    // leaving a stored selection that no longer resolves. The platform's ids are
    // accepted from the live entries only.
    const externalProviders = ((tmpl.spec?.providers ?? []) as Array<{ name?: string; models?: string[] }>).filter(
      (p) => !isPlatformProviderName(p.name ?? ""),
    );
    const selectable = new Set<string>(
      externalProviders.flatMap((p) => (p.models ?? []).map((id) => modelKey(p.name ?? "", id))),
    );
    for (const entry of entries) {
      for (const id of entry.models) selectable.add(modelKey(entry.name, id));
    }
    const requested = patch.selectedModel ?? "";
    // A bare id means the provider that serves it — unless the gateway itself
    // serves an id containing a slash (a namespaced model like
    // "meta-llama/Llama-3"), which is a bare id too and would otherwise read as
    // a ref for a provider named "meta-llama". A bare id no entry serves is read
    // as the public provider's, so the refusal below can name it.
    const serving = requested === "" ? undefined : entries.find((e) => e.models.includes(requested));
    const requestedRef =
      requested === ""
        ? ""
        : serving
          ? modelKey(serving.name, requested)
          : requested.includes("/")
            ? requested
            : modelKey(PLATFORM_MODEL_NAME, requested);
    if (requestedRef !== "" && !selectable.has(requestedRef)) {
      // A platform ref whose provider is missing is not an unknown model: name
      // what is missing, and what can be picked instead.
      const refProvider = requestedRef.includes("/") ? requestedRef.slice(0, requestedRef.indexOf("/")) : "";
      if (isPlatformProviderName(refProvider) && !entries.some((e) => e.name === refProvider)) {
        return Response.json(
          {
            error:
              `the platform model API (AI Gateway) is unavailable, so "${requested}" cannot be selected — the template's providers offer: ${[...selectable].join(", ")}`,
          },
          { status: 503 },
        );
      }
      return Response.json(
        {
          error: `unknown model "${requested}" — the template's providers offer: ${[...selectable].join(", ")}`,
        },
        { status: 400 },
      );
    }
    // A first save with nothing selected gets a default, or the instance has no
    // model to run. An explicit "" is a clear, not an omission, so it stays
    // empty — and only a NAMED selection moves the model: re-deriving one for an
    // instructions-only update would replace the reader's own choice.
    const derived =
      patch.selectedModel === undefined && !existing
        ? entries.length > 0
          ? modelKey(entries[0].name, entries[0].models[0])
          : ([...selectable][0] ?? "")
        : "";
    const selectedModel = requestedRef || derived;
    // The entry this save writes: the one serving a named platform selection, or
    // the one a first save's default comes from. Every other save — an
    // instructions-only update, an external provider's model, a clear — leaves
    // the shared entries alone: this instance's stored selection may be served
    // by another Gateway, and rewriting that Gateway's entry here would point it
    // at a catalogue that no longer lists the model.
    const target =
      entries.find((e) => requestedRef.startsWith(`${e.name}/`)) ??
      entries.find((e) => derived !== "" && derived.startsWith(`${e.name}/`)) ??
      null;
    const templateOps = target
      ? platformProviderOps(tmpl.spec?.providers, target.name, target.endpoint, target.models)
      : [];
    if (target && templateOps.length > 0) {
      logger("agent").info("template updated for the platform provider", {
        provider: target.name,
        endpoint: target.endpoint,
        models: target.models.length,
        ops: templateOps.length,
      });
    }
    // The template's default is shared by every instance, and an instance
    // without its own selection runs it (CRD: it must name a listed ref). A
    // derived selection must not move it when there is no platform: this save
    // leaves the template's own providers alone, so its default stays valid.
    const defaultOps: JsonPatchOp[] =
      selectedModel === "" ||
      tmpl.spec?.defaultModel === selectedModel ||
      (requestedRef === "" && entries.length === 0)
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
      return Response.json({ config: configFromCr(cr, updatedTmpl, entries) });
    }
    if (existing.spec?.owner !== session.user) {
      return Response.json({ error: "agent instance name already taken by another user" }, { status: 409 });
    }
    // Clearing a selection ("") removes the field instead of writing an empty
    // string — the reference's `omitempty` does the same, so the CR never keeps
    // empty nodes ("" = template instructions only).
    // 2) the caller's instance: the platform provider selection + the prompt.
    const ops = [
      // Undefined is a no-op (see selectedModel above); "" clears the field.
      ...clearOrAdd(
        patch.selectedModel === undefined ? undefined : selectedModel,
        "/spec/selectedModel",
        existing.spec?.selectedModel,
      ),
      ...clearOrAdd(patch.userInstructions, "/spec/userInstructions", existing.spec?.userInstructions),
    ];
    const cr = ops.length > 0 ? await patchAgentInstanceCr(name, ops) : existing;
    return Response.json({ config: configFromCr(cr, updatedTmpl, entries) });
  } catch (e) {
    if (e instanceof InstanceConflictError) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return k8sErrorResponse(e);
  }
});
