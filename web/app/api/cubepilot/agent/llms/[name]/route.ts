// /api/cubepilot/agent/llms/[name] — edit or remove an external model on the
// builtin AgentTemplate (reference: PUT/DELETE /api/v1/llms/{name}). The model
// name is immutable: it is the selection key, the gateway provider key and the
// credential Secret name at once, so a rename is a delete plus an add.

import {
  DEFAULT_AGENT_NAME,
  deleteLlmCredential,
  getAgentTemplateCr,
  instancesSelectingModel,
  k8sErrorResponse,
  patchAgentTemplateCr,
  upsertLlmCredential,
} from "@/lib/cubepilot/agentcrd";
import {
  credentialChoiceError,
  llmCredentialName,
  modelIndex,
  normalizeEndpoint,
  sanitizeModelName,
  type LlmRequest,
} from "@/lib/cubepilot/llm";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/** The model's index in the template plus the template itself, or a Response. */
async function locate(name: string) {
  const tmpl = await getAgentTemplateCr(DEFAULT_AGENT_NAME);
  if (!tmpl) return { error: Response.json({ error: `builtin agent template "${DEFAULT_AGENT_NAME}" not found` }, { status: 503 }) };
  const models = tmpl.spec?.models ?? [];
  const index = modelIndex(models, name);
  if (index < 0) return { error: Response.json({ error: `model "${name}" not found` }, { status: 404 }) };
  return { tmpl, models, index };
}

export const PUT = withAuth<Ctx>(async (req, _session, ctx) => {
  const name = sanitizeModelName((await ctx.params).name);
  let body: LlmRequest;
  try {
    body = (await req.json()) as LlmRequest;
  } catch {
    return Response.json({ error: "bad JSON body" }, { status: 400 });
  }
  if (body.name !== undefined && sanitizeModelName(body.name) !== name) {
    return Response.json({ error: "the model name is immutable — delete and re-add to rename" }, { status: 400 });
  }
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(body.endpoint ?? "");
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  const apiKey = (body.apiKey ?? "").trim();
  const isPublic = body.public === true;
  if (isPublic && apiKey !== "") return Response.json({ error: credentialChoiceError(apiKey, true) }, { status: 400 });

  try {
    const found = await locate(name);
    if (found.error) return found.error;
    const { models, index } = found;
    const existing = models[index];
    const owned = llmCredentialName(name);

    // An edit may switch public → keyed (drop the ref) or keyed → public; a
    // keyed edit without a new key keeps the stored credential.
    const credentialRef = isPublic ? undefined : (apiKey !== "" ? { name: owned } : existing.credentialRef);

    const ops = [
      { op: "replace" as const, path: `/spec/models/${index}/endpoint`, value: endpoint },
      ...(isPublic
        ? existing.credentialRef
          ? [{ op: "remove" as const, path: `/spec/models/${index}/credentialRef` }]
          : []
        : credentialRef && credentialRef.name !== existing.credentialRef?.name
          ? [{ op: "add" as const, path: `/spec/models/${index}/credentialRef`, value: credentialRef }]
          : []),
    ];
    await patchAgentTemplateCr(DEFAULT_AGENT_NAME, ops);

    // The old Secret is only deleted when it was the platform-managed one.
    let warning = "";
    if (isPublic && existing.credentialRef?.name) {
      if (existing.credentialRef.name === owned) {
        await deleteLlmCredential(owned);
      } else {
        warning = `credential Secret "${existing.credentialRef.name}" is not the platform-managed "${owned}" and was left in place`;
      }
    }
    if (!isPublic && apiKey !== "") await upsertLlmCredential(owned, apiKey);
    return Response.json({ model: { name, endpoint, ...(credentialRef ? { credentialRef } : {}) }, ...(warning ? { warning } : {}) });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});

export const DELETE = withAuth<Ctx>(async (_req, _session, ctx) => {
  const name = sanitizeModelName((await ctx.params).name);
  try {
    const found = await locate(name);
    if (found.error) return found.error;
    const { index } = found;
    // Refuse while someone's agent still selects this model: deleting it would
    // break their turns (reference instancesSelecting).
    const users = await instancesSelectingModel(name);
    if (users.length > 0) {
      return Response.json(
        { error: `model "${name}" is selected by ${users.length} instance(s): ${users.map((u) => u.name).join(", ")}` },
        { status: 409 },
      );
    }
    const existing = (found.models ?? [])[index];
    await patchAgentTemplateCr(DEFAULT_AGENT_NAME, [{ op: "remove", path: `/spec/models/${index}` }]);
    // Only the Secret this API names after the model is removed: a CR pointing
    // a model at a Secret it shares with another model must not lose it.
    const owned = llmCredentialName(name);
    let warning = "";
    if (existing?.credentialRef?.name) {
      if (existing.credentialRef.name === owned) await deleteLlmCredential(owned);
      else warning = `credential Secret "${existing.credentialRef.name}" is not the platform-managed "${owned}" and was left in place`;
    }
    return Response.json({ deleted: name, ...(warning ? { warning } : {}) });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
