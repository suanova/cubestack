import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";
import { privateGatewayClusterEndpoint } from "@/lib/cubepilot/gateway";
import { CATALOG_PATHS, isAIGatewayRouter, isCatalogPath, type CatalogPath } from "@/lib/inference-routes";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered at
// build time.
export const dynamic = "force-dynamic";

// Operator CRD group/version (operator/api/v1alpha1/groupversion_info.go) and
// the plurals registered in operator/config/crd/bases/*.yaml.
const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";
const PLURAL_ISVC = "inferenceservices";
const PLURAL_PROFILE = "inferenceruntimeprofiles";

// Prometheus is reached through the Perses datasource proxy (the same path the
// overview route and the perses panels use). Per-service engine metrics are
// best-effort: without a queryable source the page shows an empty state rather
// than failing.
const PERSES_SERVER_URL = process.env.PERSES_SERVER_URL ?? "http://localhost:8080";
const PROMETHEUS_DATASOURCE = "prometheus-datasource";

/**
 * Shape of a single service rendered by the /inference-services page. This is
 * the read/display contract; everything is projected from the live cluster —
 * the prototype (web/public/inference-services.html) is only the visual
 * reference, never a data source.
 */
export interface InferenceServiceSummary {
  // identity
  name: string;
  namespace: string;
  profileRef: string;
  modelRef: string;
  published: boolean;
  // The shared catalog route the service publishes to (public or private), or
  // null when it is not published. Drives which endpoint the detail card shows.
  aigatewayRouter: string | null;
  routeModelName: string | null;
  timeoutSeconds: number | null;
  idleTimeoutSeconds: number | null;
  createdAt: string | null;
  // resolved profile facts
  engine: string | null;
  engineVersion: string | null;
  vendor: string | null;
  gpuModel: string | null;
  gpuPerPod: number | null;
  // Profile-derived GPU facts, one entry per GPU-carrying role: how many cards
  // each pod requests, which accelerator model the role is pinned to, and how
  // many pods the role runs. model is null when the role accepts any of the
  // profile's declared models (a multi-model profile without a role-level pin).
  // replicas is the renderer's replica count and groupSize the LeaderWorkerSet
  // pods per replica (0 for a Deployment, whose replica is one pod), so
  // cards × groupSize × replicas is that role's whole footprint; the list's GPU
  // resource column sums these roles.
  gpuRoles: Array<{ name: string; gpuPerPod: number; model: string | null; replicas: number; groupSize: number }>;
  modelName: string | null;
  modelVersion: string | null;
  // override knobs declared by the profile, with the effective value (the
  // service's spec.overrides value, falling back to the profile default);
  // drives the replicas column and the scale panel
  overrideNums: Record<string, number>;
  overrides: Array<{
    name: string;
    type: "integer" | "string" | "stringList" | "boolean";
    min: number | null;
    max: number | null;
    enum: Array<number | string> | null;
    current: number | string | string[] | boolean | null;
    // the profile's declared default, which current falls back to; an empty
    // string here is a declared value ("off"), not a missing one
    default: number | string | string[] | boolean | null;
  }>;
  // observed state (phase is null until the controller reports it)
  phase: string | null;
  phaseReason: string | null;
  conditions: Array<{
    type: string;
    status: string;
    reason: string;
    message: string;
    transitionTime: string | null;
  }>;
  roles: Array<{
    name: string;
    kind: string;
    desired: number;
    ready: number;
    groupSize: number | null;
  }>;
  internalEndpoint: string | null;
  publicEndpoint: string | null;
  /**
   * The private catalog Gateway's in-cluster Service address, discovered from
   * the cluster's dataplane Services; null when no private Gateway is found.
   * Only meaningful for a service published to the private route (it has no
   * public listener), whose detail card shows this as its AI Gateway endpoint.
   */
  privateGatewayEndpoint: string | null;
  /**
   * Best-effort engine metrics; null when Prometheus has none. `p95` is in
   * milliseconds (the engine histogram itself is in seconds).
   */
  metrics: { qps: number | null; p95: number | null; tps: number | null; spark: number[] | null } | null;
}

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}
interface RoleStatus {
  name?: string;
  kind?: string;
  replicas?: number;
  readyReplicas?: number;
  groupSize?: number | null;
}
interface IsvcSpec {
  modelRef?: string;
  profileRef?: string;
  overrides?: Record<string, unknown>;
  route?: {
    aigatewayRouter?: string;
    modelName?: string;
    timeoutSeconds?: number;
    idleTimeoutSeconds?: number;
  };
}
interface IsvcStatus {
  phase?: { name?: string; reason?: string };
  conditions?: Condition[];
  roles?: RoleStatus[];
  model?: { name?: string; version?: string };
  endpoint?: { internal?: string; public?: string };
}
interface Isvc {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  spec?: IsvcSpec;
  status?: IsvcStatus;
}
interface ProfileOverride {
  name?: string;
  type?: string;
  min?: number;
  max?: number;
  enum?: Array<number | string>;
  default?: number | string | boolean;
}
interface ProfileRole {
  name?: string;
  // replicas and group.size are int-or-string: the renderer resolves templates
  // such as `{{ overrides.decodeReplicas }}` / `{{ overrides.groupSize }}` to
  // the role's replica count and its LeaderWorkerSet pods per replica, and
  // defaults an absent replicas field to 1.
  workload?: { kind?: string; replicas?: number | string; group?: { size?: number | string } };
  // Effective accelerator (design §3.2): the role's own declaration replaces
  // the profile-level one wholesale.
  accelerator?: { vendor?: string; models?: string[] };
  podTemplate?: {
    nodeSelector?: Record<string, string>;
    // int-or-string: a profile may template the count from an override (the
    // tensor-parallel size), which the renderer resolves to a concrete Int.
    resources?: { gpuPerPod?: number | string };
  };
}
interface ProfileSpec {
  engine?: { name?: string; version?: string };
  accelerator?: { vendor?: string; models?: string[] };
  modelRequirements?: { architectures?: string[]; quantization?: string[] };
  overrides?: ProfileOverride[];
  roles?: ProfileRole[];
}
interface Profile {
  metadata?: { name?: string };
  spec?: ProfileSpec;
}

/**
 * Vendor product node labels, matching the renderer: the role's pod template
 * pins the accelerator model through this label, either literally or through
 * an override reference.
 */
const VENDOR_PRODUCT_LABEL: Record<string, string> = {
  metax: "metax-tech.com/gpu.product",
  nvidia: "nvidia.com/gpu.product",
};

/** A pod template node-selector value that is exactly one override reference. */
const OVERRIDE_REF = /^\{\{\s*overrides\.([A-Za-z0-9_]+)\s*\}\}$/;

/**
 * The accelerator model a GPU role is pinned to: the role's pod-template node
 * selector on the effective vendor's product label, with an override reference
 * resolved to the service's effective value. Falls back to the role's single
 * effective declared model; a multi-model accelerator without a role-level pin
 * leaves the role free to land on any declared model (null), matching the
 * renderer's nodeAffinity.
 */
function roleGpuModel(
  role: ProfileRole,
  profile: Profile,
  effective: Map<string, string | number | boolean | null>,
): string | null {
  const accel = role.accelerator ?? profile.spec?.accelerator;
  const label = VENDOR_PRODUCT_LABEL[accel?.vendor ?? ""];
  const value = label ? role.podTemplate?.nodeSelector?.[label]?.trim() : undefined;
  if (value) {
    const ref = OVERRIDE_REF.exec(value);
    if (!ref) return value;
    const resolved = effective.get(ref[1]);
    if (typeof resolved === "string" && resolved !== "") return resolved;
  }
  const models = accel?.models ?? [];
  return models.length === 1 ? models[0] : null;
}

/**
 * The number of cards a GPU role's pod requests. gpuPerPod is int-or-string:
 * a profile may write `{{ overrides.tpSize }}` so a pod is granted as many
 * GPUs as the engine shards the model across, and the renderer resolves that
 * template before creating the workload. Resolve the same reference here so
 * the page shows the effective count instead of dropping the role.
 */
function roleGpuPerPod(
  role: ProfileRole,
  effective: Map<string, string | number | boolean | null>,
): number | null {
  const raw = role.podTemplate?.resources?.gpuPerPod;
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const ref = OVERRIDE_REF.exec(raw.trim());
  const resolved = ref ? effective.get(ref[1]) : raw.trim();
  if (typeof resolved !== "string" && typeof resolved !== "number") return null;
  const n = Number(resolved);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * An int-or-string count the renderer resolves from an override template, or
 * null when the field is absent (or names something no integer can resolve).
 */
function resolvedCount(
  raw: number | string | undefined,
  effective: Map<string, string | number | boolean | null>,
): number | null {
  if (raw === undefined) return null;
  const ref = typeof raw === "string" ? OVERRIDE_REF.exec(raw.trim()) : null;
  const resolved = ref ? effective.get(ref[1]) : raw;
  const n = typeof resolved === "number" ? resolved : typeof resolved === "string" ? Number(resolved.trim()) : NaN;
  return Number.isInteger(n) ? n : null;
}

/**
 * The number of replicas a role runs. Mirrors the renderer's resolveReplicas:
 * an absent field defaults to 1, and a templated field resolves against the
 * service's effective overrides. A template that does not resolve fails the
 * role in the renderer, so a service that renders at all has a concrete count;
 * 1 keeps the footprint finite here rather than dropping the role's GPU facts.
 */
function roleReplicas(
  role: ProfileRole,
  effective: Map<string, string | number | boolean | null>,
): number {
  const n = resolvedCount(role.workload?.replicas, effective);
  return n !== null && n >= 0 ? n : 1;
}

/**
 * The number of pods one replica runs: the LeaderWorkerSet group size, which
 * the renderer leaves at 0 for a Deployment (a replica there is one pod). Every
 * pod in the group requests the role's gpuPerPod cards, so a replica's GPU
 * footprint is gpuPerPod × groupSize, and the service's is that × replicas.
 */
function roleGroupSize(
  role: ProfileRole,
  effective: Map<string, string | number | boolean | null>,
): number {
  if (role.workload?.kind !== "LeaderWorkerSet" || role.workload.group === undefined) return 0;
  const n = resolvedCount(role.workload.group.size, effective);
  return n !== null && n >= 0 ? n : 0;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A rejected request: a stable code, plus the values the sentence built from it
 * needs. The sentence itself lives in the portal's dictionaries (`inf.err.<code>`,
 * in all three locales), which is what the console renders — the route carries no
 * prose of its own, so nothing here can reach a user in the wrong language.
 */
export interface ValidationCode {
  code: string;
  params?: Record<string, string | number>;
}

/**
 * Validate a set of override values against a profile's declared parameters.
 * Returns the code of the first violation, or null when every key is declared and
 * in range. Shared by POST (create) and PATCH (scale) so both enforce the same
 * contract before touching the cluster.
 */
function overrideError(
  overrides: Record<string, unknown>,
  profile: Profile | undefined,
): ValidationCode | null {
  if (!profile) return null; // profile unresolvable; the operator re-validates
  const declared = new Map((profile.spec?.overrides ?? []).map((o) => [o.name ?? "", o]));
  for (const [key, value] of Object.entries(overrides)) {
    const o = declared.get(key);
    if (!o) return { code: "overrideUnknown", params: { key } };
    if (o.type === "stringList") {
      if (!Array.isArray(value) || !value.every((e) => typeof e === "string")) {
        return { code: "overrideNotStringList", params: { key } };
      }
      // The operator joins the list into text; a comma inside an entry would
      // silently become a separator there, so reject it here instead of
      // persisting a value the renderer later fails on.
      if (value.some((e) => e.includes(","))) {
        return { code: "overrideNotAllowed", params: { key } };
      }
      // A declared enum constrains every entry of the list.
      if (o.enum && value.some((e) => !o.enum!.some((allowed) => allowed === e))) {
        return { code: "overrideNotAllowed", params: { key } };
      }
      continue;
    }
    const kind = { integer: 1, string: 2, boolean: 3 }[o.type ?? "integer"] ?? 1;
    if (kind === 1 && !Number.isInteger(value)) return { code: "overrideNotInteger", params: { key } };
    if (o.enum && !o.enum.some((e) => e === value)) return { code: "overrideNotAllowed", params: { key } };
    if (kind === 1 && typeof value === "number") {
      if (o.min !== undefined && value < o.min) return { code: "overrideBelowMin", params: { key, min: o.min } };
      if (o.max !== undefined && value > o.max) return { code: "overrideAboveMax", params: { key, max: o.max } };
    }
  }
  return null;
}

/** RFC 6901 JSON Pointer escape for an object key used in a patch path. */
function jsonPointerEscape(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Project one InferenceService + its resolved profile into a page-ready record. */
function project(
  isvc: Isvc,
  profile: Profile | undefined,
  metrics: NonNullable<InferenceServiceSummary["metrics"]> | null,
  privateGatewayEndpoint: string | null,
): InferenceServiceSummary {
  const spec = isvc.spec ?? {};
  const status = isvc.status ?? {};

  const overrideNums: Record<string, number> = {};
  for (const [k, v] of Object.entries(spec.overrides ?? {})) {
    const n = num(v);
    if (n !== null) overrideNums[k] = n;
  }

  // Effective value of every knob the profile declares: the service's user
  // value wins, else the profile default, else null. Drives the page's
  // replicas column and scale panel, so no knob name is hardcoded.
  const isPrim = (v: unknown): v is number | string | string[] | boolean =>
    typeof v === "number" ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (Array.isArray(v) && v.every((e) => typeof e === "string"));
  const specOverrides = spec.overrides ?? {};
  const overrides = (profile?.spec?.overrides ?? []).map((o) => {
    const name = o.name ?? "";
    const raw = specOverrides[name];
    const current = isPrim(raw) ? raw : (isPrim(o.default) ? o.default : null);
    return {
      name,
      type: (o.type === "string" || o.type === "stringList" || o.type === "boolean" ? o.type : "integer") as
        | "integer"
        | "string"
        | "stringList"
        | "boolean",
      min: num(o.min),
      max: num(o.max),
      enum: o.enum ?? null,
      current,
      default: isPrim(o.default) ? o.default : null,
    };
  });

  const roles: InferenceServiceSummary["roles"] = (status.roles ?? []).map((r) => ({
    name: r.name ?? "?",
    kind: r.kind ?? "?",
    desired: r.replicas ?? 0,
    ready: r.readyReplicas ?? 0,
    groupSize: r.groupSize ?? null,
  }));

  // GPU roles are profile-derived, not status-derived: the list shows the
  // service's GPU footprint before the controller has written any status.
  // Only scalar knobs can name a GPU model, so stringList values are skipped.
  const effective = new Map<string, string | number | boolean | null>(
    overrides
      .filter((o) => !Array.isArray(o.current))
      .map((o) => [o.name, o.current as string | number | boolean | null]),
  );
  const gpuRoles: InferenceServiceSummary["gpuRoles"] = profile
    ? (profile.spec?.roles ?? [])
        .map((r) => ({ role: r, gpuPerPod: roleGpuPerPod(r, effective) }))
        .filter((entry): entry is { role: ProfileRole; gpuPerPod: number } => entry.gpuPerPod !== null)
        .map(({ role, gpuPerPod }) => ({
          name: role.name ?? "?",
          gpuPerPod,
          model: roleGpuModel(role, profile, effective),
          replicas: roleReplicas(role, effective),
          groupSize: roleGroupSize(role, effective),
        }))
    : [];
  // The single-model fields stay as a compact summary: every concrete model a
  // GPU role pins (joined when the roles were narrowed differently), else the
  // first declared model when no role pins one.
  const gpuModels = [...new Set(gpuRoles.map((r) => r.model).filter((m): m is string => m !== null))];

  return {
    name: isvc.metadata?.name ?? "?",
    namespace: isvc.metadata?.namespace ?? "",
    profileRef: spec.profileRef ?? "—",
    modelRef: spec.modelRef ?? "—",
    published: (spec.route?.aigatewayRouter ?? "") !== "",
    aigatewayRouter: spec.route?.aigatewayRouter ?? null,
    routeModelName: spec.route?.modelName ?? null,
    timeoutSeconds: spec.route?.timeoutSeconds ?? null,
    idleTimeoutSeconds: spec.route?.idleTimeoutSeconds ?? null,
    createdAt: isvc.metadata?.creationTimestamp ?? null,
    engine: profile?.spec?.engine?.name ?? null,
    engineVersion: profile?.spec?.engine?.version ?? null,
    vendor: profile?.spec?.accelerator?.vendor ?? null,
    gpuModel: gpuModels.length > 0 ? gpuModels.join(" / ") : (profile?.spec?.accelerator?.models?.[0] ?? null),
    gpuPerPod: gpuRoles[0]?.gpuPerPod ?? null,
    gpuRoles,
    modelName: status.model?.name ?? null,
    modelVersion: status.model?.version ?? null,
    overrideNums,
    overrides,
    phase: status.phase?.name ?? null,
    phaseReason: status.phase?.reason ?? null,
    conditions: (status.conditions ?? []).map((c) => ({
      type: c.type ?? "?",
      status: c.status ?? "Unknown",
      reason: c.reason ?? "",
      message: c.message ?? "",
      transitionTime: c.lastTransitionTime ?? null,
    })),
    roles,
    internalEndpoint: status.endpoint?.internal ?? null,
    publicEndpoint: status.endpoint?.public ?? null,
    privateGatewayEndpoint,
    metrics,
  };
}

/**
 * GET /api/inferenceservices
 *
 * Lists every InferenceService in the cluster (any namespace), each resolved
 * against its InferenceRuntimeProfile. Metrics are best-effort Prometheus
 * queries and never fail the response.
 */
export const GET = withAuth(async () => {
  try {
    const co = getCustomObjectsClient();
    const [isvcRes, profileRes] = await Promise.all([
      co.listClusterCustomObject({
        group: GROUP,
        version: VERSION,
        plural: PLURAL_ISVC,
      }),
      co.listClusterCustomObject({
        group: GROUP,
        version: VERSION,
        plural: PLURAL_PROFILE,
      }),
    ]);

    const isvcs: Isvc[] = isvcRes.items ?? [];
    const profiles: Profile[] = profileRes.items ?? [];
    const byProfile = new Map(profiles.map((p) => [p.metadata?.name ?? "", p]));

    // Best-effort, per-service metrics in parallel; a failure (or a stalled
    // backend, which now times out) degrades that service to `metrics: null`
    // (the page then shows its empty state).
    const [privateGatewayEndpoint, metrics] = await Promise.all([
      // The private catalog's address is a cluster fact, resolved once per
      // response (discovery is memoized in the gateway client).
      privateGatewayClusterEndpoint(),
      Promise.all(
        isvcs.map((isvc) => {
          const profile = byProfile.get(isvc.spec?.profileRef ?? "");
          return loadMetrics(
            isvc.metadata?.namespace ?? "",
            isvc.metadata?.name ?? "",
            profile?.spec?.engine?.name,
          ).catch(() => null);
        }),
      ),
    ]);

    const items = isvcs.map((isvc, i) =>
      project(isvc, byProfile.get(isvc.spec?.profileRef ?? ""), metrics[i], privateGatewayEndpoint),
    );
    // Newest first, mirroring the prototype's ordering by freshness.
    items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    return Response.json({ items });
  } catch (err) {
    console.error("Failed to list inference services:", err);
    return Response.json({ error: "Failed to load inference services" }, { status: 500 });
  }
});

/**
 * PATCH /api/inferenceservices
 *
 * Updates the `spec.overrides` of one service via an RFC 6902 JSON Patch. Body:
 * `{ namespace, name, overrides: Record<string, number|string|boolean> }`. Only
 * the keys present are touched; the values are resolved against the service's
 * InferenceRuntimeProfile and validated (same contract as POST) before the
 * cluster write. Requires RBAC to get and patch the CR.
 */
export const PATCH = withAuth(async (req) => {
  try {
    const body = (await req.json()) as { namespace?: string; name?: string; overrides?: Record<string, unknown> };
    if (!body.namespace || !body.name || !body.overrides) {
      return Response.json({ error: "namespace, name and overrides are required" }, { status: 400 });
    }
    // Only numeric/boolean/string override values and string lists are
    // meaningful; reject the rest so a bad payload cannot be persisted.
    for (const [k, v] of Object.entries(body.overrides)) {
      const isStringList = Array.isArray(v) && v.every((e) => typeof e === "string");
      if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean" && !isStringList) {
        return Response.json({ error: `override '${k}' must be a number, string, string list or boolean` }, { status: 400 });
      }
    }

    const co = getCustomObjectsClient();
    // Resolve the target service and its profile so the override values can be
    // validated against the profile's declared parameters (same contract as
    // POST) before touching the cluster.
    let profile: Profile | undefined;
    try {
      const [svc, profileRes] = await Promise.all([
        co.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: body.namespace,
          plural: PLURAL_ISVC,
          name: body.name,
        }),
        co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL_PROFILE }),
      ]);
      const profileRef = (svc as { spec?: { profileRef?: string } })?.spec?.profileRef;
      const profiles = (profileRes.items ?? []) as Profile[];
      profile = profileRef ? profiles.find((p) => p.metadata?.name === profileRef) : undefined;
    } catch (err) {
      console.error("Failed to resolve inference service for validation:", err);
      const sc = (err as { statusCode?: number })?.statusCode;
      if (sc === 404) {
        return Response.json({ error: "nameMissing", params: { name: body.name } }, { status: 404 });
      }
      return Response.json({ error: "Failed to update inference service" }, { status: 500 });
    }
    const oerr = overrideError(body.overrides, profile);
    if (oerr) return Response.json({ error: oerr.code, params: oerr.params }, { status: 400 });

    // The generated CustomObjectsApi patches custom objects with an RFC 6902
    // JSON Patch (application/json-patch+json). `add` replaces the value of an
    // existing member, and inserts it when absent — so it covers both keys the
    // spec already carries (decodeReplicas) and keys not yet present
    // (groupSize). RFC 6901-escape each key (~ -> ~0, / -> ~1) so a key that
    // contains those characters targets the intended member.
    const patch = Object.entries(body.overrides).map(([k, v]) => ({
      op: "add",
      path: `/spec/overrides/${jsonPointerEscape(k)}`,
      value: v,
    }));
    await co.patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_ISVC,
      name: body.name,
      body: patch,
      fieldManager: "cubestack-web",
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("Failed to patch inference service:", err);
    const status =
      (err as { statusCode?: number })?.statusCode === 403
        ? { error: "无权限修改推理服务(需要 patch 权限)", status: 403 }
        : { error: "Failed to update inference service", status: 500 };
    return Response.json(status, { status: status.status });
  }
});

// ── create (POST) ────────────────────────────────────────────────────────────

const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

// route.modelName is the platform-wide catalog model name (operator CRD
// pattern), not a hostname label: the shared catalog hostname carries every
// published model, selected by the request body's `model` field.
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;

interface CreateBody {
  namespace?: string;
  name?: string;
  profileRef?: string;
  modelRef?: string;
  overrides?: Record<string, number | string | boolean>;
  route?: {
    aigatewayRouter?: string;
    modelName?: string;
    paths?: string[];
  };
}
interface ModelVersionRef {
  metadata?: { name?: string };
  spec?: { architecture?: string; quantization?: string };
}

/**
 * POST /api/inferenceservices
 *
 * Creates an InferenceService. Two layers of validation:
 *  - a structural pass here (name/namespace/profile/model existence,
 *    model↔profile compatibility, override types/bounds) so a bad request is
 *    rejected before touching the cluster;
 *  - the operator controller/verifying-admission re-validates on reconcile.
 * Requires RBAC to create the CR in the target namespace.
 */
export const POST = withAuth(async (req) => {
  try {
    const body = (await req.json()) as CreateBody;
    const ValidationError = (code: string, params?: Record<string, string | number>) =>
      Response.json({ error: code, params }, { status: 400 });

    if (!body.name || !DNS_LABEL_RE.test(body.name)) {
      return ValidationError("nameInvalid");
    }
    if (!body.namespace || !body.profileRef || !body.modelRef) {
      return ValidationError("refsRequired");
    }

    const core = getCoreClient();
    const co = getCustomObjectsClient();

    const [nsRes, profileRes, mvRes, isvcRes] = await Promise.all([
      core.listNamespace(),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL_PROFILE }),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "modelversions" }),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL_ISVC }),
    ]);

    const nsNames = new Set((nsRes.items ?? []).map((ns) => ns.metadata?.name));
    if (!nsNames.has(body.namespace)) {
      return ValidationError("namespaceMissing", { namespace: body.namespace });
    }

    const profiles: Profile[] = profileRes.items ?? [];
    const profile = profiles.find((p) => p.metadata?.name === body.profileRef);
    if (!profile) return ValidationError("profileMissing", { profile: body.profileRef });

    const models: ModelVersionRef[] = mvRes.items ?? [];
    const model = models.find((m) => m.metadata?.name === body.modelRef);
    if (!model) return ValidationError("modelMissing", { model: body.modelRef });

    // Model↔profile compatibility: architecture + quantization must be allowed.
    const reqs = profile.spec?.modelRequirements;
    if (reqs && ((reqs.architectures?.length && !reqs.architectures.includes(model.spec?.architecture ?? "")) || (reqs.quantization?.length && !reqs.quantization.includes(model.spec?.quantization ?? "")))) {
      return ValidationError("modelProfileIncompatible", { model: body.modelRef, profile: body.profileRef });
    }

    // Unique name in the namespace.
    const exists = (isvcRes.items ?? []).some(
      (s: Isvc) => s.metadata?.namespace === body.namespace && s.metadata?.name === body.name,
    );
    if (exists) return ValidationError("nameTaken", { name: body.name });

    // Overrides must satisfy the profile's declared parameters (shared with PATCH).
    const oerr = overrideError(body.overrides ?? {}, profile);
    if (oerr) return ValidationError(oerr.code, oerr.params);

    // Route: a non-empty aigatewayRouter publishes the service into the model
    // catalog attached to that pre-installed AIGatewayRoute, which requires a
    // valid catalog model name and at least one exposed path. An absent router
    // leaves the service unpublished; the CRD supplies the timeout defaults.
    let route: { aigatewayRouter: string; modelName: string; paths: CatalogPath[] } | undefined;
    const router = body.route?.aigatewayRouter;
    if (router !== undefined && router !== "") {
      if (!isAIGatewayRouter(router)) {
        return ValidationError("aigatewayRouterInvalid");
      }
      const modelName = body.route?.modelName;
      if (!modelName || !MODEL_NAME_RE.test(modelName)) {
        return ValidationError("routeModelNameInvalid");
      }
      const paths = body.route?.paths;
      // Untrusted JSON: the CreateBody type does not survive the wire, so a
      // null or a bare string must be refused here instead of throwing into
      // the 500 handler.
      if (!Array.isArray(paths) || !paths.every(isCatalogPath)) {
        return ValidationError("routePathsInvalid");
      }
      if (paths.length === 0) {
        return ValidationError("routePathsRequired");
      }
      // The CRD list is a set: dedupe instead of rejecting a repeated path.
      const unique = CATALOG_PATHS.filter((p) => paths.includes(p));
      route = { aigatewayRouter: router, modelName, paths: unique };
    }

    const cr = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "InferenceService",
      metadata: { name: body.name, namespace: body.namespace },
      spec: {
        modelRef: body.modelRef,
        profileRef: body.profileRef,
        overrides: body.overrides ?? {},
        ...(route ? { route } : {}),
      },
    };

    await co.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_ISVC,
      body: cr,
    });
    return Response.json({ created: true, name: body.name }, { status: 201 });
  } catch (err) {
    console.error("Failed to create inference service:", err);
    return Response.json({ error: "Failed to create inference service" }, { status: 500 });
  }
});

// ── best-effort per-service metrics from Prometheus ─────────────────────

const SPARK_POINTS = 12;
const SPARK_STEP_SECONDS = 150; // 12 points x 150s = a 30-minute window

// Bound each Prometheus request so a stalled backend degrades that service to
// metrics:null instead of hanging the whole list response (best-effort).
const PROMETHEUS_TIMEOUT_MS = 3_000;

/**
 * Per-service label matcher for the engine exporters. The operator namespaces
 * the engine pods and generates `<inference-service>-<role>` services, so scope
 * to the service's namespace plus an anchored name-or-role-suffix match on the
 * `service` label — a bare prefix would also capture sibling services whose
 * name merely starts with this one (e.g. `llm2-router` for `llm`). Best-effort:
 * if the exporter is absent (or uses different labels) the match yields no
 * samples and the service shows its empty state — never another service's or
 * the cluster's aggregate.
 */
function serviceMatcher(namespace: string, name: string): string {
  return `namespace="${namespace}",service=~"^${name}(-.*)?$"`;
}

/**
 * The engine exporters name their families per engine, so each is addressed
 * explicitly instead of through one regex spanning both. vLLM counts finished
 * requests in `vllm:request_success_total`, SGLang in `sglang:num_requests_total`;
 * both expose generated tokens as `<engine>:generation_tokens_total`, and the
 * end-to-end request latency as a histogram in `<engine>:e2e_request_latency_seconds`.
 * A loose `.*latency.*bucket` matcher also catches vLLM's per-token
 * `vllm:inter_token_latency_seconds_bucket`, which makes Prometheus reject the
 * whole query ("vector cannot contain metrics with the same labelset").
 */
const ENGINE_FAMILIES: Record<string, { requests: string; tokens: string; latency: string }> = {
  vllm: {
    requests: "vllm:request_success_total",
    tokens: "vllm:generation_tokens_total",
    latency: "vllm:e2e_request_latency_seconds_bucket",
  },
  sglang: {
    requests: "sglang:num_requests_total",
    tokens: "sglang:generation_tokens_total",
    latency: "sglang:e2e_request_latency_seconds_bucket",
  },
};

/**
 * Standard selectors for the engine exporter of one inference service, one
 * family per query. Without a live exporter the queries return nothing and the
 * service shows its empty state.
 */
const qpsQuery = (engine: string, ns: string, name: string) =>
  `sum(rate(${ENGINE_FAMILIES[engine].requests}{${serviceMatcher(ns, name)}}[5m]))`;
const p95Query = (engine: string, ns: string, name: string) =>
  `histogram_quantile(0.95, sum(rate(${ENGINE_FAMILIES[engine].latency}{${serviceMatcher(ns, name)}}[5m])) by (le))`;
const tpsQuery = (engine: string, ns: string, name: string) =>
  `sum(rate(${ENGINE_FAMILIES[engine].tokens}{${serviceMatcher(ns, name)}}[5m]))`;

async function loadMetrics(
  namespace: string,
  name: string,
  engine: string | null | undefined,
): Promise<NonNullable<InferenceServiceSummary["metrics"]> | null> {
  // An engine we have no families for (or a service whose profile does not
  // resolve) has nothing to query: the service shows its empty state rather
  // than another engine's numbers.
  const key = engine?.toLowerCase() ?? "";
  if (!ENGINE_FAMILIES[key]) return null;
  const now = Math.floor(Date.now() / 1000);
  const start = now - SPARK_POINTS * SPARK_STEP_SECONDS;
  const [qps, p95Seconds, tps, spark] = await Promise.all([
    queryInstant(qpsQuery(key, namespace, name)),
    queryInstant(p95Query(key, namespace, name)),
    queryInstant(tpsQuery(key, namespace, name)),
    queryRange(qpsQuery(key, namespace, name), start, now, SPARK_STEP_SECONDS, SPARK_POINTS),
  ]);
  // Without a single sample across any family we treat it as "no data".
  if (qps === null && p95Seconds === null && tps === null && !spark) return null;
  // The latency histogram is in seconds; the console renders milliseconds.
  return { qps, p95: p95Seconds === null ? null : p95Seconds * 1000, tps, spark };
}

async function queryInstant(query: string): Promise<number | null> {
  const params = new URLSearchParams({ query });
  const url = `${PERSES_SERVER_URL}/proxy/globaldatasources/${PROMETHEUS_DATASOURCE}/api/v1/query?${params}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(PROMETHEUS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Prometheus query failed (${res.status})`);
  const body = (await res.json()) as {
    data?: { result?: Array<{ value?: [number, string] | string }> };
  };
  const sample = body.data?.result?.[0]?.value;
  if (!Array.isArray(sample) || sample.length < 2) return null;
  const n = Number(sample[1] as string);
  return Number.isFinite(n) ? n : null;
}

async function queryRange(
  query: string,
  start: number,
  end: number,
  step: number,
  points: number,
): Promise<number[] | null> {
  const params = new URLSearchParams({
    query,
    start: String(start),
    end: String(end),
    step: String(step),
  });
  const url = `${PERSES_SERVER_URL}/proxy/globaldatasources/${PROMETHEUS_DATASOURCE}/api/v1/query_range?${params}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(PROMETHEUS_TIMEOUT_MS) });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    data?: { result?: Array<{ values?: Array<[number, string]> }> };
  };
  const values = body.data?.result?.[0]?.values;
  if (!values || values.length === 0) return null;
  const out = new Array<number>(points).fill(NaN);
  for (const [ts, value] of values) {
    const i = Math.round((Number(ts) - start) / step);
    if (i >= 0 && i < points) out[i] = Number(value);
  }
  let prev = 0;
  for (let i = 0; i < points; i++) {
    if (Number.isNaN(out[i])) out[i] = prev;
    else prev = out[i];
  }
  return out;
}

// ── delete (DELETE) ──────────────────────────────────────────────────────────

export const DELETE = withAuth(async (req) => {
  // Held outside the try so the 404 below can name the object it could not find:
  // the sentence the console renders is built from it.
  let name = "";
  try {
    const body = (await req.json()) as { namespace?: string; name?: string };
    name = body.name ?? "";
    if (!body.namespace || !body.name) {
      return Response.json({ error: "namespace and name are required" }, { status: 400 });
    }
    const co = getCustomObjectsClient();
    await co.deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.namespace,
      plural: PLURAL_ISVC,
      name: body.name,
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete inference service:", err);
    const status =
      (err as { statusCode?: number })?.statusCode === 404
        ? // The object was already gone. A code like the 400s, so the console can
          // say it in the user's language instead of a Chinese literal.
          { error: "nameMissing", params: { name }, status: 404 }
        : { error: "Failed to delete inference service", status: 500 };
    return Response.json(status, { status: status.status });
  }
});
