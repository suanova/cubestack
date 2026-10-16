import type { V1Node } from "@kubernetes/client-node";

import { getCoreClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";
import { DEV_IMAGES } from "@/lib/devenvironments/images";
// The configured/default/first rule, shared with the inference wizard: filtering
// above has already confined "first" to a namespace that is not the platform's.
import { defaultNamespaceOf } from "@/lib/namespaces";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// The catalog lives in lib/devenvironments/images.ts because the create route
// falls back to the same list; the wizard is sent only what it displays — which
// now includes each image's runtime identity, since the wizard shows it and
// pre-fills the editable account / uid / gid fields from it.
const IMAGES: DevEnvImageOption[] = DEV_IMAGES.map(({ tag, label, user, runAsGroup, interface: iface, vendor }) => ({
  tag,
  label,
  user,
  runAsGroup,
  interface: iface,
  vendor,
}));

/** One selectable image, with the identity the wizard pre-fills from it. */
export interface DevEnvImageOption {
  tag: string;
  label: string;
  /** spec.runtime.user the image's own sshd serves. */
  user: string;
  /** spec.runtime.securityContext.runAsGroup, when 1000 is wrong for this image. */
  runAsGroup?: number;
  /** The interface the image was built for; the wizard offers only the images
   * that serve the environment type the user picked. */
  interface: "jupyter" | "ssh";
  /** The accelerator stack it carries; the wizard keeps it across a type change. */
  vendor: "cpu" | "nvidia" | "metax";
}

/**
 * Namespaces the wizard must not offer as a home for a development environment.
 *
 * The console cannot know every cluster's intent, but it can leave out what
 * Kubernetes reserves and what the platform itself installs into. Measured on a
 * live CubeStack install, the unfiltered list began "ai-gateway-system" — the
 * platform's own control-plane namespace — and the wizard preselected it, so an
 * untouched wizard would put a user's StatefulSet, PVC and Routes beside the
 * gateway. A platform installed elsewhere can name its namespace here.
 */
const PLATFORM_NAMESPACES = new Set([
  "ai-gateway-system", // Agent Router / AI Gateway control plane
  "cubestack-system", // the operator, the portal and the task CRs
  "envoy-gateway-system", // the Gateway API data plane
  "lws-system", // LeaderWorkerSet, for multi-node inference
  "metallb-system", // LoadBalancer address assignment
  "metax-operator", // the Metax device stack
  "rook-ceph", // the cluster's own storage
]);

/** Whether a namespace may be offered as a home for a development environment. */
function offered(name: string): boolean {
  return !name.startsWith("kube-") && !PLATFORM_NAMESPACES.has(name);
}

/** The vendors the wizard's accelerator select offers, in its own order. */
const GPU_VENDORS = ["nvidia", "metax"] as const;
type GpuVendor = (typeof GPU_VENDORS)[number];

/**
 * What each vendor's device plugin writes to the nodes it drives: the label
 * carrying the card's model, and the extended resource carrying how many the
 * node offers.
 *
 * The operator keeps its own copy of both for the scheduling side
 * (operator/internal/controller/podspec.go): it turns spec.resources.gpu.model
 * into a nodeSelector on exactly this label, matched verbatim. The strings are
 * written twice because the portal reads the label and the operator writes the
 * selector — a divergence would offer a model that no node can ever match.
 */
const GPU_NODE_ATTRS: Record<GpuVendor, { label: string; resource: string }> = {
  nvidia: { label: "nvidia.com/gpu.product", resource: "nvidia.com/gpu" },
  metax: { label: "metax-tech.com/gpu.product", resource: "metax-tech.com/gpu" },
};

/**
 * Whether the scheduler could place a pod on `node` at all: uncordoned,
 * untainted, and reporting for duty.
 *
 * The operator asks the same question before it counts a node at all —
 * uncordoned and untainted in operator/test/e2e/devenv/devices.go's
 * `schedulable` — and this asks it too, plus readiness. A node that is cordoned,
 * is tainted out of reach, or has stopped reporting for duty is still a node
 * this route would otherwise offer, and offering it is a choice whose only
 * outcome is a development environment stuck in Pending, which reports no error
 * to explain itself.
 *
 * `PreferNoSchedule` is deliberately not a bar, matching the operator: it is a
 * preference the scheduler weighs against the rest of the cluster, and calling
 * it one would hide a node the cluster could have served.
 */
function schedulable(node: V1Node): boolean {
  if (node.spec?.unschedulable) return false;
  if ((node.spec?.taints ?? []).some((t) => t.effect === "NoSchedule" || t.effect === "NoExecute")) return false;
  return (node.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
}

/**
 * Whether a pod asking for this vendor's accelerator could ever land on `node`:
 * a node the scheduler could use, with a device to spare.
 *
 * Offered models come from nodes that can actually run one, not from every node
 * that carries a label. A device plugin leaves its label behind when its node
 * comes back without devices, and a model offered off such a node is a choice
 * whose only outcome is a development environment stuck in Pending.
 */
function hostable(node: V1Node, vendor: GpuVendor): boolean {
  return schedulable(node) && Number(node.status?.allocatable?.[GPU_NODE_ATTRS[vendor].resource] ?? 0) > 0;
}

/**
 * The models the cluster advertises, per vendor: the distinct product-label
 * values across the nodes that could run one, sorted so the select's order does
 * not depend on the order the API server happened to return its nodes in. A
 * vendor no node carries yields an empty list, which is the answer the wizard
 * shows as "any" alone rather than an error.
 */
function advertisedModels(nodes: V1Node[]): { nvidia: string[]; metax: string[] } {
  const found: Record<GpuVendor, Set<string>> = { nvidia: new Set(), metax: new Set() };
  for (const node of nodes) {
    for (const vendor of GPU_VENDORS) {
      if (!hostable(node, vendor)) continue;
      const model = node.metadata?.labels?.[GPU_NODE_ATTRS[vendor].label];
      if (model) found[vendor].add(model);
    }
  }
  return { nvidia: [...found.nvidia].sort(), metax: [...found.metax].sort() };
}

/** One node the wizard may pin an environment to. */
export interface DevEnvNodeOption {
  name: string;
  /**
   * The accelerator vendors the node advertises, empty for a CPU-only node.
   * Carried so the pick can be made with the environment's own accelerator in
   * view: a CPU node picked under a GPU request is a pod no node can run, and
   * the environment reports it as nothing but Pending.
   */
  vendors: Array<"nvidia" | "metax">;
}

/**
 * The nodes the wizard may pin an environment to: every node the scheduler could
 * use, sorted by name so the select's order does not depend on the order the API
 * server happened to return its nodes in.
 *
 * A node's vendors are read off its allocatable counts rather than its product
 * label, which is the question `hostable` asks of the same field.
 */
function offeredNodes(nodes: V1Node[]): DevEnvNodeOption[] {
  return nodes
    .filter(schedulable)
    .map((node) => ({
      name: node.metadata?.name ?? "",
      vendors: GPU_VENDORS.filter((vendor) => Number(node.status?.allocatable?.[GPU_NODE_ATTRS[vendor].resource] ?? 0) > 0),
    }))
    .filter((node) => node.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Catalog the create wizard needs, read from the live cluster. */
export interface DevEnvOptionsResponse {
  namespaces: Array<{ name: string }>;
  /** The namespace the wizard opens on — never silently a platform namespace. */
  defaultNamespace: string | null;
  images: DevEnvImageOption[];
  /**
   * The GPU models the cluster's nodes advertise, per vendor, as the wizard
   * offers them. Only nodes that could actually run a pod contribute. Empty for
   * a vendor the cluster does not carry — and empty for both when the node list
   * could not be read, which is why the select is built to show "any" on its
   * own rather than assuming a non-empty list.
   */
  gpuModels: { nvidia: string[]; metax: string[] };
  /**
   * The nodes the wizard may pin an environment to, in name order. Read off the
   * same node list as gpuModels, so it is empty for the same two reasons — a
   * cluster with nothing to offer, and a principal that could not read the list.
   * The select is built to show "unscheduled" on its own rather than assuming a
   * non-empty list.
   */
  nodes: DevEnvNodeOption[];
}

/**
 * GET /api/devenvironments/options
 *
 * Namespaces, GPU models and nodes come from the live cluster; the image catalog
 * is static. The wizard uses these to populate its namespace select, the image
 * combobox, the model select and the node select, and to pre-fill the runtime
 * identity the user may then edit.
 *
 * The namespace list is a prerequisite — the wizard cannot open without a home
 * for the environment — so a failure there fails the request. The models and the
 * nodes are an enrichment: the models only narrow an accelerator request and the
 * nodes only pin one, and a principal without `list nodes` can still create a CPU
 * environment, so that single read is best-effort and its failure leaves both
 * selects showing their open option alone.
 */
export const GET = withAuth(async () => {
  try {
    const core = getCoreClient();
    const nsRes = await core.listNamespace();

    const names = (nsRes.items ?? [])
      .map((ns) => ns.metadata?.name)
      .filter((n): n is string => Boolean(n))
      .filter(offered)
      .sort();

    let nodes: V1Node[] = [];
    try {
      nodes = (await core.listNode()).items ?? [];
    } catch (err) {
      // Logged rather than swallowed: empty selects are otherwise
      // indistinguishable from "this cluster has no GPUs and no nodes".
      console.warn("Failed to read the cluster's nodes:", err);
    }

    const response: DevEnvOptionsResponse = {
      namespaces: names.map((name) => ({ name })),
      defaultNamespace: defaultNamespaceOf(names),
      images: IMAGES,
      gpuModels: advertisedModels(nodes),
      nodes: offeredNodes(nodes),
    };

    return Response.json(response);
  } catch (err) {
    console.error("Failed to load dev-environment create options:", err);
    return Response.json({ error: "Failed to load create options" }, { status: 500 });
  }
});