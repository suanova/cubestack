import type { V1Node } from "@kubernetes/client-node";

import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered at
// build time (Next 14 statically generates route handlers that don't use the
// request object; that would hang on the kubeconfig/cluster call).
export const dynamic = "force-dynamic";

// Operator CRD group/version (operator/api/v1alpha1/groupversion_info.go) and
// the plurals registered in operator/config/crd/bases/*.yaml.
const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";

// Prometheus is reached through the Perses datasource proxy (the same path
// the perses panels use); the datasource is provisioned in
// e2e/deploy/perses/provisioning/global-datasource.yaml.
const PERSES_SERVER_URL = process.env.PERSES_SERVER_URL ?? "http://localhost:8080";
const PROMETHEUS_DATASOURCE = "prometheus-datasource";

// The trend chart is a rolling 24h window with one point every 30 minutes
// (48 points), matching the prototype's chart density.
const TREND_POINTS = 48;
const TREND_STEP_SECONDS = 1800;

// Cluster-wide average GPU utilization / memory %, combined across the two
// exporter families (NVIDIA DCGM + MetaX). Each vendor is weighted by its
// series count (one series per GPU) and missing metrics degrade to 0. The
// metric names are the ones used by the provisioned dashboards and may need
// tuning against the actually deployed exporters.
const TREND_UTIL_QUERY = `((sum(DCGM_FI_DEV_GPU_UTIL) or vector(0)) + (sum(mx_gpu_usage) or vector(0))) / (((count(DCGM_FI_DEV_GPU_UTIL) or vector(0)) + (count(mx_gpu_usage) or vector(0))) or vector(1))`;
const TREND_MEM_QUERY = `(((sum(DCGM_FI_DEV_FB_USED) / sum(DCGM_FI_DEV_FB_TOTAL) * 100) or vector(0)) + (avg(mx_memory_usage) or vector(0))) / (((count(DCGM_FI_DEV_FB_TOTAL) > 0) or vector(0)) + ((count(mx_memory_usage) > 0) or vector(0)) or vector(1))`;

/** Live-cluster summary for the overview landing. */
export interface OverviewSummary {
  nodes: { total: number; ready: number; version: string | null };
  gpu: {
    vendors: number;
    totalCards: number;
    compute: number;
    inference: number;
    allocated: number;
    free: number;
  };
  inference: { total: number; ready: number; scaling: number };
  devenv: { total: number; running: number; stopped: number };
  /** null when Prometheus is unreachable or has no GPU metrics. */
  trend: { util: number[]; mem: number[] } | null;
}

// Minimal structural views of the operator CRs. listClusterCustomObject
// returns `any`, so the shapes are declared locally from the Go types
// (operator/api/v1alpha1).
interface K8sCondition {
  type?: string;
  status?: string;
}
interface InferenceService {
  spec?: { profileRef?: string };
  status?: {
    conditions?: K8sCondition[];
    roles?: {
      name?: string;
      replicas?: number;
      groupSize?: number | null;
    }[];
  };
}
interface DevEnvironment {
  spec?: { resources?: { gpuCount?: number } };
  status?: { phase?: { name?: string } };
}
interface RuntimeProfile {
  metadata?: { name?: string };
  spec?: {
    roles?: {
      name?: string;
      podTemplate?: { resources?: { gpuPerPod?: number } };
    }[];
  };
}

/**
 * The vendor prefix of a GPU extended resource, or null if `resourceName` is
 * not a GPU resource. A GPU resource is a `<domain>/gpu` name (e.g.
 * nvidia.com/gpu, metax-tech.com/gpu) — the operator maps each GPU vendor to
 * exactly that pattern (operator/api/v1alpha1). Distinct prefixes count as
 * distinct vendors.
 */
function gpuVendor(resourceName: string): string | null {
  const slash = resourceName.lastIndexOf("/");
  if (slash === -1) return resourceName === "gpu" ? "gpu" : null;
  return resourceName.slice(slash + 1) === "gpu"
    ? resourceName.slice(0, slash)
    : null;
}

function conditionTrue(conditions: K8sCondition[] | undefined, type: string): boolean {
  return conditions?.some((c) => c.type === type && c.status === "True") ?? false;
}

/**
 * Total GPU capacity and the set of GPU vendors across the cluster. capacity
 * is the physical truth; allocatable is what scheduling sees, so a vendor
 * present in either counts.
 */
function gpuCapacity(nodes: V1Node[]): { totalCards: number; vendors: Set<string> } {
  const vendors = new Set<string>();
  let totalCards = 0;
  for (const node of nodes) {
    const resources = {
      ...(node.status?.allocatable ?? {}),
      ...(node.status?.capacity ?? {}),
    };
    for (const [name, value] of Object.entries(resources)) {
      const vendor = gpuVendor(name);
      if (!vendor) continue;
      vendors.add(vendor);
      totalCards += parseInt(String(value), 10) || 0;
    }
  }
  return { totalCards, vendors };
}

/** The cluster's major.minor Kubernetes version, from the first node. */
function clusterVersion(nodes: V1Node[]): string | null {
  const raw = nodes[0]?.status?.nodeInfo?.kubeletVersion;
  if (!raw) return null;
  const [major, minor] = raw.replace(/^v/, "").split(".");
  if (!major || !minor) return null;
  return `v${major}.${minor}`;
}

/**
 * GET /api/overview
 *
 * Everything on the overview landing is read from the live cluster:
 *  - nodes + GPU capacity from listNode
 *  - inference / dev-environment figures from the operator's CRs
 *  - the 24h utilization/memory trend from Prometheus (through the perses
 *    datasource proxy)
 *
 * The cluster read is all-or-nothing (a partial snapshot would mislead), but
 * the trend is best-effort: a missing/unreachable Prometheus yields
 * `trend: null` instead of failing the whole page.
 */
export const GET = withAuth(async () => {
  try {
    const api = getCoreClient();
    const co = getCustomObjectsClient();

    // Cluster + operator CRs, read as one consistent snapshot.
    const [nodesRes, isvcRes, devenvRes, profileRes] = await Promise.all([
      api.listNode(),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "inferenceservices" }),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "devenvironments" }),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "inferenceruntimeprofiles" }),
    ]);

    const nodes: V1Node[] = nodesRes.items ?? [];
    const isvcs: InferenceService[] = isvcRes.items ?? [];
    const devenvs: DevEnvironment[] = devenvRes.items ?? [];
    const profiles: RuntimeProfile[] = profileRes.items ?? [];

    // Per-pod GPU per role, keyed by profile name then role name.
    const profileRoleGpu = new Map<string, Map<string, number>>();
    for (const profile of profiles) {
      const byRole = new Map<string, number>();
      for (const role of profile.spec?.roles ?? []) {
        byRole.set(role.name ?? "", role.podTemplate?.resources?.gpuPerPod ?? 0);
      }
      profileRoleGpu.set(profile.metadata?.name ?? "", byRole);
    }

    let inferenceGpus = 0;
    let inferenceReady = 0;
    let inferenceScaling = 0;
    for (const isvc of isvcs) {
      // status.roles carries the resolved replicas/groupSize; only the
      // per-pod GPU needs the profile lookup.
      const roleGpu = profileRoleGpu.get(isvc.spec?.profileRef ?? "") ?? new Map<string, number>();
      for (const role of isvc.status?.roles ?? []) {
        const replicas = role.replicas ?? 0;
        const groupSize = role.groupSize ?? 1;
        inferenceGpus += replicas * groupSize * (roleGpu.get(role.name ?? "") ?? 0);
      }
      if (conditionTrue(isvc.status?.conditions, "Ready")) inferenceReady += 1;
      if (conditionTrue(isvc.status?.conditions, "Progressing")) inferenceScaling += 1;
    }

    let computeGpus = 0;
    let devenvRunning = 0;
    let devenvStopped = 0;
    for (const env of devenvs) {
      // Compute-pool allocation counts every DevEnvironment (running and
      // stopped) — the platform's committed GPU quota.
      computeGpus += env.spec?.resources?.gpuCount ?? 0;
      const phase = env.status?.phase?.name;
      if (phase === "Running") devenvRunning += 1;
      else if (phase === "Stopped") devenvStopped += 1;
    }

    const { totalCards, vendors } = gpuCapacity(nodes);
    const allocated = computeGpus + inferenceGpus;

    const summary: OverviewSummary = {
      nodes: { total: nodes.length, ready: nodes.filter((n) => conditionTrue(n.status?.conditions, "Ready")).length, version: clusterVersion(nodes) },
      gpu: {
        vendors: vendors.size,
        totalCards,
        compute: computeGpus,
        inference: inferenceGpus,
        allocated,
        free: Math.max(0, totalCards - allocated),
      },
      inference: { total: isvcs.length, ready: inferenceReady, scaling: inferenceScaling },
      devenv: { total: devenvs.length, running: devenvRunning, stopped: devenvStopped },
      trend: null,
    };

    // Best-effort metrics; any failure just leaves trend null.
    summary.trend = await loadTrend().catch(() => null);

    return Response.json(summary);
  } catch (err) {
    // Log the full error server-side; keep the client response free of internals.
    console.error("Failed to load overview:", err);
    return Response.json({ error: "Failed to load overview" }, { status: 500 });
  }
});

/** Query a cluster-wide metric over the rolling 24h window; null when empty. */
async function loadTrend(): Promise<{ util: number[]; mem: number[] } | null> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - TREND_POINTS * TREND_STEP_SECONDS;
  const [util, mem] = await Promise.all([
    queryRange(TREND_UTIL_QUERY, start, now),
    queryRange(TREND_MEM_QUERY, start, now),
  ]);
  if (!util || !mem) return null;
  return { util, mem };
}

async function queryRange(query: string, start: number, end: number): Promise<number[] | null> {
  const params = new URLSearchParams({
    query,
    start: String(start),
    end: String(end),
    step: String(TREND_STEP_SECONDS),
  });
  const url = `${PERSES_SERVER_URL}/proxy/globaldatasources/${PROMETHEUS_DATASOURCE}/api/v1/query_range?${params}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Prometheus query failed (${res.status})`);
  const body = (await res.json()) as {
    data?: { result?: Array<{ values?: Array<[number, string]> }> };
  };
  const values = body.data?.result?.[0]?.values;
  if (!values || values.length === 0) return null;
  return padSeries(values, start, TREND_STEP_SECONDS, TREND_POINTS);
}

/**
 * Align the returned points to fixed step buckets and forward-fill gaps, so
 * the chart always has exactly `points` samples.
 */
function padSeries(values: Array<[number, string]>, start: number, step: number, points: number): number[] {
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
