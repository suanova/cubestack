import type { NextRequest } from "next/server";

import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";

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
  routeModelName: string | null;
  timeoutSeconds: number | null;
  createdAt: string | null;
  // resolved profile facts
  engine: string | null;
  engineVersion: string | null;
  vendor: string | null;
  gpuModel: string | null;
  gpuPerPod: number | null;
  modelName: string | null;
  modelVersion: string | null;
  // override knobs surfaced in the scale panel
  overrideNums: Record<string, number>;
  decode: { current: number; min: number; max: number };
  prefill: { current: number; min: number; max: number };
  groupSize: { current: number; enum: number[] | null };
  // observed state (null until the controller reports it)
  ready: boolean | null;
  progressing: boolean;
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
  /** Best-effort engine metrics; null when Prometheus has none. */
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
    publish?: boolean;
    modelName?: string;
    timeoutSeconds?: number;
  };
}
interface IsvcStatus {
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
  default?: number | string;
}
interface ProfileRole {
  name?: string;
  workload?: { kind?: string };
  podTemplate?: { resources?: { gpuPerPod?: number } };
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
 * The serving role of a profile is the one that actually carries GPUs (the
 * prefill/decode LWS roles here). It is the source of gpuPerPod and the replica
 * overrides the scale panel edits.
 */
function findGpuRole(profile: Profile | undefined): ProfileRole | null {
  for (const role of profile?.spec?.roles ?? []) {
    if ((role.podTemplate?.resources?.gpuPerPod ?? 0) > 0) return role;
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function condTrue(conds: Condition[] | undefined, type: string): boolean | null {
  const c = conds?.find((x) => x.type === type);
  return c ? c.status === "True" : null;
}

function profileOverride(profile: Profile | undefined, name: string): ProfileOverride {
  return profile?.spec?.overrides?.find((o) => o.name === name) ?? {};
}

/**
 * Validate a set of override values against a profile's declared parameters.
 * Returns an error message, or null when every key is declared and in range.
 * Shared by POST (create) and PATCH (scale) so both enforce the same contract
 * before touching the cluster.
 */
function overrideError(
  overrides: Record<string, unknown>,
  profile: Profile | undefined,
): string | null {
  if (!profile) return null; // profile unresolvable; the operator re-validates
  const declared = new Map((profile.spec?.overrides ?? []).map((o) => [o.name ?? "", o]));
  for (const [key, value] of Object.entries(overrides)) {
    const o = declared.get(key);
    if (!o) return `不认识的 override '${key}'。`;
    const kind = { integer: 1, string: 2, boolean: 3 }[o.type ?? "integer"] ?? 1;
    if (kind === 1 && !Number.isInteger(value)) return `override '${key}' 需要整数。`;
    if (o.enum && !o.enum.some((e) => e === value)) return `override '${key}' 取值不在允许集合内。`;
    if (kind === 1 && typeof value === "number") {
      if (o.min !== undefined && value < o.min) return `override '${key}' 小于最小值 ${o.min}。`;
      if (o.max !== undefined && value > o.max) return `override '${key}' 大于最大值 ${o.max}。`;
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
): InferenceServiceSummary {
  const spec = isvc.spec ?? {};
  const status = isvc.status ?? {};
  const gpuRole = findGpuRole(profile);

  const decode = profileOverride(profile, "decodeReplicas");
  const prefill = profileOverride(profile, "prefillReplicas");
  const group = profileOverride(profile, "groupSize");
  const overrideNums: Record<string, number> = {};
  for (const [k, v] of Object.entries(spec.overrides ?? {})) {
    const n = num(v);
    if (n !== null) overrideNums[k] = n;
  }

  const numOverride = (name: string, fallback: number | null): number => {
    const v = overrideNums[name] ?? num(profileOverride(profile, name).default);
    return v ?? fallback ?? 0;
  };

  const roles: InferenceServiceSummary["roles"] = (status.roles ?? []).map((r) => ({
    name: r.name ?? "?",
    kind: r.kind ?? "?",
    desired: r.replicas ?? 0,
    ready: r.readyReplicas ?? 0,
    groupSize: r.groupSize ?? null,
  }));

  return {
    name: isvc.metadata?.name ?? "?",
    namespace: isvc.metadata?.namespace ?? "",
    profileRef: spec.profileRef ?? "—",
    modelRef: spec.modelRef ?? "—",
    published: spec.route?.publish ?? false,
    routeModelName: spec.route?.modelName ?? null,
    timeoutSeconds: spec.route?.timeoutSeconds ?? null,
    createdAt: isvc.metadata?.creationTimestamp ?? null,
    engine: profile?.spec?.engine?.name ?? null,
    engineVersion: profile?.spec?.engine?.version ?? null,
    vendor: profile?.spec?.accelerator?.vendor ?? null,
    gpuModel: profile?.spec?.accelerator?.models?.[0] ?? null,
    gpuPerPod: gpuRole?.podTemplate?.resources?.gpuPerPod ?? null,
    modelName: status.model?.name ?? null,
    modelVersion: status.model?.version ?? null,
    overrideNums,
    decode: {
      current: numOverride("decodeReplicas", 1),
      min: num(decode.min) ?? 1,
      max: num(decode.max) ?? 1,
    },
    prefill: {
      current: numOverride("prefillReplicas", 1),
      min: num(prefill.min) ?? 1,
      max: num(prefill.max) ?? 1,
    },
    groupSize: {
      current: numOverride("groupSize", 1),
      enum: group.enum?.map(Number).filter((n) => !Number.isNaN(n)) ?? null,
    },
    ready: condTrue(status.conditions, "Ready"),
    progressing: condTrue(status.conditions, "Progressing") === true,
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
export async function GET() {
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
    const metrics = await Promise.all(
      isvcs.map((isvc) =>
        loadMetrics(isvc.metadata?.namespace ?? "", isvc.metadata?.name ?? "").catch(() => null),
      ),
    );

    const items = isvcs.map((isvc, i) =>
      project(isvc, byProfile.get(isvc.spec?.profileRef ?? ""), metrics[i]),
    );
    // Newest first, mirroring the prototype's ordering by freshness.
    items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    return Response.json({ items });
  } catch (err) {
    console.error("Failed to list inference services:", err);
    return Response.json({ error: "Failed to load inference services" }, { status: 500 });
  }
}

/**
 * PATCH /api/inferenceservices
 *
 * Updates the `spec.overrides` of one service via an RFC 6902 JSON Patch. Body:
 * `{ namespace, name, overrides: Record<string, number|string|boolean> }`. Only
 * the keys present are touched; the values are resolved against the service's
 * InferenceRuntimeProfile and validated (same contract as POST) before the
 * cluster write. Requires RBAC to get and patch the CR.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { namespace?: string; name?: string; overrides?: Record<string, unknown> };
    if (!body.namespace || !body.name || !body.overrides) {
      return Response.json({ error: "namespace, name and overrides are required" }, { status: 400 });
    }
    // Only numeric/boolean/string override values are meaningful; reject the
    // rest so a bad payload cannot be persisted.
    for (const [k, v] of Object.entries(body.overrides)) {
      if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
        return Response.json({ error: `override '${k}' must be a number, string or boolean` }, { status: 400 });
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
        return Response.json({ error: `服务 '${body.name}' 不存在。` }, { status: 404 });
      }
      return Response.json({ error: "Failed to update inference service" }, { status: 500 });
    }
    const oerr = overrideError(body.overrides, profile);
    if (oerr) return Response.json({ error: oerr }, { status: 400 });

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
}

// ── create (POST) ────────────────────────────────────────────────────────────

const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

interface CreateBody {
  namespace?: string;
  name?: string;
  profileRef?: string;
  modelRef?: string;
  overrides?: Record<string, number | string | boolean>;
  route?: { publish?: boolean; modelName?: string; timeoutSeconds?: number };
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
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CreateBody;
    const ValidationError = (error: string) => Response.json({ error }, { status: 400 });

    if (!body.name || !DNS_LABEL_RE.test(body.name)) {
      return ValidationError("服务名称不合法:需小写字母/数字/中划线,DNS-1123 label。");
    }
    if (!body.namespace || !body.profileRef || !body.modelRef) {
      return ValidationError("namespace、profileRef、modelRef 均为必填。");
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
      return ValidationError(`namespace '${body.namespace}' 不存在。`);
    }

    const profiles: Profile[] = profileRes.items ?? [];
    const profile = profiles.find((p) => p.metadata?.name === body.profileRef);
    if (!profile) return ValidationError(`profile '${body.profileRef}' 不存在。`);

    const models: ModelVersionRef[] = mvRes.items ?? [];
    const model = models.find((m) => m.metadata?.name === body.modelRef);
    if (!model) return ValidationError(`model '${body.modelRef}' 不存在。`);

    // Model↔profile compatibility: architecture + quantization must be allowed.
    const reqs = profile.spec?.modelRequirements;
    if (reqs && ((reqs.architectures?.length && !reqs.architectures.includes(model.spec?.architecture ?? "")) || (reqs.quantization?.length && !reqs.quantization.includes(model.spec?.quantization ?? "")))) {
      return ValidationError(`模型 '${body.modelRef}' 与 profile '${body.profileRef}' 不兼容(架构/量化不匹配)。`);
    }

    // Unique name in the namespace.
    const exists = (isvcRes.items ?? []).some(
      (s: Isvc) => s.metadata?.namespace === body.namespace && s.metadata?.name === body.name,
    );
    if (exists) return ValidationError(`服务 '${body.name}' 已存在。`);

    // Overrides must satisfy the profile's declared parameters (shared with PATCH).
    const oerr = overrideError(body.overrides ?? {}, profile);
    if (oerr) return ValidationError(oerr);

    // Route: publishing requires a valid single DNS-label modelName.
    const timeout = body.route?.timeoutSeconds;
    if (timeout !== undefined && timeout !== null && (Number.isNaN(timeout) || timeout < 1 || timeout > 86400)) {
      return ValidationError("timeoutSeconds 需在 1–86400 之间。");
    }
    let route: { publish: boolean; modelName?: string; timeoutSeconds?: number };
    if (body.route?.publish) {
      const modelName = body.route?.modelName;
      if (!modelName || !DNS_LABEL_RE.test(modelName)) {
        return ValidationError("route.modelName 不合法:需单个 DNS label。");
      }
      route = { publish: true, modelName, timeoutSeconds: timeout ?? 60 };
    } else {
      route = { publish: false };
    }

    const cr = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "InferenceService",
      metadata: { name: body.name, namespace: body.namespace },
      spec: {
        modelRef: body.modelRef,
        profileRef: body.profileRef,
        overrides: body.overrides ?? {},
        route,
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
}

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
 * Standard selectors for the engine exporters (vLLM / SGLang) exposed through
 * Prometheus, scoped to one inference service. Without a live exporter the
 * queries return nothing and the service shows its empty state.
 */
const qpsQuery = (ns: string, name: string) =>
  `sum(rate({__name__=~"sglang:.*:num_generate_tokens_total|vllm:.*:requests_total",${serviceMatcher(ns, name)}}[5m]))`;
const p95Query = (ns: string, name: string) =>
  `histogram_quantile(0.95, sum(rate({__name__=~"sglang.*e2e_latency_seconds|vllm.*latency.*bucket",${serviceMatcher(ns, name)}}[5m])) by (le))`;
const tpsQuery = (ns: string, name: string) =>
  `sum(rate({__name__=~"sglang:.*:num_generate_tokens_total|vllm.*num_generated_tokens_total",${serviceMatcher(ns, name)}}[5m]))`;

async function loadMetrics(
  namespace: string,
  name: string,
): Promise<NonNullable<InferenceServiceSummary["metrics"]> | null> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - SPARK_POINTS * SPARK_STEP_SECONDS;
  const [qps, p95, tps, spark] = await Promise.all([
    queryInstant(qpsQuery(namespace, name)),
    queryInstant(p95Query(namespace, name)),
    queryInstant(tpsQuery(namespace, name)),
    queryRange(qpsQuery(namespace, name), start, now, SPARK_STEP_SECONDS, SPARK_POINTS),
  ]);
  // Without a single sample across any family we treat it as "no data".
  if (qps === null && p95 === null && tps === null && !spark) return null;
  return { qps, p95, tps, spark };
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