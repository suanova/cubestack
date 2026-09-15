// Agent CRD facade — the read/write layer over the ai.cubestack.io agent CRDs
// (agentinstances / agenttemplates / skills) defined by the CubePilot operator
// (see suanova/cubepilot internal/api/v1alpha1 + internal/server/handlers_platform.go).
// The portal is the CRD-first client described in docs/cubepilot/api.md (path B):
// config / status / approval policy / skill whitelist are projected straight
// from these CRs, and the portal's writes are JSON-Patch ops on the CRs.
//
// All agent CRs live in the operator's namespace — the same one as the task
// CRs (CUBESTACK_TASKS_NAMESPACE, default cubestack-system).

import { getCustomObjectsClient } from "@/lib/kubernetes";

import { k8sErrorCode, k8sErrorResponse, tasksNamespace } from "./taskcrd";
import type { TemplateModelOption } from "./types";

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
    identity?: {
      mode?: string;
      principalRef?: { userRef?: string; serviceRef?: string };
    };
    selectedModel?: string;
    userInstructions?: string;
    /** "" / absent = inherit the template policy. */
    confirmPolicy?: string;
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
    lastActivity?: string;
    message?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

export interface AgentTemplateCr {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  spec?: {
    displayName?: string;
    description?: string;
    /** OpenClaw | Hermes — the agent runtime (template-level, not per-instance). */
    runtime?: string;
    defaultModel?: string;
    models?: Array<{ name?: string; endpoint?: string }>;
    instructions?: string;
    confirmPolicy?: string;
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

/** One JSON-Patch op (client-node sends custom-object patches as
 *  application/json-patch+json; an "add" op replaces an existing member). */
export interface JsonPatchOp {
  op: "add" | "replace" | "remove";
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
  try {
    const co = getCustomObjectsClient();
    return (await co.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: tasksNamespace(),
      plural,
      name,
    })) as T;
  } catch (e) {
    if (k8sErrorCode(e) === 404) return null;
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

export function getSkillCr(name: string): Promise<SkillCr | null> {
  return getCr<SkillCr>("skills", name);
}

export function getAgentTemplateCr(name: string): Promise<AgentTemplateCr | null> {
  return getCr<AgentTemplateCr>("agenttemplates", name);
}

/** The models the template inlines (the instance's model catalog, in list
 *  order). Entries without a name are dropped: they cannot be selected. */
export function templateModels(tmpl: AgentTemplateCr | null): TemplateModelOption[] {
  return (tmpl?.spec?.models ?? [])
    .filter((m): m is { name: string; endpoint?: string } => typeof m.name === "string" && m.name.length > 0)
    .map((m) => ({ name: m.name, endpoint: m.endpoint }));
}

export async function patchAgentInstanceCr(name: string, ops: JsonPatchOp[]): Promise<AgentInstanceCr> {
  const co = getCustomObjectsClient();
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
    identity: { mode: "user", principalRef: { userRef: input.user } },
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
