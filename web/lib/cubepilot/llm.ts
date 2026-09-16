// LLM catalog helpers for the agent template's provider list (reference:
// internal/server/handlers_llms.go). A provider is a named OpenAI-compatible
// endpoint plus the backend model ids it serves and an optional
// platform-managed credential Secret — the apiKey is NEVER stored in a CR,
// only referenced through TemplateProviderCr.credentialRef. An instance
// selects one of the refs the providers define: "<provider>/<modelId>".

/** One provider of the builtin AgentTemplate (spec.providers[]). */
export interface TemplateProviderCr {
  /** The provider key: the ref prefix and the OpenClaw models.providers key. */
  name?: string;
  endpoint?: string;
  /** The backend model ids served through the endpoint, sent verbatim. An id
   *  may itself contain "/" (OpenRouter's "anthropic/claude-sonnet-4.5"). */
  models?: string[];
  credentialRef?: { name?: string };
}

/** The {name, endpoint, models, apiKey?, public?} body of an add/edit request. */
export interface LlmRequest {
  name?: string;
  endpoint?: string;
  models?: string[];
  apiKey?: string;
  public?: boolean;
}

/** The credential Secret name for a provider: the provider name is immutable
 *  and is the selection key, so the Secret name never drifts (reference
 *  llm-<name>). */
export function llmCredentialName(providerName: string): string {
  return `llm-${providerName}`;
}

/** DNS-1123 label — the CRD's Pattern on a provider name (max 63 characters). */
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const MAX_PROVIDER_NAME = 63;
/** The CRD's caps on one provider's model list. */
export const MAX_PROVIDER_MODELS = 64;
const MAX_MODEL_ID = 256;

/** Sanitize a user-typed provider name into the DNS-1123 label the CRD, the
 *  gateway provider key, the ref prefix and the Secret name all use. */
export function sanitizeProviderName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, MAX_PROVIDER_NAME)
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether a sanitized provider name can name a k8s object, or the message to
 * return. The name is a DNS-1123 label: a bad one is rejected by the API server
 * on the next write, leaving the provider it was added for unusable. Returns ""
 * when the name is usable.
 */
export function providerNameError(name: string): string {
  if (name === "" || name.length > MAX_PROVIDER_NAME || !DNS_1123_LABEL.test(name)) {
    return `provider name "${name}" must be a DNS-1123 label: lowercase letters, digits and "-", at most ${MAX_PROVIDER_NAME} characters`;
  }
  return "";
}

/**
 * Trim, drop empty entries and de-duplicate the requested model ids, keeping
 * the given order (the CRD stores them as a set, so a duplicate is rejected).
 */
export function normalizeModelIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = (raw ?? "").trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The message for a model id the CRD would reject, or "". The CEL rule on
 * spec.providers (and Validate in the reference) refuses an empty id, the
 * wildcard, a leading/trailing "/", an empty path segment and whitespace —
 * every one of those would render a provider whose ids cannot be selected.
 */
export function modelIdError(id: string): string {
  if (
    id === "" ||
    id === "*" ||
    id.length > MAX_MODEL_ID ||
    /\s/.test(id) ||
    id.includes("//") ||
    id.startsWith("/") ||
    id.endsWith("/")
  ) {
    return `model id "${id}" is unusable: it must be non-empty, at most ${MAX_MODEL_ID} characters, with no whitespace, no empty path segment and no leading or trailing "/"`;
  }
  return "";
}

/** The message for a provider's model list, or "" when the CRD accepts it. */
export function modelIdsError(ids: string[]): string {
  if (ids.length === 0) return "the provider needs at least one model id: list the ids the endpoint serves";
  if (ids.length > MAX_PROVIDER_MODELS) {
    return `a provider serves at most ${MAX_PROVIDER_MODELS} model ids (got ${ids.length})`;
  }
  for (const id of ids) {
    const err = modelIdError(id);
    if (err) return err;
  }
  return "";
}

/** The canonical "<provider>/<modelId>" ref an instance selects (mirrors the
 *  operator's gateway.ModelKey): an id that already starts with "<provider>/"
 *  is its own key, so it is never prefixed twice. */
export function modelKey(provider: string, modelId: string): string {
  const p = provider.trim();
  const id = modelId.trim();
  if (p === "") return id;
  if (id === "") return p;
  return id.toLowerCase().startsWith(`${p.toLowerCase()}/`) ? id : `${p}/${id}`;
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
 * to fall back on: exactly one of the two must be given. A provider saved
 * without a credential would be selectable and then fail every turn with "no
 * API key resolved". Returns the message to send, or "" when the pair is valid.
 */
export function credentialChoiceError(apiKey: string, isPublic: boolean): string {
  if (isPublic && apiKey !== "") {
    return "apiKey and public are mutually exclusive: a public provider has no credential";
  }
  if (!isPublic && apiKey === "") {
    return "apiKey is required unless the provider is declared public (public=true)";
  }
  return "";
}

/** Index of the provider with this name, or -1. */
export function providerIndex(providers: TemplateProviderCr[] | undefined, name: string): number {
  return (providers ?? []).findIndex((p) => p.name === name);
}
