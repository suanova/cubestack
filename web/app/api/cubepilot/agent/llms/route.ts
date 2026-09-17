// /api/cubepilot/agent/llms — add an external provider to the builtin
// AgentTemplate (reference: POST /api/llms, handleAddLLM). A provider is a
// name, an OpenAI-compatible endpoint, the model ids it serves and either an
// apiKey (stored in a platform-managed Secret named llm-<name>) or public=true
// (no credential). Credentials are never written to the CR: the provider
// carries credentialRef only, and the operator renders it into the agent's
// OpenClaw config.

import {
  DEFAULT_AGENT_NAME,
  getAgentTemplateCr,
  k8sErrorResponse,
  patchAgentTemplateCr,
  upsertLlmCredential,
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
} from "@/lib/cubepilot/llm";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The CRD's cap on spec.providers (MaxItems). */
const MAX_PROVIDERS = 32;

/**
 * Undo a provider whose credential could not be written: an entry pointing at a
 * Secret that does not exist is selectable and then fails every turn. The
 * `test` on resourceVersion limits the undo to the state this request created —
 * without it a concurrent POST of the same provider would be rolled back by the
 * other request's failure. Best effort — the credential error is the one the
 * caller needs to see.
 */
async function rollbackAddedProvider(name: string, resourceVersion: string): Promise<void> {
  try {
    const tmpl = await getAgentTemplateCr(DEFAULT_AGENT_NAME);
    const index = providerIndex(tmpl?.spec?.providers, name);
    if (index >= 0) {
      await patchAgentTemplateCr(DEFAULT_AGENT_NAME, [
        { op: "test", path: "/metadata/resourceVersion", value: resourceVersion },
        { op: "remove", path: `/spec/providers/${index}` },
      ]);
    }
  } catch {
    // Leave it: the caller still gets the credential failure.
  }
}

export const POST = withAuth(async (req) => {
  let body: LlmRequest;
  try {
    body = (await req.json()) as LlmRequest;
  } catch {
    return Response.json({ error: "bad JSON body" }, { status: 400 });
  }
  const name = sanitizeProviderName(body.name ?? "");
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  const nameError = providerNameError(name);
  if (nameError) return Response.json({ error: nameError }, { status: 400 });
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(body.endpoint ?? "");
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  // The assertion above does not validate the JSON: a bare string iterates
  // per character and a non-array throws before modelIdsError could run, both
  // outside the try block below.
  const rawModels = body.models;
  if (rawModels !== undefined && (!Array.isArray(rawModels) || rawModels.some((m) => typeof m !== "string"))) {
    return Response.json({ error: "models must be an array of model id strings" }, { status: 400 });
  }
  const models = normalizeModelIds(rawModels ?? []);
  const modelsError = modelIdsError(models);
  if (modelsError) return Response.json({ error: modelsError }, { status: 400 });
  const apiKey = (body.apiKey ?? "").trim();
  const isPublic = body.public === true;
  const choiceError = credentialChoiceError(apiKey, isPublic);
  if (choiceError) return Response.json({ error: choiceError }, { status: 400 });

  try {
    const tmpl = await getAgentTemplateCr(DEFAULT_AGENT_NAME);
    if (!tmpl) return Response.json({ error: `builtin agent template "${DEFAULT_AGENT_NAME}" not found` }, { status: 503 });
    const providers = tmpl.spec?.providers ?? [];
    if (providerIndex(providers, name) >= 0) {
      return Response.json({ error: `provider "${name}" already exists` }, { status: 409 });
    }
    if (providers.length >= MAX_PROVIDERS) {
      return Response.json({ error: `the template must carry at most ${MAX_PROVIDERS} providers` }, { status: 400 });
    }
    const provider = {
      name,
      endpoint,
      models,
      ...(isPublic ? {} : { credentialRef: { name: llmCredentialName(name) } }),
    };
    // Commit the provider to the template BEFORE creating the credential
    // Secret: a failed template update leaves no orphaned key Secret.
    const patched = await patchAgentTemplateCr(DEFAULT_AGENT_NAME, [
      providers.length > 0
        ? { op: "add", path: "/spec/providers/-", value: provider }
        : { op: "add", path: "/spec/providers", value: [provider] },
    ]);
    if (!isPublic) {
      try {
        await upsertLlmCredential(llmCredentialName(name), apiKey);
      } catch (e) {
        await rollbackAddedProvider(name, patched.metadata?.resourceVersion ?? "");
        throw e;
      }
    }
    return Response.json({ provider });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
