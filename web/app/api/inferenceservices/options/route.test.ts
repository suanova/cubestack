// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet } from "@/test/auth";

const { listNamespace, listClusterCustomObject } = vi.hoisted(() => ({
  listNamespace: vi.fn(),
  listClusterCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace }),
  getCustomObjectsClient: () => ({ listClusterCustomObject }),
}));

/** Mirrors the real KinD cluster: 1 profile, 1 modelversion, a few namespaces. */
function stubCluster() {
  listNamespace.mockResolvedValue({
    items: [{ metadata: { name: "default" } }, { metadata: { name: "project-a" } }, { metadata: { name: "project-llm" } }],
  });
  listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "inferenceruntimeprofiles") {
      return Promise.resolve({
        items: [
          {
            metadata: { name: "metax-sglang-dsv4-pd" },
            spec: {
              engine: { name: "sglang", version: "vendor-0.5.12-rc1" },
              accelerator: { vendor: "metax", models: ["MXC500"] },
              modelRequirements: { architectures: ["deepseek_v4"], quantization: ["w8a8"] },
              overrides: [
                { name: "prefillReplicas", type: "integer", default: 1, min: 1, max: 8, description: "prefill LWS array" },
                { name: "decodeReplicas", type: "integer", default: 1, min: 1, max: 16 },
                { name: "groupSize", type: "integer", default: 1, enum: [1, 2, 4] },
              ],
              roles: [{ podTemplate: { resources: { gpuPerPod: 8 } } }],
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
  });

  it("returns namespaces, resolved profiles (with override decls) and model versions", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.namespaces.map((n: { name: string }) => n.name)).toContain("project-a");

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
      gpuPerPod: 8,
    });
    expect(profile.overrides).toEqual([
      { name: "prefillReplicas", type: "integer", min: 1, max: 8, enum: null, default: 1, description: "prefill LWS array" },
      { name: "decodeReplicas", type: "integer", min: 1, max: 16, enum: null, default: 1, description: null },
      { name: "groupSize", type: "integer", min: null, max: null, enum: [1, 2, 4], default: 1, description: null },
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

  it("returns 500 when the cluster read fails", async () => {
    listClusterCustomObject.mockRejectedValue(new Error("boom"));
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load create options" });
  });
});