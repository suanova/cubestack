import type { V1Node } from "@kubernetes/client-node";

import { getCoreClient, getCustomObjectsClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";
import { defaultNamespaceOf } from "@/lib/namespaces";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";

/**
 * The GPU product label each vendor's device plugin writes. The operator pins
 * the same label when it enforces a profile's accelerator models
 * (operator/internal/renderer/render.go), so a node matches a selected model
 * exactly when this label carries it. A divergence would offer a node the
 * operator can never schedule onto.
 */
const GPU_MODEL_LABELS: Record<string, string> = {
  metax: "metax-tech.com/gpu.product",
  nvidia: "nvidia.com/gpu.product",
};

/** One node the wizard may pin a service to. */
export interface NodeOption {
  name: string;
  /**
   * The GPU model each vendor advertises on this node, keyed by vendor. The
   * wizard filters the picker by the model selected for the role, so a pin to
   * a node labelled with another model — a Pod that can only stay Pending —
   * is not offered. A vendor whose label the node does not carry is absent.
   */
  gpuModels: Record<string, string>;
}

/**
 * Catalog the create-wizard needs, read from the live cluster in one snapshot:
 * the namespaces you can deploy into, the runtimes (InferenceRuntimeProfile),
 * and the model versions (ModelVersion) you can serve. The profile projection
 * carries its declared overrides so the wizard can render the right inputs
 * (number with min/max, select from enum, default) and pre-flight compatibility.
 */
export interface CreateOptionsResponse {
  namespaces: Array<{ name: string }>;
  /**
   * The namespace the wizard opens on: the platform's configured one, else
   * `default`, else the first offered. Answered here rather than guessed by the
   * wizard — it used to prefer `project-a` by name and otherwise take whatever
   * sorted first, which is a platform namespace on a real install.
   */
  defaultNamespace: string | null;
  /**
   * The nodes the service may be pinned to, in name order, each carrying the
   * GPU model its vendor's product label advertises. Empty when the cluster
   * has nothing schedulable and when the best-effort node read fails; the
   * wizard then keeps its free-text node selector rather than pretending the
   * cluster offers no nodes.
   */
  nodes: NodeOption[];
  profiles: Array<{
    name: string;
    engine: string | null;
    engineVersion: string | null;
    vendor: string | null;
    models: string[];
    architectures: string[];
    quantizations: string[];
    /** Profile label inference.ai.cubestack.io/serving-mode: "pd-separation" | "standard" (or null when unlabeled). */
    servingMode: string | null;
    gpuPerPod: number | null;
    roles: Array<{ name: string; vendor: string | null; models: string[]; gpuPerPod: number | null }>;
    overrides: Array<{
      name: string;
      type: "integer" | "string" | "stringList" | "boolean";
      min: number | null;
      max: number | null;
      enum: Array<number | string> | null;
      default: number | string | string[] | boolean | null;
      description: string | null;
    }>;
  }>;
  modelversions: Array<{
    name: string;
    model: string | null;
    version: string | null;
    architecture: string | null;
    quantization: string | null;
  }>;
}

interface ProfileOverride {
  name?: string;
  type?: "integer" | "string" | "stringList" | "boolean";
  min?: number;
  max?: number;
  enum?: Array<number | string>;
  default?: number | string | string[] | boolean;
  description?: string;
}
interface ProfileRole {
  name?: string;
  accelerator?: { vendor?: string; models?: string[] };
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
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: ProfileSpec;
}

// Label declaring the profile's serving topology (see the deploy wizard):
// "pd-separation" (separate prefill/decode roles) or "standard" (single role).
const SERVING_MODE_LABEL = "inference.ai.cubestack.io/serving-mode";
interface ModelVersion {
  metadata?: { name?: string };
  spec?: {
    model?: string;
    version?: string;
    architecture?: string;
    quantization?: string;
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Whether the scheduler could use the node, matching the dev-environment
 * wizard's own rule: a cordoned node or one with a hard taint is not somewhere
 * a service should be pinned to, and a node that is not Ready cannot run it.
 */
function schedulable(node: V1Node): boolean {
  if (node.spec?.unschedulable) return false;
  if ((node.spec?.taints ?? []).some((t) => t.effect === "NoSchedule" || t.effect === "NoExecute")) return false;
  return (node.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
}

/** The schedulable nodes with their advertised GPU models, in name order. */
function offeredNodes(nodes: V1Node[]): NodeOption[] {
  return nodes
    .filter(schedulable)
    .map((node) => {
      const labels = node.metadata?.labels ?? {};
      const gpuModels: Record<string, string> = {};
      for (const [vendor, label] of Object.entries(GPU_MODEL_LABELS)) {
        const model = labels[label];
        if (model) gpuModels[vendor] = model;
      }
      return { name: node.metadata?.name ?? "", gpuModels };
    })
    .filter((node) => node.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const GET = withAuth(async () => {
  try {
    const core = getCoreClient();
    const co = getCustomObjectsClient();

    const [nsRes, profileRes, mvRes] = await Promise.all([
      core.listNamespace(),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "inferenceruntimeprofiles" }),
      co.listClusterCustomObject({ group: GROUP, version: VERSION, plural: "modelversions" }),
    ]);

    // The node list only feeds the wizard's optional node picker, so it is
    // best-effort: a principal without `list nodes` can still create a service
    // that lets the scheduler choose.
    let nodes: V1Node[] = [];
    try {
      nodes = (await core.listNode()).items ?? [];
    } catch (err) {
      // Logged rather than swallowed: an empty picker is otherwise
      // indistinguishable from a cluster with no schedulable nodes.
      console.warn("Failed to read the cluster's nodes:", err);
    }

    const profiles: Profile[] = profileRes.items ?? [];
    const modelversions: ModelVersion[] = mvRes.items ?? [];

    const names = (nsRes.items ?? [])
      .map((ns) => ns.metadata?.name)
      .filter((n): n is string => Boolean(n))
      .sort();

    const response: CreateOptionsResponse = {
      namespaces: names.map((name) => ({ name })),
      defaultNamespace: defaultNamespaceOf(names),
      nodes: offeredNodes(nodes),
      profiles: profiles.map((p) => {
        const spec = p.spec ?? {};
        const gpuPerPod = spec.roles?.reduce(
          (acc, r) => Math.max(acc, r.podTemplate?.resources?.gpuPerPod ?? 0),
          0,
        );
        return {
          name: p.metadata?.name ?? "?",
          engine: spec.engine?.name ?? null,
          engineVersion: spec.engine?.version ?? null,
          vendor: spec.accelerator?.vendor ?? null,
          models: spec.accelerator?.models ?? [],
          architectures: spec.modelRequirements?.architectures ?? [],
          quantizations: spec.modelRequirements?.quantization ?? [],
          servingMode: p.metadata?.labels?.[SERVING_MODE_LABEL] ?? null,
          gpuPerPod: gpuPerPod || 0,
          roles: (spec.roles ?? []).map((r) => ({
            name: r.name ?? "",
            // Effective accelerator (design §3.2 roles[].accelerator): the
            // role's own declaration replaces the profile-level one wholesale.
            vendor: r.accelerator?.vendor ?? spec.accelerator?.vendor ?? null,
            models: r.accelerator?.models ?? spec.accelerator?.models ?? [],
            gpuPerPod: r.podTemplate?.resources?.gpuPerPod ?? null,
          })),
          overrides: (spec.overrides ?? []).map((o) => ({
            name: o.name ?? "",
            type: o.type ?? "integer",
            min: num(o.min),
            max: num(o.max),
            enum: o.enum ?? null,
            default:
              o.default !== undefined
                ? (o.default as number | string | string[] | boolean)
                : null,
            description: o.description ?? null,
          })),
        };
      }),
      modelversions: modelversions.map((mv) => ({
        name: mv.metadata?.name ?? "?",
        model: mv.spec?.model ?? null,
        version: mv.spec?.version ?? null,
        architecture: mv.spec?.architecture ?? null,
        quantization: mv.spec?.quantization ?? null,
      })),
    };

    return Response.json(response);
  } catch (err) {
    console.error("Failed to load inference-service create options:", err);
    return Response.json({ error: "Failed to load create options" }, { status: 500 });
  }
});