// LLM catalog helpers for the agent's model list (reference: internal/server/
// handlers_llms.go). A model is a concrete OpenAI-compatible endpoint plus an
// optional platform-managed credential Secret — the apiKey is NEVER stored in a
// CR, only referenced through TemplateModelSpec.credentialRef.

/** One model of the builtin AgentTemplate. */
export interface TemplateModelCr {
  name?: string;
  endpoint?: string;
  credentialRef?: { name?: string };
}

/** The {name, endpoint, apiKey?, public?} body of an add/edit request. */
export interface LlmRequest {
  name?: string;
  endpoint?: string;
  apiKey?: string;
  public?: boolean;
}

/** The credential Secret name for a model: the model name is immutable and is
 *  the selection key, so the Secret name never drifts (reference llm-<name>). */
export function llmCredentialName(modelName: string): string {
  return `llm-${modelName}`;
}

/** Sanitize a user-typed model name into the DNS-1123-ish key the CRD, the
 *  gateway provider and the Secret name all use. */
export function sanitizeModelName(raw: string): string {
  const out = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return out;
}

/**
 * Validate an endpoint and reduce it to the API root an OpenAI SDK expects: the
 * SDK appends /chat/completions itself, so an endpoint copied from a working
 * curl command (a full request URL) would be doubled. Only that one suffix is
 * stripped, and a missing /v1 is never added — a root endpoint is correct for
 * some providers, so guessing a path prefix would break them.
 *
 * Throws with the message to return to the caller.
 */
export function normalizeEndpoint(raw: string): string {
  const endpoint = (raw ?? "").trim().replace(/\/+$/, "");
  const suffix = "/chat/completions";
  const trimmed =
    endpoint.length >= suffix.length && endpoint.slice(-suffix.length).toLowerCase() === suffix
      ? endpoint.slice(0, -suffix.length).replace(/\/+$/, "")
      : endpoint;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("endpoint must be a valid URL");
  }
  if (!url.protocol || !url.host) throw new Error("endpoint must be a valid URL");
  return trimmed;
}

/**
 * Validate the {apiKey, public} pair of an add, which has no stored credential
 * to fall back on: exactly one of the two must be given. A model saved without
 * a credential would be selectable and then fail every turn with "no API key
 * resolved". Returns the message to send, or "" when the pair is valid.
 */
export function credentialChoiceError(apiKey: string, isPublic: boolean): string {
  if (isPublic && apiKey !== "") {
    return "apiKey and public are mutually exclusive: a public model has no credential";
  }
  if (!isPublic && apiKey === "") {
    return "apiKey is required unless the model is declared public (public=true)";
  }
  return "";
}

/** Index of the model with this name, or -1. */
export function modelIndex(models: TemplateModelCr[] | undefined, name: string): number {
  return (models ?? []).findIndex((m) => m.name === name);
}
