// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet } from "@/test/auth";

const { listNamespace, listClusterCustomObject, listNode } = vi.hoisted(() => ({
  listNamespace: vi.fn(),
  listClusterCustomObject: vi.fn(),
  listNode: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace, listNode }),
  getCustomObjectsClient: () => ({ listClusterCustomObject }),
}));

/** Mirrors the real KinD cluster: 1 profile, 1 modelversion, a few namespaces. */
function stubCluster() {
  listNamespace.mockResolvedValue({
    items: [{ metadata: { name: "default" } }, { metadata: { name: "project-a" } }, { metadata: { name: "project-llm" } }],
  });
  // One node per reason the wizard must leave out: cordoned, a hard taint, and
  // not Ready. The two Ready, untainted nodes sort by name in the response and
  // carry the product label their vendor's device plugin writes.
  listNode.mockResolvedValue({
    items: [
      {
        metadata: { name: "worker-b", labels: { "metax-tech.com/gpu.product": "MXC550" } },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      },
      {
        metadata: { name: "worker-a", labels: { "metax-tech.com/gpu.product": "MXC500" } },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      },
      { metadata: { name: "cordoned" }, spec: { unschedulable: true }, status: { conditions: [{ type: "Ready", status: "True" }] } },
      { metadata: { name: "tainted" }, spec: { taints: [{ effect: "NoSchedule" }] }, status: { conditions: [{ type: "Ready", status: "True" }] } },
      { metadata: { name: "not-ready" }, status: { conditions: [{ type: "Ready", status: "False" }] } },
    ],
  });
  listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "inferenceruntimeprofiles") {
      return Promise.resolve({
        items: [
          {
            metadata: {
              name: "metax-sglang-dsv4-pd",
              labels: { "inference.ai.cubestack.io/serving-mode": "pd-separation" },
            },
            spec: {
              engine: { name: "sglang", version: "vendor-0.5.12-rc1" },
              accelerator: { vendor: "metax", models: ["MXC500"] },
              modelRequirements: { architectures: ["deepseek_v4"], quantization: ["w8a8"] },
              overrides: [
                { name: "prefillReplicas", type: "integer", default: 1, min: 1, max: 8, description: "prefill LWS array" },
                { name: "decodeReplicas", type: "integer", default: 1, min: 1, max: 16 },
                { name: "groupSize", type: "integer", default: 1, enum: [1, 2, 4] },
                {
                  name: "prefill_nodeSelector",
                  type: "stringList",
                  default: ["kubernetes.io/hostname=worker-a"],
                  enum: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
                  description: "prefill node pin",
                },
              ],
              roles: [
                { name: "prefill", podTemplate: { resources: { gpuPerPod: 8 } } },
                { name: "decode", accelerator: { vendor: "nvidia", models: ["H200"] }, podTemplate: { resources: { gpuPerPod: 8 } } },
              ],
            },
          },
        ],
      });
    }
    if (plural === "modelversions") {
      return Promise.resolve({
        items: [
          {
            metadata: { name: "deepseek-v4-flash-w8a8-v1" },
            spec: { model: "deepseek-v4-flash", version: "w8a8-v1", architecture: "deepseek_v4", quantization: "w8a8" },
          },
        ],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

describe("inference services create options route", () => {
  beforeEach(() => stubCluster());
  afterEach(() => {
    listNamespace.mockReset();
    listClusterCustomObject.mockReset();
    listNode.mockReset();
  });

  it("returns namespaces, resolved profiles (with override decls) and model versions", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.namespaces.map((n: { name: string }) => n.name)).toContain("project-a");
    // The wizard opens on `default`, not on the first name alphabetically
    // ("default" sorts after "project-a" here, so this is a choice) and not on a
    // name the route has no business preferring.
    expect(body.defaultNamespace).toBe("default");
    // The wizard pins a service through this list; only the nodes the
    // scheduler could actually use are offered, in name order, each with the
    // product label the wizard filters by when a model is chosen.
    expect(body.nodes).toEqual([
      { name: "worker-a", gpuModels: { metax: "MXC500" } },
      { name: "worker-b", gpuModels: { metax: "MXC550" } },
    ]);

    expect(body.profiles).toHaveLength(1);
    const profile = body.profiles[0];
    expect(profile).toMatchObject({
      name: "metax-sglang-dsv4-pd",
      engine: "sglang",
      engineVersion: "vendor-0.5.12-rc1",
      vendor: "metax",
      models: ["MXC500"],
      architectures: ["deepseek_v4"],
      quantizations: ["w8a8"],
      servingMode: "pd-separation",
      gpuPerPod: 8,
    });
    expect(profile.roles).toEqual([
      { name: "prefill", vendor: "metax", models: ["MXC500"], gpuPerPod: 8 },
      { name: "decode", vendor: "nvidia", models: ["H200"], gpuPerPod: 8 },
    ]);
    expect(profile.overrides).toEqual([
      { name: "prefillReplicas", type: "integer", min: 1, max: 8, enum: null, default: 1, description: "prefill LWS array" },
      { name: "decodeReplicas", type: "integer", min: 1, max: 16, enum: null, default: 1, description: null },
      { name: "groupSize", type: "integer", min: null, max: null, enum: [1, 2, 4], default: 1, description: null },
      {
        name: "prefill_nodeSelector",
        type: "stringList",
        min: null,
        max: null,
        enum: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
        default: ["kubernetes.io/hostname=worker-a"],
        description: "prefill node pin",
      },
    ]);

    expect(body.modelversions).toHaveLength(1);
    expect(body.modelversions[0]).toMatchObject({
      name: "deepseek-v4-flash-w8a8-v1",
      model: "deepseek-v4-flash",
      version: "w8a8-v1",
      architecture: "deepseek_v4",
      quantization: "w8a8",
    });
  });

  it("opens on the configured namespace when the platform names one", async () => {
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "project-llm";
    try {
      const { GET } = await import("./route");
      const res = await GET(await authedGet(), undefined);
      expect((await res.json()).defaultNamespace).toBe("project-llm");
    } finally {
      delete process.env.CUBESTACK_DEFAULT_NAMESPACE;
    }
  });

  it("opens on the first namespace only when there is no `default`", async () => {
    listNamespace.mockResolvedValue({ items: [{ metadata: { name: "project-a" } }, { metadata: { name: "project-llm" } }] });
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);
    // project-a sorts first, and `default` does not exist to be preferred.
    expect((await res.json()).defaultNamespace).toBe("project-a");
  });

  it("still serves the catalog when the node read is forbidden", async () => {
    // Pinning a node is optional, so a principal without `list nodes` must
    // still be able to create a service and let the scheduler choose.
    listNode.mockRejectedValue(new Error("nodes is forbidden"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { GET } = await import("./route");
      const res = await GET(await authedGet(), undefined);
      expect(res.status).toBe(200);
      expect((await res.json()).nodes).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("returns 500 when the cluster read fails", async () => {
    listClusterCustomObject.mockRejectedValue(new Error("boom"));
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load create options" });
  });
});