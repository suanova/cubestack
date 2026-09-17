// /api/cubepilot/agent/llms/[name] — edit or remove an external provider on the
// builtin AgentTemplate (reference: PUT/DELETE /api/llms/{name}). The provider
// name is immutable: it is the ref prefix, the gateway provider key and the
// credential Secret name at once, so a rename is a delete plus an add.

import {
  DEFAULT_AGENT_NAME,
  deleteLlmCredential,
  getAgentTemplateCr,
  instancesSelectingRefs,
  k8sErrorResponse,
  patchAgentTemplateCr,
  providerRefs,
  upsertLlmCredential,
  type JsonPatchOp,
} from "@/lib/cubepilot/agentcrd";
import {
  credentialChoiceError,
  llmCredentialName,
  modelIdsError,
  normalizeEndpoint,
  normalizeModelIds,
  providerIndex,
  providerNameError,
  sanitizeProviderName,
  type LlmRequest,
  type TemplateProviderCr,
} from "@/lib/cubepilot/llm";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/** The provider's index in the template plus the template itself, or a Response. */
async function locate(name: string) {
  const tmpl = await getAgentTemplateCr(DEFAULT_AGENT_NAME);
  if (!tmpl) return { error: Response.json({ error: `builtin agent template "${DEFAULT_AGENT_NAME}" not found` }, { status: 503 }) };
  const providers = tmpl.spec?.providers ?? [];
  const index = providerIndex(providers, name);
  if (index < 0) return { error: Response.json({ error: `provider "${name}" not found` }, { status: 404 }) };
  return { tmpl, providers, index };
}

/**
 * Undo a provider edit whose credential change failed, so the template never
 * keeps an entry the failed write left inconsistent (for example one naming a
 * Secret that was never written). The `test` on resourceVersion is what makes
 * this safe: `index` and `previous` come from the read that preceded the edit,
 * and a concurrent request may have changed the entry since — in that case the
 * patch is rejected whole and the other request's write stands. Best effort —
 * the original error is the one to report.
 */
async function restoreProvider(index: number, previous: TemplateProviderCr, resourceVersion: string): Promise<void> {
  try {
    await patchAgentTemplateCr(DEFAULT_AGENT_NAME, [
      { op: "test", path: "/metadata/resourceVersion", value: resourceVersion },
      { op: "replace", path: `/spec/providers/${index}`, value: previous },
    ]);
  } catch {
    // Leave it: the caller still gets the credential failure.
  }
}

/** Whether two model-id lists hold the same ids in the same order. */
function sameModels(a: string[] | undefined, b: string[]): boolean {
  const current = a ?? [];
  return current.length === b.length && current.every((id, i) => id === b[i]);
}

export const PUT = withAuth<Ctx>(async (req, _session, ctx) => {
  const name = sanitizeProviderName((await ctx.params).name);
  const nameError = providerNameError(name);
  if (nameError) return Response.json({ error: nameError }, { status: 400 });
  let body: LlmRequest;
  try {
    body = (await req.json()) as LlmRequest;
  } catch {
    return Response.json({ error: "bad JSON body" }, { status: 400 });
  }
  if (body.name !== undefined && sanitizeProviderName(body.name) !== name) {
    return Response.json({ error: "the provider name is immutable — delete and re-add to rename" }, { status: 400 });
  }
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(body.endpoint ?? "");
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  // The model list is replaced wholesale, so adding or removing one id is this
  // same request. The assertion does not validate JSON: a bare string would
  // iterate per character and a non-array would throw, both outside the try
  // block below.
  const rawModels = body.models;
  if (rawModels !== undefined && (!Array.isArray(rawModels) || rawModels.some((m) => typeof m !== "string"))) {
    return Response.json({ error: "models must be an array of model id strings" }, { status: 400 });
  }
  const models = normalizeModelIds(rawModels ?? []);
  const modelsError = modelIdsError(models);
  if (modelsError) return Response.json({ error: modelsError }, { status: 400 });
  const apiKey = (body.apiKey ?? "").trim();
  const isPublic = body.public === true;
  if (isPublic && apiKey !== "") return Response.json({ error: credentialChoiceError(apiKey, true) }, { status: 400 });

  try {
    const found = await locate(name);
    if (found.error) return found.error;
    const { providers, index } = found;
    const existing = providers[index];
    const owned = llmCredentialName(name);

    // An edit may drop model ids the list used to carry: an instance selecting
    // a dropped ref would fail on its next turn, so refuse like the DELETE
    // guard (instancesSelecting) rather than break it.
    const removedIds = (existing.models ?? []).filter((id) => !models.includes(id));
    if (removedIds.length > 0) {
      const users = await instancesSelectingRefs(providerRefs({ ...existing, models: removedIds }));
      if (users.length > 0) {
        return Response.json(
          {
            error: `cannot remove model id(s) ${removedIds.join(", ")} from "${name}" — selected by ${users.length} instance(s): ${users
              .map((u) => u.name)
              .join(", ")}`,
          },
          { status: 409 },
        );
      }
    }

    // An edit may switch public → keyed (drop the ref) or keyed → public; a
    // keyed edit without a new key keeps the stored credential.
    const credentialRef = isPublic ? undefined : (apiKey !== "" ? { name: owned } : existing.credentialRef);

    const ops: JsonPatchOp[] = [
      { op: "replace", path: `/spec/providers/${index}/endpoint`, value: endpoint },
      ...(sameModels(existing.models, models)
        ? []
        : [{ op: "replace" as const, path: `/spec/providers/${index}/models`, value: models }]),
      ...(isPublic
        ? existing.credentialRef
          ? [{ op: "remove" as const, path: `/spec/providers/${index}/credentialRef` }]
          : []
        : credentialRef && credentialRef.name !== existing.credentialRef?.name
          ? [{ op: "add" as const, path: `/spec/providers/${index}/credentialRef`, value: credentialRef }]
          : []),
    ];
    const patched = await patchAgentTemplateCr(DEFAULT_AGENT_NAME, ops);

    // The old Secret is only deleted when it was the platform-managed one.
    let warning = "";
    try {
      if (isPublic && existing.credentialRef?.name) {
        if (existing.credentialRef.name === owned) {
          await deleteLlmCredential(owned);
        } else {
          warning = `credential Secret "${existing.credentialRef.name}" is not the platform-managed "${owned}" and was left in place`;
        }
      }
      if (!isPublic && apiKey !== "") await upsertLlmCredential(owned, apiKey);
    } catch (e) {
      await restoreProvider(index, existing, patched.metadata?.resourceVersion ?? "");
      throw e;
    }
    return Response.json({
      provider: { name, endpoint, models, ...(credentialRef ? { credentialRef } : {}) },
      ...(warning ? { warning } : {}),
    });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});

export const DELETE = withAuth<Ctx>(async (_req, _session, ctx) => {
  const name = sanitizeProviderName((await ctx.params).name);
  try {
    const found = await locate(name);
    if (found.error) return found.error;
    const { index } = found;
    const existing = (found.providers ?? [])[index];
    // Refuse while someone's agent still selects one of this provider's refs:
    // deleting it would break their turns (reference instancesSelecting).
    const users = await instancesSelectingRefs(providerRefs(existing));
    if (users.length > 0) {
      return Response.json(
        { error: `provider "${name}" is selected by ${users.length} instance(s): ${users.map((u) => u.name).join(", ")}` },
        { status: 409 },
      );
    }
    await patchAgentTemplateCr(DEFAULT_AGENT_NAME, [{ op: "remove", path: `/spec/providers/${index}` }]);
    // Only the Secret this API names after the provider is removed: a CR pointing
    // a provider at a Secret it shares with another one must not lose it.
    const owned = llmCredentialName(name);
    let warning = "";
    const ref = existing?.credentialRef?.name;
    if (ref && ref !== owned) {
      warning = `credential Secret "${ref}" is not the platform-managed "${owned}" and was left in place`;
    } else if (ref) {
      try {
        await deleteLlmCredential(owned);
      } catch (e) {
        // The provider is already gone: a Secret left behind is a cleanup
        // problem, not a failed delete.
        warning = `credential Secret "${owned}" could not be removed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return Response.json({ deleted: name, ...(warning ? { warning } : {}) });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
