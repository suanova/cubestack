// /api/cubepilot/agent/llms — add an external model to the builtin
// AgentTemplate (reference: POST /api/v1/llms, handleAddLLM). A model is a
// name, an OpenAI-compatible endpoint and either an apiKey (stored in a
// platform-managed Secret named llm-<name>) or public=true (no credential).
// Credentials are never written to the CR: the model carries credentialRef
// only, and the operator renders the model into the AI Gateway.

import {
  DEFAULT_AGENT_NAME,
  getAgentTemplateCr,
  k8sErrorResponse,
  patchAgentTemplateCr,
  upsertLlmCredential,
} from "@/lib/cubepilot/agentcrd";
import { credentialChoiceError, llmCredentialName, normalizeEndpoint, sanitizeModelName, type LlmRequest } from "@/lib/cubepilot/llm";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withAuth(async (req) => {
  let body: LlmRequest;
  try {
    body = (await req.json()) as LlmRequest;
  } catch {
    return Response.json({ error: "bad JSON body" }, { status: 400 });
  }
  const name = sanitizeModelName(body.name ?? "");
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(body.endpoint ?? "");
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  const apiKey = (body.apiKey ?? "").trim();
  const isPublic = body.public === true;
  const choiceError = credentialChoiceError(apiKey, isPublic);
  if (choiceError) return Response.json({ error: choiceError }, { status: 400 });

  try {
    const tmpl = await getAgentTemplateCr(DEFAULT_AGENT_NAME);
    if (!tmpl) return Response.json({ error: `builtin agent template "${DEFAULT_AGENT_NAME}" not found` }, { status: 503 });
    const models = tmpl.spec?.models ?? [];
    if (models.some((m) => m.name === name)) {
      return Response.json({ error: `model "${name}" already exists` }, { status: 409 });
    }
    const model = {
      name,
      endpoint,
      ...(isPublic ? {} : { credentialRef: { name: llmCredentialName(name) } }),
    };
    // Commit the model to the template BEFORE creating the credential Secret: a
    // failed template update leaves no orphaned key Secret.
    await patchAgentTemplateCr(DEFAULT_AGENT_NAME, [
      models.length > 0 ? { op: "add", path: "/spec/models/-", value: model } : { op: "add", path: "/spec/models", value: [model] },
    ]);
    if (!isPublic) await upsertLlmCredential(llmCredentialName(name), apiKey);
    return Response.json({ model });
  } catch (e) {
    return k8sErrorResponse(e);
  }
});
