// Agent CRD facade — the read/write layer over the ai.cubestack.io agent CRDs
// (agentinstances / agenttemplates / skills) defined by the CubePilot operator
// (see suanova/cubepilot internal/api/v1alpha1 + internal/server/handlers_platform.go).
// The portal is the CRD-first client described in docs/cubepilot/api.md (path B):
// config / status / approval policy / skill whitelist are projected straight
// from these CRs, and the portal's writes are JSON-Patch ops on the CRs.
//
// All agent CRs live in the operator's namespace — the same one as the task
// CRs (CUBESTACK_TASKS_NAMESPACE, default cubestack-system).

import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";
import { logger } from "@/lib/log";

import { k8sErrorCode, k8sErrorResponse, tasksNamespace } from "./taskcrd";
import type { TemplateProviderCr } from "./llm";
import { modelKey } from "./llm";
import { PLATFORM_MODEL_NAME, type TemplateProviderOption } from "./types";

const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";

/** The builtin platform agent template (auto-instantiated per user). */
export const DEFAULT_AGENT_NAME = "cubepilot";

// ── raw CR shapes (only the fields we read / write) ──────────────────────

export interface AllowlistRuleCr {
  pattern?: string;
  argPattern?: string;
}

export interface AgentInstanceCr {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  spec?: {
    templateRef?: string;
    owner?: string;
    selectedModel?: string;
    userInstructions?: string;
    /** "" / absent = inherit the template policy. */
    approvalPolicy?: string;
    /** The instance's own allowlist rules ("owned"); template rules are inherited. */
    allowlist?: AllowlistRuleCr[];
    /** Skills enabled for this instance; empty = the all-enabled baseline. */
    enabledSkills?: string[];
  };
  status?: {
    phase?: string;
    podName?: string;
    pvcName?: string;
    serviceName?: string;
    message?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

export interface AgentTemplateCr {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
    /** Server-assigned; the precondition a compensating patch tests. */
    resourceVersion?: string;
  };
  spec?: {
    displayName?: string;
    description?: string;
    /** OpenClaw | Hermes — the agent runtime (template-level, not per-instance). */
    runtime?: string;
    /** The "<provider>/<modelId>" ref an instance without its own selection
     *  runs ("" = none). */
    defaultModel?: string;
    /** The inline provider list: each provider owns an endpoint, an optional
     *  credential Secret and the model ids it serves. */
    providers?: TemplateProviderCr[];
    instructions?: string;
    approvalPolicy?: string;
    allowlist?: AllowlistRuleCr[];
    skills?: string[];
  };
}

export interface SkillCr {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  spec?: {
    displayName?: string;
    description?: string;
    visibility?: string;
    source?: { type?: string; path?: string; sha256?: string };
  };
  status?: {
    phase?: string;
  };
}

export { PLATFORM_MODEL_NAME } from "./types";

/** One JSON-Patch op (client-node sends custom-object patches as
 *  application/json-patch+json; an "add" op replaces an existing member).
 *  "test" carries a precondition: it fails the whole patch when the target
 *  does not hold the given value. */
export interface JsonPatchOp {
  op: "add" | "replace" | "remove" | "test";
  path: string;
  value?: unknown;
}

// ── namespacing & naming ──────────────────────────────────────────────────

// The operator namespace is shared with the task CRs (one operator ns);
// re-exported so the agent routes import one module.
export { k8sErrorResponse, tasksNamespace };

/**
 * Mirrors the operator's Sanitize (internal/k8s/client.go): lowercase, runs of
 * [^a-z0-9-] collapse to "-", dashes trimmed, empty falls back to "user".
 */
export function sanitizeIdentity(s: string): string {
  let out = s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (out === "") out = "user";
  return out;
}

/** The caller's AgentInstance name: <user>-<agent> (the operator's InstanceName). */
export function agentInstanceName(user: string): string {
  return `${sanitizeIdentity(user)}-${sanitizeIdentity(DEFAULT_AGENT_NAME)}`;
}

/**
 * True when the skill is part of the all-enabled baseline: Platform-visible
 * and reachable (the operator's resolver baseline for an empty enabledSkills).
 */
export function skillInBaseline(skill: SkillCr): boolean {
  return (skill.spec?.visibility ?? "Platform") === "Platform" && skill.status?.phase !== "Unreachable";
}

/** The baseline skill names (Platform-visible, reachable), list order kept. */
export function baselineSkillNames(skills: SkillCr[]): string[] {
  return skills.filter(skillInBaseline).map((s) => s.metadata?.name ?? "").filter((n) => n.length > 0);
}

/**
 * Whether a skill is enabled for the instance: an empty enabledSkills list is
 * the all-enabled baseline (only reachable Platform skills), a non-empty list
 * is an explicit allow-set.
 */
export function skillEnabled(instance: AgentInstanceCr | null, skill: SkillCr): boolean {
  const enabled = instance?.spec?.enabledSkills ?? [];
  if (enabled.length === 0) return skillInBaseline(skill);
  return enabled.includes(skill.metadata?.name ?? "");
}

// ── k8s operations ────────────────────────────────────────────────────────

async function getCr<T>(plural: string, name: string): Promise<T | null> {
  const ns = tasksNamespace();
  try {
    const co = getCustomObjectsClient();
    const out = (await co.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: ns,
      plural,
      name,
    })) as T;
    logger("agent").debug("get ok", { plural, namespace: ns, name });
    return out;
  } catch (e) {
    if (k8sErrorCode(e) === 404) {
      // Treated as "absent": log it, because a 404 here is usually a missing
      // namespace, a CRD that is not installed, or the operator not having
      // created the object — the three causes of an empty page.
      logger("agent").warn("get 404 (treated as absent)", { plural, namespace: ns, name, error: e });
      return null;
    }
    throw e;
  }
}

export function listSkillCrs(): Promise<SkillCr[]> {
  const co = getCustomObjectsClient();
  return co
    .listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: tasksNamespace(),
      plural: "skills",
    })
    .then((res) => (res.items ?? []) as SkillCr[]);
}

export function getAgentInstanceCr(name: string): Promise<AgentInstanceCr | null> {
  return getCr<AgentInstanceCr>("agentinstances", name);
}

/**
 * The caller's own AgentInstance, for every read path. The name is derived
 * from the sanitized identity, which folds case and punctuation, so two
 * distinct authenticated users can map to one CR name; an instance that exists
 * under a different owner is therefore reported as absent rather than returned.
 */
export async function getOwnedAgentInstanceCr(user: string): Promise<AgentInstanceCr | null> {
  const cr = await getAgentInstanceCr(agentInstanceName(user));
  if (cr && cr.spec?.owner !== user) {
    logger("agent").warn("agent instance name is held by another owner — treated as absent", {
      name: cr.metadata?.name,
      owner: cr.spec?.owner,
    });
    return null;
  }
  return cr;
}

export function getSkillCr(name: string): Promise<SkillCr | null> {
  return getCr<SkillCr>("skills", name);
}

export function getAgentTemplateCr(name: string): Promise<AgentTemplateCr | null> {
  return getCr<AgentTemplateCr>("agenttemplates", name);
}

/** Whether two model-id lists hold the same ids in the same order. */
function sameModels(a: string[] | undefined, b: string[]): boolean {
  const current = a ?? [];
  return current.length === b.length && current.every((id, i) => id === b[i]);
}

/**
 * Make sure the template has exactly one platform provider with the resolved
 * endpoint and model list: the provider is updated in place when either moved,
 * appended when missing (the rest of the catalog is left alone), and left
 * untouched when it is already current. Returns the ops to send (empty =
 * nothing to do).
 */
export function platformProviderOps(
  providers: TemplateProviderCr[] | undefined,
  endpoint: string,
  modelIds: string[],
): JsonPatchOp[] {
  const list = providers ?? [];
  const entry = { name: PLATFORM_MODEL_NAME, endpoint, models: modelIds };
  const index = list.findIndex((p) => p.name === PLATFORM_MODEL_NAME);
  if (index < 0) {
    return list.length > 0
      ? [{ op: "add", path: "/spec/providers/-", value: entry }]
      : [{ op: "add", path: "/spec/providers", value: [entry] }];
  }
  const current = list[index];
  const ops: JsonPatchOp[] = [];
  if (current.endpoint !== endpoint) {
    ops.push({ op: "replace", path: `/spec/providers/${index}/endpoint`, value: endpoint });
  }
  if (!sameModels(current.models, modelIds)) {
    ops.push({ op: "replace", path: `/spec/providers/${index}/models`, value: modelIds });
  }
  // Never leave the platform provider bound to someone else's credential
  // Secret: the gateway entry needs none.
  if (current.credentialRef) ops.push({ op: "remove", path: `/spec/providers/${index}/credentialRef` });
  return ops;
}

/** The template's provider catalog, in list order. Entries without a name are
 *  dropped: they define no ref an instance could select. */
export function templateProviders(tmpl: AgentTemplateCr | null): TemplateProviderOption[] {
  return (tmpl?.spec?.providers ?? [])
    .filter((p): p is TemplateProviderCr & { name: string } => typeof p.name === "string" && p.name.length > 0)
    .map((p) => ({
      name: p.name,
      endpoint: p.endpoint,
      models: p.models ?? [],
      keyed: Boolean(p.credentialRef?.name),
      // The platform provider points at the AI Gateway, so it is presented as a
      // system provider (and stays out of the external-provider editor).
      origin: p.name === PLATFORM_MODEL_NAME ? ("system" as const) : ("external" as const),
    }));
}

/** The refs a provider defines: "<name>/<modelId>" for each model it serves. */
export function providerRefs(provider: TemplateProviderCr): string[] {
  const name = provider.name ?? "";
  return (provider.models ?? []).map((id) => modelKey(name, id));
}

/** The caller's agent instances that select one of the given refs — the delete
 *  guard for a provider edit (reference instancesSelecting). */
export async function instancesSelectingRefs(refs: string[]): Promise<Array<{ name: string; owner: string }>> {
  const wanted = new Set(refs);
  if (wanted.size === 0) return [];
  const co = getCustomObjectsClient();
  const res = (await co.listNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: tasksNamespace(),
    plural: "agentinstances",
  })) as { items?: Array<{ metadata?: { name?: string }; spec?: { selectedModel?: string; templateRef?: string } }> };
  return (res.items ?? [])
    .filter((i) => {
      const selected = i.spec?.selectedModel;
      return (
        selected !== undefined &&
        wanted.has(selected) &&
        (i.spec?.templateRef ?? DEFAULT_AGENT_NAME) === DEFAULT_AGENT_NAME
      );
    })
    .map((i) => ({ name: i.metadata?.name ?? "", owner: (i.spec as { owner?: string } | undefined)?.owner ?? "" }));
}

export async function patchAgentInstanceCr(name: string, ops: JsonPatchOp[]): Promise<AgentInstanceCr> {
  const co = getCustomObjectsClient();
  logger("agent").debug("patch", { plural: "agentinstances", namespace: tasksNamespace(), name, paths: ops.map((o) => o.path) });
  return (await co.patchNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: tasksNamespace(),
    plural: "agentinstances",
    name,
    body: ops,
    fieldManager: "cubestack-web",
  })) as AgentInstanceCr;
}

/** Thrown when the instance name belongs to a different owner. */
export class InstanceConflictError extends Error {}

export interface CreateAgentInstanceInput {
  /** The caller (becomes spec.owner and the identity's userRef). */
  user: string;
  selectedModel?: string;
  userInstructions?: string;
}

export interface EnsureAgentInstanceResult {
  cr: AgentInstanceCr;
  /** true = the instance already existed (same owner); false = just created. */
  alreadyExists: boolean;
}

/**
 * Create the caller's AgentInstance (the idempotent CRD-first equivalent of the
 * reference API's POST /api/v1/instances). An existing instance owned by the
 * caller is returned as-is; one owned by someone else is a conflict (the name
 * is derived from a sanitized identity, so a case-variant caller can collide).
 */
export async function ensureAgentInstance(input: CreateAgentInstanceInput): Promise<EnsureAgentInstanceResult> {
  const co = getCustomObjectsClient();
  const ns = tasksNamespace();
  const name = agentInstanceName(input.user);
  const spec: Record<string, unknown> = {
    templateRef: DEFAULT_AGENT_NAME,
    owner: input.user,
  };
  if (input.selectedModel) spec.selectedModel = input.selectedModel;
  if (input.userInstructions) spec.userInstructions = input.userInstructions;
  try {
    const cr = (await co.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: ns,
      plural: "agentinstances",
      body: { apiVersion: `${GROUP}/${VERSION}`, kind: "AgentInstance", metadata: { name, namespace: ns }, spec },
    })) as AgentInstanceCr;
    return { cr, alreadyExists: false };
  } catch (e) {
    if (k8sErrorCode(e) !== 409) throw e;
    const existing = await getAgentInstanceCr(name);
    if (existing && existing.spec?.owner === input.user) return { cr: existing, alreadyExists: true };
    throw new InstanceConflictError("an agent instance with this name belongs to another user");
  }
}

/** JSON-Patch the builtin AgentTemplate (the model catalog lives there). */
export async function patchAgentTemplateCr(name: string, ops: JsonPatchOp[]): Promise<AgentTemplateCr> {
  const co = getCustomObjectsClient();
  logger("agent").debug("patch", { plural: "agenttemplates", namespace: tasksNamespace(), name, paths: ops.map((o) => o.path) });
  return (await co.patchNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: tasksNamespace(),
    plural: "agenttemplates",
    name,
    body: ops,
    fieldManager: "cubestack-web",
  })) as AgentTemplateCr;
}

/**
 * Create the credential Secret for a keyed model, or refresh its apiKey when it
 * already exists (so re-adding a model with a new key takes effect). The key is
 * never written to a CR — the template only carries the Secret reference.
 */
export async function upsertLlmCredential(secretName: string, apiKey: string): Promise<void> {
  const core = getCoreClient();
  const ns = tasksNamespace();
  // Never log apiKey: only the Secret name and its namespace.
  logger("agent").debug("upsert credential secret", { namespace: ns, name: secretName });
  const data = { apiKey: Buffer.from(apiKey, "utf8").toString("base64") };
  try {
    await core.createNamespacedSecret({ namespace: ns, body: { metadata: { name: secretName, namespace: ns }, type: "Opaque", data } });
    return;
  } catch (e) {
    if (k8sErrorCode(e) !== 409) throw e;
  }
  await core.patchNamespacedSecret({
    name: secretName,
    namespace: ns,
    body: { data },
  });
}

/** Delete a credential Secret; a missing Secret is success (the goal is that it
 *  does not exist). */
export async function deleteLlmCredential(secretName: string): Promise<void> {
  const core = getCoreClient();
  logger("agent").debug("delete credential secret", { namespace: tasksNamespace(), name: secretName });
  try {
    await core.deleteNamespacedSecret({ name: secretName, namespace: tasksNamespace() });
  } catch (e) {
    if (k8sErrorCode(e) !== 404) throw e;
  }
}

// ── enabledSkills set ops (mirror the reference install/uninstall) ────────

/** The new enabledSkills after installing a skill (idempotent). */
export function withSkillEnabled(instance: AgentInstanceCr | null, name: string): string[] {
  const enabled = instance?.spec?.enabledSkills ?? [];
  // Empty = the all-enabled baseline; installing is a no-op there.
  if (enabled.length === 0 || enabled.includes(name)) return enabled;
  return [...enabled, name];
}

/**
 * The new enabledSkills after uninstalling a skill. On the all-enabled
 * baseline the set is materialized to the baseline skills minus the one, so
 * later publishes do not re-enable it.
 */
export function withSkillDisabled(instance: AgentInstanceCr | null, name: string, baseline: string[]): string[] {
  const enabled = instance?.spec?.enabledSkills ?? [];
  if (enabled.length === 0) return baseline.filter((n) => n !== name);
  return enabled.filter((n) => n !== name);
}
