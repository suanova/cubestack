// @vitest-environment node
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/lib/i18n/dictionaries";

import { authedGet, authedRequest } from "@/test/auth";

const { listNamespace, listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject, getNamespacedCustomObject } = vi.hoisted(() => ({
  listNamespace: vi.fn(),
  listClusterCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
  createNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace }),
  getCustomObjectsClient: () => ({ listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject, getNamespacedCustomObject }),
}));

/** The cluster fixture mirrors the real KinD data: 2 services, 1 profile. */
function stubCluster() {
  listNamespace.mockResolvedValue({ items: [{ metadata: { name: "project-a" } }, { metadata: { name: "default" } }] });
  // getNamespacedCustomObject returns the single CR body (not a wrapped list);
  // unknown names reject with a 404-shaped error like the real client.
  const modelFor: Record<string, string> = {
    "dsv4-flash-pd": "deepseek-v4-flash-w8a8-v1",
    "dsv4-pro-pd": "deepseek-v4-pro-w8a8-v1",
  };
  getNamespacedCustomObject.mockImplementation(({ name, namespace }: { name: string; namespace: string }) => {
    const modelRef = modelFor[name];
    if (!modelRef) {
      const e = new Error("not found") as Error & { statusCode: number };
      e.statusCode = 404;
      return Promise.reject(e);
    }
    return Promise.resolve({
      apiVersion: "ai.cubestack.io/v1alpha1",
      kind: "InferenceService",
      metadata: { name, namespace },
      spec: { modelRef, profileRef: "metax-sglang-dsv4-pd" },
    });
  });
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
              route: { modelName: "dsv4-flash", publish: true, timeoutSeconds: 0, idleTimeoutSeconds: 300 },
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
              route: { modelName: "dsv4-pro", publish: true, timeoutSeconds: 0, idleTimeoutSeconds: 300 },
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
              { name: "groupSize", type: "integer", default: 1, enum: [1, 2, 4] },
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

/** A POST request with a signed session cookie. */
async function buildPost(body: unknown) {
  return authedRequest({ method: "POST", body: JSON.stringify(body) }, "http://localhost/api/inferenceservices");
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
    getNamespacedCustomObject.mockReset();
    vi.unstubAllGlobals();
  });

  it("projects each service from real CR data, resolving the profile", async () => {
    const { GET } = await importRoute();
    const res = await GET(await authedGet(), undefined);
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
      timeoutSeconds: 0,
      idleTimeoutSeconds: 300,
      // resolved profile facts
      engine: "sglang",
      engineVersion: "vendor-0.5.12-rc1",
      vendor: "metax",
      gpuModel: "MXC500",
      gpuPerPod: 8,
      // override knobs declared by the profile; effective value = user value, else default
      overrides: [
        { name: "prefillReplicas", type: "integer", min: 1, max: 8, enum: null, current: 1 },
        { name: "decodeReplicas", type: "integer", min: 1, max: 16, enum: null, current: 2 },
        { name: "groupSize", type: "integer", min: null, max: null, enum: [1, 2, 4], current: 1 },
      ],
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
    const res = await GET(await authedGet(), undefined);
    const body = await res.json();
    // Every metric family returns empty -> metrics null (page shows empty state).
    for (const item of body.items) {
      expect(item.metrics).toBeNull();
    }
  });

  it("scopes metrics queries to the exact service, not a name prefix", async () => {
    // Two services whose names share a prefix: an unanchored `service=~"llm.*"`
    // would also capture llm2's generated services (e.g. llm2-router) and mix
    // the two services' QPS/P95/TPS.
    const base = listClusterCustomObject.getMockImplementation()!;
    listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
      if (plural !== "inferenceservices") return base({ plural });
      return Promise.resolve({
        items: ["llm", "llm2"].map((name) => ({
          metadata: { name, namespace: "project-a", creationTimestamp: "2026-09-01T06:12:00Z" },
          spec: { modelRef: "deepseek-v4-flash-w8a8-v1", profileRef: "metax-sglang-dsv4-pd" },
        })),
      });
    });
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        queries.push(new URL(String(input)).searchParams.get("query") ?? "");
        return { ok: true, status: 200, json: async () => ({ data: { result: [] } }) };
      }),
    );

    const { GET } = await importRoute();
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);

    // Each service's queries anchor on its exact name (or -<role> suffix);
    // llm must not match llm2-*.
    const matchers = queries.map((q) => q.match(/service=~"([^"]+)"/)?.[1] ?? "");
    expect(new Set(matchers)).toEqual(new Set(["^llm(-.*)?$", "^llm2(-.*)?$"]));
  });

  it("patches the overrides via a merge patch on PATCH", async () => {
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: { decodeReplicas: 4, prefillReplicas: 2, groupSize: 2 },
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
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
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: { decodeReplicas: { bogus: true } },
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a PATCH with an override above the profile's max", async () => {
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: { decodeReplicas: 99 }, // profile max is 16
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a PATCH with an override value outside the declared enum", async () => {
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: { groupSize: 8 }, // enum is [1,2,4]
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a PATCH with a decimal value for an integer override", async () => {
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: { decodeReplicas: 1.5 },
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a PATCH with an override key the profile does not declare", async () => {
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: { bogus: 1 },
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("returns 404 when the target service does not exist", async () => {
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "does-not-exist",
          overrides: { decodeReplicas: 2 },
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(404);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("returns a client-safe 500 when the cluster read fails", async () => {
    listClusterCustomObject.mockRejectedValue(new Error("boom"));
    const { GET } = await importRoute();
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load inference services" });
  });
});

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
      await buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: { decodeReplicas: 4, prefillReplicas: 2, groupSize: 2 },
      }),
      undefined,
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
      await buildPost({ namespace: "project-a", name: "Bad_Name", profileRef: "p", modelRef: "m" }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a model incompatible with the profile", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "some-other-v5", // not in the stub modelversions -> not found
      }),
      undefined,
    );
    // modelRef doesn't exist at all -> 400 "model ... 不存在"
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects an override that exceeds its declared max", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: { decodeReplicas: 99 },
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a decimal value for an integer override", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: { decodeReplicas: 1.5 },
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a duplicate service name in the namespace", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "dsv4-flash-pd", // already exists in the fixture
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("creates a published service with a catalog model name and the timeout defaults", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        // A catalog model name is not a hostname segment: mixed case and "/"
        // are legal, while DNS_LABEL_RE would reject both.
        route: { publish: true, modelName: "Qwen3.8-27B/instruct" },
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    expect(createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    expect(createNamespacedCustomObject.mock.calls[0][0].body).toMatchObject({
      spec: {
        route: {
          publish: true,
          modelName: "Qwen3.8-27B/instruct",
          timeoutSeconds: 0, // 0 = no total-duration cap (the operator default)
          idleTimeoutSeconds: 300, // no-progress cap
        },
      },
    });
  });

  it("keeps the route timeouts the client sent", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "ok-name",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        route: { publish: true, modelName: "dsv4-flash", timeoutSeconds: 3600, idleTimeoutSeconds: 60 },
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    expect(createNamespacedCustomObject.mock.calls[0][0].body).toMatchObject({
      spec: { route: { publish: true, timeoutSeconds: 3600, idleTimeoutSeconds: 60 } },
    });
  });

  it("rejects a publish route without a valid modelName", async () => {
    const { POST } = await importRoute();
    for (const modelName of ["", ".dsv4", "dsv4 flash", "-dsv4"]) {
      createNamespacedCustomObject.mockClear();
      const res = await POST(
        await buildPost({
          namespace: "project-a",
          name: "ok-name",
          profileRef: "metax-sglang-dsv4-pd",
          modelRef: "deepseek-v4-flash-w8a8-v1",
          route: { publish: true, modelName },
        }),
        undefined,
      );
      expect(res.status, `modelName ${JSON.stringify(modelName)}`).toBe(400);
      expect(createNamespacedCustomObject).not.toHaveBeenCalled();
    }
  });

  it("rejects route timeouts outside the operator's ranges", async () => {
    const { POST } = await importRoute();
    const cases: Array<Record<string, number>> = [
      { timeoutSeconds: -1 },
      { timeoutSeconds: 86401 },
      { idleTimeoutSeconds: 0 },
      { idleTimeoutSeconds: 86401 },
    ];
    for (const timeouts of cases) {
      createNamespacedCustomObject.mockClear();
      const res = await POST(
        await buildPost({
          namespace: "project-a",
          name: "ok-name",
          profileRef: "metax-sglang-dsv4-pd",
          modelRef: "deepseek-v4-flash-w8a8-v1",
          route: { publish: true, modelName: "dsv4-flash", ...timeouts },
        }),
        undefined,
      );
      expect(res.status, JSON.stringify(timeouts)).toBe(400);
      expect(createNamespacedCustomObject).not.toHaveBeenCalled();
    }
  });

  it("returns 500 when the target create call fails", async () => {
    createNamespacedCustomObject.mockRejectedValue(new Error("boom"));
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
      }),
      undefined,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to create inference service" });
  });

  it("answers with codes the console has a sentence for", async () => {
    // The dictionary is keyed by code and the route's codes are strings, so
    // nothing below TypeScript ties the two together: a code added here without
    // its `inf.err.<code>` entry would reach the user as the bare code. This
    // scan is that tie.
    const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
    const codes = [...source.matchAll(/(?:ValidationError\(|(?:error|code):\s*)"(\w+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of new Set(codes)) {
      expect(dictionaries["zh-CN"], `inf.err.${code}`).toHaveProperty(`inf.err.${code}`);
    }
  });

});