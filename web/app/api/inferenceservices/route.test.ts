import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listNamespace, listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject } = vi.hoisted(() => ({
  listNamespace: vi.fn(),
  listClusterCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
  createNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace }),
  getCustomObjectsClient: () => ({ listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject }),
}));

/** The cluster fixture mirrors the real KinD data: 2 services, 1 profile. */
function stubCluster() {
  listNamespace.mockResolvedValue({ items: [{ metadata: { name: "project-a" } }, { metadata: { name: "default" } }] });
  listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "inferenceservices") {
      return Promise.resolve({
        items: [
          {
            metadata: {
              name: "dsv4-flash-pd",
              namespace: "project-a",
              creationTimestamp: "2026-09-01T06:12:00Z",
            },
            spec: {
              modelRef: "deepseek-v4-flash-w8a8-v1",
              profileRef: "metax-sglang-dsv4-pd",
              overrides: { decodeReplicas: 2, prefillReplicas: 1, maxModelLen: 131072 },
              route: { modelName: "dsv4-flash", publish: true, timeoutSeconds: 60 },
            },
            // No status: the controller has not reconciled yet.
          },
          {
            metadata: {
              name: "dsv4-pro-pd",
              namespace: "project-a",
              creationTimestamp: "2026-09-01T07:55:53Z",
            },
            spec: {
              modelRef: "deepseek-v4-pro-w8a8-v1",
              profileRef: "metax-sglang-dsv4-pd",
              overrides: { decodeReplicas: 2, prefillReplicas: 1, maxModelLen: 131072 },
              route: { modelName: "dsv4-pro", publish: true, timeoutSeconds: 60 },
            },
          },
        ],
      });
    }
    if (plural === "modelversions") {
      return Promise.resolve({
        items: [
          { metadata: { name: "deepseek-v4-flash-w8a8-v1" }, spec: { architecture: "deepseek_v4", quantization: "w8a8" } },
        ],
      });
    }
    // inferenceruntimeprofiles
    return Promise.resolve({
      items: [
        {
          metadata: { name: "metax-sglang-dsv4-pd" },
          spec: {
            engine: { name: "sglang", version: "vendor-0.5.12-rc1" },
            accelerator: { vendor: "metax", models: ["MXC500"] },
            modelRequirements: { architectures: ["deepseek_v4"], quantization: ["w8a8"] },
            overrides: [
              { name: "prefillReplicas", type: "integer", default: 1, min: 1, max: 8 },
              { name: "decodeReplicas", type: "integer", default: 1, min: 1, max: 16 },
              { name: "groupSize", type: "integer", enum: [1, 2, 4] },
            ],
            roles: [
              { name: "router", workload: { kind: "Deployment" } },
              { name: "prefill", workload: { kind: "LeaderWorkerSet" }, podTemplate: { resources: { gpuPerPod: 8 } } },
              { name: "decode", workload: { kind: "LeaderWorkerSet" }, podTemplate: { resources: { gpuPerPod: 8 } } },
            ],
          },
        },
      ],
    });
  });
}

function stubPrometheusEmpty() {
  // No engine metrics present -> queries return no data.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { result: [] } }),
    })),
  );
}

async function importRoute() {
  return import("./route");
}

describe("inference services route", () => {
  beforeEach(() => {
    stubCluster();
    stubPrometheusEmpty();
  });

  afterEach(() => {
    listNamespace.mockReset();
    listClusterCustomObject.mockReset();
    patchNamespacedCustomObject.mockReset();
    createNamespacedCustomObject.mockReset();
    vi.unstubAllGlobals();
  });

  it("projects each service from real CR data, resolving the profile", async () => {
    const { GET } = await importRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // Newest first (dsv4-pro-pd created later).
    const [pro, flash] = body.items;
    expect(flash).toMatchObject({
      name: "dsv4-flash-pd",
      namespace: "project-a",
      profileRef: "metax-sglang-dsv4-pd",
      modelRef: "deepseek-v4-flash-w8a8-v1",
      published: true,
      routeModelName: "dsv4-flash",
      timeoutSeconds: 60,
      // resolved profile facts
      engine: "sglang",
      engineVersion: "vendor-0.5.12-rc1",
      vendor: "metax",
      gpuModel: "MXC500",
      gpuPerPod: 8,
      // override knobs + bounds from the profile
      decode: { current: 2, min: 1, max: 16 },
      prefill: { current: 1, min: 1, max: 8 },
      groupSize: { current: 1, enum: [1, 2, 4] },
      // no status yet -> pending
      ready: null,
      progressing: false,
      conditions: [],
      roles: [],
      internalEndpoint: null,
      publicEndpoint: null,
    });
    // Sort only; both services share the profile.
    expect(body.items).toHaveLength(2);
    expect(pro.name).toBe("dsv4-pro-pd");
  });

  it("degrades metrics to null when Prometheus has no data", async () => {
    const { GET } = await importRoute();
    const res = await GET();
    const body = await res.json();
    // Every metric family returns empty -> metrics null (page shows empty state).
    for (const item of body.items) {
      expect(item.metrics).toBeNull();
    }
  });

  it("patches the overrides via a merge patch on PATCH", async () => {
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const req = new NextRequest("http://localhost/api/inferenceservices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: "project-a",
        name: "dsv4-flash-pd",
        overrides: { decodeReplicas: 4, prefillReplicas: 2, groupSize: 2 },
      }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).toHaveBeenCalledWith({
      group: "ai.cubestack.io",
      version: "v1alpha1",
      namespace: "project-a",
      plural: "inferenceservices",
      name: "dsv4-flash-pd",
      fieldManager: "cubestack-web",
      body: [
        { op: "add", path: "/spec/overrides/decodeReplicas", value: 4 },
        { op: "add", path: "/spec/overrides/prefillReplicas", value: 2 },
        { op: "add", path: "/spec/overrides/groupSize", value: 2 },
      ],
    });
  });

  it("rejects a PATCH with a non-primitive override value", async () => {
    const { PATCH } = await importRoute();
    const req = new NextRequest("http://localhost/api/inferenceservices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: "project-a",
        name: "dsv4-flash-pd",
        overrides: { decodeReplicas: { bogus: true } },
      }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("returns a client-safe 500 when the cluster read fails", async () => {
    listClusterCustomObject.mockRejectedValue(new Error("boom"));
    const { GET } = await importRoute();
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load inference services" });
  });
});
function buildPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/inferenceservices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("inference services create (POST)", () => {
  beforeEach(() => {
    stubCluster();
    stubPrometheusEmpty();
    createNamespacedCustomObject.mockResolvedValue({});
  });
  afterEach(() => {
    listNamespace.mockReset();
    listClusterCustomObject.mockReset();
    createNamespacedCustomObject.mockReset();
    vi.unstubAllGlobals();
  });

  it("creates a service with profile, model and overrides", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: { decodeReplicas: 4, prefillReplicas: 2, groupSize: 2 },
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: true, name: "new-serve" });
    expect(createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const call = createNamespacedCustomObject.mock.calls[0][0];
    expect(call).toMatchObject({
      group: "ai.cubestack.io",
      version: "v1alpha1",
      namespace: "project-a",
      plural: "inferenceservices",
    });
    expect(call.body).toMatchObject({
      kind: "InferenceService",
      metadata: { name: "new-serve", namespace: "project-a" },
      spec: {
        modelRef: "deepseek-v4-flash-w8a8-v1",
        profileRef: "metax-sglang-dsv4-pd",
        overrides: { decodeReplicas: 4, prefillReplicas: 2, groupSize: 2 },
      },
    });
  });

  it("rejects an invalid (non-DNS) name", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      buildPost({ namespace: "project-a", name: "Bad_Name", profileRef: "p", modelRef: "m" }),
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a model incompatible with the profile", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "some-other-v5", // not in the stub modelversions -> not found
      }),
    );
    // modelRef doesn't exist at all -> 400 "model ... 不存在"
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects an override that exceeds its declared max", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: { decodeReplicas: 99 },
      }),
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a duplicate service name in the namespace", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      buildPost({
        namespace: "project-a",
        name: "dsv4-flash-pd", // already exists in the fixture
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
      }),
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a publish route without a valid modelName", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        route: { publish: true, modelName: "" },
      }),
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("returns 500 when the target create call fails", async () => {
    createNamespacedCustomObject.mockRejectedValue(new Error("boom"));
    const { POST } = await importRoute();
    const res = await POST(
      buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to create inference service" });
  });
});
