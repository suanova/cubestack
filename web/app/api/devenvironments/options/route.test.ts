// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { listNamespace, listNode } = vi.hoisted(() => ({ listNamespace: vi.fn(), listNode: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace, listNode }),
}));

/** The namespaces a live CubeStack install advertises. */
function stubNamespaces(names: string[]) {
  listNamespace.mockResolvedValue({ items: names.map((name) => ({ metadata: { name } })) });
}

/**
 * A node as the route reads one. `labels` alone is the ordinary case — a node
 * up and serving with its device plugin's product label on it — so a case that
 * is about which models are on offer states only that. The rest describe the
 * ways a node keeps its label without being able to run anything.
 */
interface StubNode {
  /** The node's name, which is also what a pin to it selects. */
  name?: string;
  labels: Record<string, string>;
  /** The Ready condition's status. Defaults to true. */
  ready?: boolean;
  /** Set to cordon the node. */
  unschedulable?: boolean;
  taints?: Array<{ effect: string }>;
  /** Its allocatable extended resources, e.g. `{ "nvidia.com/gpu": "8" }`. */
  allocatable?: Record<string, string>;
}

function stubNodes(nodes: StubNode[]) {
  listNode.mockResolvedValue({
    items: nodes.map((n, i) => ({
      metadata: { name: n.name ?? `node-${i}`, labels: n.labels },
      spec: { unschedulable: n.unschedulable ?? false, taints: n.taints ?? [] },
      status: {
        conditions: [{ type: "Ready", status: n.ready === false ? "False" : "True" }],
        // The route asks a node for its GPU count, so a node whose plugin is
        // working states one unless the case is about one whose does not.
        allocatable: n.allocatable ?? { "nvidia.com/gpu": "8", "metax-tech.com/gpu": "8" },
      },
    })),
  });
}

async function options(): Promise<{ namespaces: Array<{ name: string }>; defaultNamespace: string | null }> {
  const { GET } = await import("./route");
  const res = await GET(await authedGet(), undefined);
  expect(res.status).toBe(200);
  return res.json();
}

/** The models the wizard is sent, per vendor. */
async function gpuModels(): Promise<{ nvidia: string[]; metax: string[] }> {
  const { GET } = await import("./route");
  const res = await GET(await authedGet(), undefined);
  expect(res.status).toBe(200);
  return (await res.json()).gpuModels;
}

/** The catalog the wizard is sent, with the axes it selects on. */
async function images(): Promise<Array<{ tag: string; interface: string; vendor: string }>> {
  const { GET } = await import("./route");
  const res = await GET(await authedGet(), undefined);
  expect(res.status).toBe(200);
  return (await res.json()).images;
}

/** The nodes the wizard may pin an environment to. */
async function nodes(): Promise<Array<{ name: string; vendors: string[] }>> {
  const { GET } = await import("./route");
  const res = await GET(await authedGet(), undefined);
  expect(res.status).toBe(200);
  return (await res.json()).nodes;
}

describe("GET /api/devenvironments/options", () => {
  beforeEach(() => {
    vi.resetModules();
    listNamespace.mockReset();
    // A cluster with no GPU nodes is the default, so a case that is about
    // namespaces says nothing about models and does not have to.
    listNode.mockReset();
    listNode.mockResolvedValue({ items: [] });
    delete process.env.CUBESTACK_DEFAULT_NAMESPACE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CUBESTACK_DEFAULT_NAMESPACE;
  });

  it("offers `default` alone, whatever else the cluster has", async () => {
    // The list measured on cs7, plus the two namespaces the operator creates
    // itself that the old denylist did not know about (issue #367).
    stubNamespaces([
      "ai-gateway-system",
      "cubestack-system",
      "cuberouter",
      "default",
      "envoy-gateway-system",
      "kube-node-lease",
      "kube-public",
      "kube-system",
      "lws-system",
      "metallb-system",
      "metax-operator",
      "monitoring",
      "project-a",
      "rook-ceph",
    ]);

    const body = await options();
    // A denylist of the platform's own namespaces was always one install
    // behind — `monitoring` and `cuberouter` were offered on cs5 — so the
    // wizard offers the one namespace that is always safe and creates the
    // user's own from the select's "create a new namespace" entry.
    expect(body.namespaces).toEqual([{ name: "default" }]);
  });

  it("opens on `default` rather than on whatever sorts first", async () => {
    stubNamespaces(["ai-gateway-system", "project-a", "default", "team-b"]);

    const body = await options();
    // Sorted ascending, so the first entry is team-b and the alphabetically
    // first of all is a platform namespace — neither is the answer.
    expect(body.namespaces.map((n) => n.name)).toEqual(["default"]);
    expect(body.defaultNamespace).toBe("default");
  });

  it("opens on the platform's configured namespace when there is one", async () => {
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "team-b";
    stubNamespaces(["default", "project-a", "team-b"]);

    // An explicit platform decision beats the conventional default: otherwise
    // the setting could never take effect on a cluster that has `default`.
    expect((await options()).defaultNamespace).toBe("team-b");
  });

  it("ignores a configured namespace the cluster does not have", async () => {
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "ai-gateway-system";
    stubNamespaces(["default", "project-a"]);

    // Configured or not, a namespace that is not offered cannot be selected.
    expect((await options()).defaultNamespace).toBe("default");
  });

  it("names no default when the cluster has no `default` namespace", async () => {
    stubNamespaces(["kube-system", "project-a", "team-b"]);

    // Confined by the filter to `default`, so there is nothing to open on and
    // nothing to fall back to: the wizard starts on its "create a new
    // namespace" entry instead of on a platform namespace the way it used to.
    expect((await options()).defaultNamespace).toBeNull();
  });

  it("names no default when the cluster offers no namespace", async () => {
    stubNamespaces(["kube-system", "cubestack-system"]);

    expect(await options()).toMatchObject({ namespaces: [], defaultNamespace: null });
  });

  it("sends the two axes the wizard selects an image on", async () => {
    stubNamespaces(["default"]);

    // The wizard offers only the images that serve the chosen type, and keeps the
    // accelerator across a type change, so both axes have to reach it: an image
    // built for one interface cannot serve the other, and the pair a change moves
    // between is the vendor.
    expect(await images()).toEqual([
      { tag: "harbor.isuanova.com/suanova/cpu-pytorch:latest", label: "suanova/cpu-pytorch · CPU · JupyterLab (ubuntu)", user: "ubuntu", runAsGroup: undefined, interface: "jupyter", vendor: "cpu" },
      { tag: "harbor.isuanova.com/suanova/cpu-pytorch:latest", label: "suanova/cpu-pytorch · CPU · SSH (ubuntu)", user: "ubuntu", runAsGroup: undefined, interface: "ssh", vendor: "cpu" },
      { tag: "harbor.isuanova.com/suanova/cuda-pytorch:latest", label: "suanova/cuda-pytorch · NVIDIA CUDA · JupyterLab (ubuntu)", user: "ubuntu", runAsGroup: undefined, interface: "jupyter", vendor: "nvidia" },
      { tag: "harbor.isuanova.com/suanova/cuda-pytorch:latest", label: "suanova/cuda-pytorch · NVIDIA CUDA · SSH (ubuntu)", user: "ubuntu", runAsGroup: undefined, interface: "ssh", vendor: "nvidia" },
      { tag: "harbor.isuanova.com/suanova/maca-pytorch:latest", label: "suanova/maca-pytorch · Metax MACA · JupyterLab (ubuntu)", user: "ubuntu", runAsGroup: undefined, interface: "jupyter", vendor: "metax" },
      { tag: "harbor.isuanova.com/suanova/maca-pytorch:latest", label: "suanova/maca-pytorch · Metax MACA · SSH (ubuntu)", user: "ubuntu", runAsGroup: undefined, interface: "ssh", vendor: "metax" },
    ]);
  });

  it("lists the models the cluster's nodes advertise, per vendor", async () => {
    stubNamespaces(["default"]);
    stubNodes([
      { labels: { "nvidia.com/gpu.product": "H200" } },
      { labels: { "nvidia.com/gpu.product": "A100" } },
      // The same card on a second node is one choice, not two.
      { labels: { "nvidia.com/gpu.product": "H200" } },
      { labels: { "metax-tech.com/gpu.product": "MXC550" } },
      // A CPU node carries no product label and contributes nothing.
      { labels: {} },
    ]);

    // Sorted, so the select's order does not depend on the order the API server
    // happened to return its nodes in.
    expect(await gpuModels()).toEqual({ nvidia: ["A100", "H200"], metax: ["MXC550"] });
  });

  it("offers no model for a vendor the cluster does not carry", async () => {
    stubNamespaces(["default"]);
    stubNodes([{ labels: { "nvidia.com/gpu.product": "H200" } }]);

    // Empty rather than absent: the wizard's select offers "any" alone, which is
    // also what a cluster with no GPUs at all gets.
    expect(await gpuModels()).toEqual({ nvidia: ["H200"], metax: [] });
  });

  it("leaves out a model only a node that cannot run a pod advertises", async () => {
    stubNamespaces(["default"]);
    stubNodes([
      { labels: { "nvidia.com/gpu.product": "H200" } },
      // A device plugin keeps its label when its node goes down, and comes back
      // with it: the model is what the node last reported, not what it has.
      { labels: { "nvidia.com/gpu.product": "A100" }, ready: false },
      // Cordoned: still Ready, still labelled, and the scheduler will put
      // nothing on it.
      { labels: { "nvidia.com/gpu.product": "V100" }, unschedulable: true },
      // Tainted out of reach. The environments this wizard creates carry no
      // tolerations, so a NoSchedule or NoExecute taint is a bar for them.
      { labels: { "nvidia.com/gpu.product": "P100" }, taints: [{ effect: "NoSchedule" }] },
      { labels: { "nvidia.com/gpu.product": "T4" }, taints: [{ effect: "NoExecute" }] },
      // The plugin stopped advertising devices: the label is stale.
      { labels: { "nvidia.com/gpu.product": "K80" }, allocatable: { "nvidia.com/gpu": "0" } },
    ]);

    // Only the one node that would actually accept the pod. Offering the rest
    // would be offering a choice whose only outcome is an environment pinned to
    // a model no node can serve — and Pending reports no error to explain that.
    expect(await gpuModels()).toEqual({ nvidia: ["H200"], metax: [] });
  });

  it("keeps a model a PreferNoSchedule node advertises", async () => {
    stubNamespaces(["default"]);
    stubNodes([{ labels: { "nvidia.com/gpu.product": "H200" }, taints: [{ effect: "PreferNoSchedule" }] }]);

    // A preference, not a bar: the scheduler weighs it against the rest of the
    // cluster, so hiding the model would hide one this cluster could still run.
    expect(await gpuModels()).toEqual({ nvidia: ["H200"], metax: [] });
  });

  it("lists the nodes an environment may be pinned to, in name order", async () => {
    stubNamespaces(["default"]);
    stubNodes([
      { name: "worker-b", labels: { "nvidia.com/gpu.product": "H200" }, allocatable: { "nvidia.com/gpu": "8" } },
      // A CPU-only node, which is a pin an environment may still legitimately
      // make — its own accelerator is what decides whether that is a good one.
      { name: "worker-a", labels: {}, allocatable: {} },
      // Both vendors, so the pick can be made with the environment's own
      // accelerator in view.
      { name: "worker-c", labels: {}, allocatable: { "nvidia.com/gpu": "4", "metax-tech.com/gpu": "4" } },
    ]);

    // Sorted, so the select's order does not depend on the order the API server
    // happened to return its nodes in — the same reason the models are.
    expect(await nodes()).toEqual([
      { name: "worker-a", vendors: [] },
      { name: "worker-b", vendors: ["nvidia"] },
      { name: "worker-c", vendors: ["nvidia", "metax"] },
    ]);
  });

  it("leaves out a node the scheduler could not place a pod on", async () => {
    stubNamespaces(["default"]);
    stubNodes([
      { name: "worker-a", labels: {} },
      // Cordoned, drained, or gone: still a node the API server lists, and not
      // one a pod asking for it could land on.
      { name: "worker-down", labels: {}, ready: false },
      { name: "worker-cordoned", labels: {}, unschedulable: true },
      { name: "worker-tainted", labels: {}, taints: [{ effect: "NoExecute" }] },
      // A preference, not a bar — the same reading the models get.
      { name: "worker-prefer", labels: {}, taints: [{ effect: "PreferNoSchedule" }] },
    ]);

    expect((await nodes()).map((n) => n.name)).toEqual(["worker-a", "worker-prefer"]);
  });

  it("still serves the catalog when the nodes cannot be read", async () => {
    stubNamespaces(["default", "project-a"]);
    listNode.mockRejectedValue(new Error("forbidden"));

    // The models only narrow an accelerator request, so a principal without
    // `list nodes` — or a flaky read — must not take the whole wizard down: a
    // CPU environment is still creatable, and the select degrades to "any".
    expect((await options()).namespaces).toEqual([{ name: "default" }]);
    expect(await gpuModels()).toEqual({ nvidia: [], metax: [] });
    // The pin comes off the same read, so it degrades the same way: "any" alone,
    // which is the environment stating no node rather than an error.
    expect(await nodes()).toEqual([]);
  });

  it("rejects an unauthenticated request", async () => {
    stubNamespaces(["default"]);
    const { GET } = await import("./route");
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
    expect(listNamespace).not.toHaveBeenCalled();
    expect(listNode).not.toHaveBeenCalled();
  });
});
