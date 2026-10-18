// @vitest-environment node
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/lib/i18n/dictionaries";

import { authedGet, authedRequest } from "@/test/auth";

const { listNamespace, listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject, getNamespacedCustomObject, deleteNamespacedCustomObject } = vi.hoisted(() => ({
  listNamespace: vi.fn(),
  listClusterCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
  createNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  deleteNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace }),
  getCustomObjectsClient: () => ({ listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject, getNamespacedCustomObject, deleteNamespacedCustomObject }),
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
              { name: "prefill_nodeSelector", type: "stringList", default: [] },
              { name: "decode_nodeSelector", type: "stringList", default: [], enum: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"] },
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

/** Record every PromQL query the route issues; answer with no samples. */
function stubRecordingPrometheus(queries: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      queries.push(new URL(String(input)).searchParams.get("query") ?? "");
      return { ok: true, status: 200, json: async () => ({ data: { result: [] } }) };
    }),
  );
}

/**
 * Stub a cluster holding one service (`svc`) whose profile names `engine`
 * (`null` models a profile that carries no engine at all).
 */
function stubSingleService(engine: string | null) {
  const base = listClusterCustomObject.getMockImplementation()!;
  listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "inferenceservices") {
      return Promise.resolve({
        items: [
          {
            metadata: { name: "svc", namespace: "project-a", creationTimestamp: "2026-09-01T06:12:00Z" },
            spec: { modelRef: "deepseek-v4-flash-w8a8-v1", profileRef: "engine-profile" },
          },
        ],
      });
    }
    if (plural === "inferenceruntimeprofiles") {
      return Promise.resolve({
        items: [
          {
            metadata: { name: "engine-profile" },
            spec: { engine: engine === null ? undefined : { name: engine, version: "v1" } },
          },
        ],
      });
    }
    return base({ plural });
  });
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
    deleteNamespacedCustomObject.mockReset();
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
      gpuRoles: [
        { name: "prefill", gpuPerPod: 8, model: "MXC500" },
        { name: "decode", gpuPerPod: 8, model: "MXC500" },
      ],
      // override knobs declared by the profile; effective value = user value, else default
      overrides: [
        { name: "prefillReplicas", type: "integer", min: 1, max: 8, enum: null, current: 1 },
        { name: "decodeReplicas", type: "integer", min: 1, max: 16, enum: null, current: 2 },
        { name: "groupSize", type: "integer", min: null, max: null, enum: [1, 2, 4], current: 1 },
        { name: "prefill_nodeSelector", type: "stringList", current: [], default: [] },
        { name: "decode_nodeSelector", type: "stringList", current: [], default: [] },
      ],
      // no status yet -> no phase
      phase: null,
      phaseReason: null,
      conditions: [],
      roles: [],
      internalEndpoint: null,
      publicEndpoint: null,
    });
    // Sort only; both services share the profile.
    expect(body.items).toHaveLength(2);
    expect(pro.name).toBe("dsv4-pro-pd");
  });

  it("projects each GPU role's effective model and card count", async () => {
    // The PD profile pins each role's GPU model through a role-scoped override
    // reference in its pod-template node selector. The list must report the
    // selected models, not the profile's first declared one, and one entry per
    // GPU role so the UI can show "prefill 8 × MXC500 · decode 8 × MXC550".
    listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
      if (plural === "inferenceservices") {
        return Promise.resolve({
          items: [
            {
              metadata: { name: "test", namespace: "default" },
              spec: {
                modelRef: "deepseek-v4-flash-w8a8",
                profileRef: "metax-sglang-dsv4-pd",
                overrides: { prefill_metax_model: "MXC500", decode_metax_model: "MXC550" },
              },
            },
          ],
        });
      }
      if (plural === "modelversions") {
        return Promise.resolve({
          items: [
            { metadata: { name: "deepseek-v4-flash-w8a8" }, spec: { architecture: "deepseek_v4", quantization: "w8a8" } },
          ],
        });
      }
      if (plural === "inferenceruntimeprofiles") {
        return Promise.resolve({
          items: [
            {
              metadata: { name: "metax-sglang-dsv4-pd" },
              spec: {
                engine: { name: "sglang", version: "0.5.13" },
                accelerator: { vendor: "metax", models: ["MXC500", "MXC550"] },
                overrides: [
                  { name: "prefill_metax_model", type: "string", default: "MXC550", enum: ["MXC500", "MXC550"] },
                  { name: "decode_metax_model", type: "string", default: "MXC550", enum: ["MXC500", "MXC550"] },
                ],
                roles: [
                  {
                    name: "prefill",
                    podTemplate: {
                      nodeSelector: { "metax-tech.com/gpu.product": "{{ overrides.prefill_metax_model }}" },
                      resources: { gpuPerPod: 8 },
                    },
                  },
                  {
                    name: "decode",
                    podTemplate: {
                      nodeSelector: { "metax-tech.com/gpu.product": "{{ overrides.decode_metax_model }}" },
                      resources: { gpuPerPod: 8 },
                    },
                  },
                  { name: "router" },
                ],
              },
            },
          ],
        });
      }
      return Promise.resolve({ items: [] });
    });

    const { GET } = await importRoute();
    const body = await (await GET(await authedGet(), undefined)).json();
    expect(body.items[0].gpuRoles).toEqual([
      { name: "prefill", gpuPerPod: 8, model: "MXC500" },
      { name: "decode", gpuPerPod: 8, model: "MXC550" },
    ]);
    expect(body.items[0].gpuModel).toBe("MXC500 / MXC550");
  });

  it("uses a role's own accelerator for its GPU model", async () => {
    // A heterogeneous PD profile: decode runs on NVIDIA, so its label and its
    // fallback model come from the role, not from the profile-level metax one.
    listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
      if (plural === "inferenceservices") {
        return Promise.resolve({
          items: [
            {
              metadata: { name: "test", namespace: "default" },
              spec: { modelRef: "deepseek-v4-flash-w8a8", profileRef: "heterogeneous" },
            },
          ],
        });
      }
      if (plural === "modelversions") {
        return Promise.resolve({
          items: [
            { metadata: { name: "deepseek-v4-flash-w8a8" }, spec: { architecture: "deepseek_v4", quantization: "w8a8" } },
          ],
        });
      }
      if (plural === "inferenceruntimeprofiles") {
        return Promise.resolve({
          items: [
            {
              metadata: { name: "heterogeneous" },
              spec: {
                engine: { name: "sglang", version: "0.5.13" },
                accelerator: { vendor: "metax", models: ["MXC500"] },
                roles: [
                  { name: "prefill", podTemplate: { resources: { gpuPerPod: 8 } } },
                  {
                    name: "decode",
                    accelerator: { vendor: "nvidia", models: ["H200"] },
                    podTemplate: {
                      nodeSelector: { "nvidia.com/gpu.product": "H200" },
                      resources: { gpuPerPod: 8 },
                    },
                  },
                  {
                    name: "decode-unpinned",
                    accelerator: { vendor: "nvidia", models: ["H200"] },
                    podTemplate: { resources: { gpuPerPod: 8 } },
                  },
                ],
              },
            },
          ],
        });
      }
      return Promise.resolve({ items: [] });
    });

    const { GET } = await importRoute();
    const body = await (await GET(await authedGet(), undefined)).json();
    expect(body.items[0].gpuRoles).toEqual([
      { name: "prefill", gpuPerPod: 8, model: "MXC500" },
      { name: "decode", gpuPerPod: 8, model: "H200" },
      { name: "decode-unpinned", gpuPerPod: 8, model: "H200" },
    ]);
  });

  it("projects the controller's phase and its reason", async () => {
    stubCluster();
    const { GET } = await importRoute();
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Both services are unreconciled in the fixture: no phase, not a guessed one.
    expect(body.items.map((s: { phase: string | null }) => s.phase)).toEqual([null, null]);

    // A reconciled service carries the operator's own one-word verdict through
    // unchanged — no second derivation in the route.
    listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
      if (plural !== "inferenceservices") return Promise.resolve({ items: [] });
      return Promise.resolve({
        items: [
          {
            metadata: { name: "dsv4-pro-pd", namespace: "project-a", creationTimestamp: "2026-09-01T07:55:53Z" },
            spec: { modelRef: "deepseek-v4-pro-w8a8-v1", profileRef: "metax-sglang-dsv4-pd" },
            status: { phase: { name: "Progressing", reason: "Rollout" } },
          },
        ],
      });
    });
    const reconciled = await (await GET(await authedGet(), undefined)).json();
    expect(reconciled.items[0]).toMatchObject({ phase: "Progressing", phaseReason: "Rollout" });
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

  it("queries the engine's own metric families, one family per query", async () => {
    // The engines do not share family names, and a matcher spanning families
    // would pull in a second latency histogram (vLLM's per-token
    // `vllm:inter_token_latency_seconds_bucket` alongside the e2e one), which
    // Prometheus rejects outright.
    const { GET } = await importRoute();

    for (const [engine, families] of [
      ["vLLM", ["vllm:request_success_total", "vllm:generation_tokens_total", "vllm:e2e_request_latency_seconds_bucket"]],
      ["sglang", ["sglang:num_requests_total", "sglang:generation_tokens_total", "sglang:e2e_request_latency_seconds_bucket"]],
    ] as const) {
      stubSingleService(engine);
      const queries: string[] = [];
      stubRecordingPrometheus(queries);
      expect((await GET(await authedGet(), undefined)).status).toBe(200);

      // Three instant queries plus the sparkline's range query, which reuses
      // the QPS one.
      expect(queries).toHaveLength(4);
      for (const [family, n] of [
        [families[0], 2],
        [families[1], 1],
        [families[2], 1],
      ] as const) {
        expect(queries.filter((q) => q.includes(`${family}{namespace="project-a"`))).toHaveLength(n);
      }
      // The engine name is matched case-insensitively and no query drifts onto
      // the other engine's families.
      const other = engine === "vLLM" ? "sglang:" : "vllm:";
      expect(queries.every((q) => !q.includes(other) && !q.includes("__name__=~"))).toBe(true);
    }
  });

  it("parses the engine samples and reports P95 in milliseconds", async () => {
    // Magnitudes taken from the cluster's own vLLM exporter: 0.0037 req/s,
    // 0.64 tok/s and a 4.875 s end-to-end latency histogram.
    stubSingleService("vllm");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const query = url.searchParams.get("query") ?? "";
        const start = Number(url.searchParams.get("start"));
        const result = url.pathname.endsWith("/query_range")
          ? [{ values: [[start, "0.031"], [start + 150, "0.004"]] }]
          : [
              {
                value: [
                  start,
                  query.includes("request_success_total")
                    ? "0.0037"
                    : query.includes("e2e_request_latency_seconds_bucket")
                      ? "4.875"
                      : "0.64",
                ],
              },
            ];
        return { ok: true, status: 200, json: async () => ({ data: { result } }) };
      }),
    );

    const { GET } = await importRoute();
    const body = await (await GET(await authedGet(), undefined)).json();
    const m = body.items[0].metrics;
    expect(m.qps).toBeCloseTo(0.0037);
    expect(m.tps).toBeCloseTo(0.64);
    // 4.875 s of engine histogram -> milliseconds, the unit the console prints.
    expect(m.p95).toBeCloseTo(4875);
    // Sparkline: one point per step, gaps carried forward.
    expect(m.spark).toHaveLength(12);
    expect(m.spark[0]).toBeCloseTo(0.031);
    expect(m.spark[11]).toBeCloseTo(0.004);
  });

  it("queries nothing for an engine it has no families for", async () => {
    // An engine the console cannot map (a profile pointing at something else)
    // must show its empty state, never a neighbouring engine's numbers.
    stubSingleService("tgi");
    const queries: string[] = [];
    stubRecordingPrometheus(queries);

    const { GET } = await importRoute();
    const body = await (await GET(await authedGet(), undefined)).json();
    expect(queries).toHaveLength(0);
    expect(body.items[0].metrics).toBeNull();
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

  it("patches a stringList override as a JSON array", async () => {
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: {
            decode_nodeSelector: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
          },
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        body: [
          {
            op: "add",
            path: "/spec/overrides/decode_nodeSelector",
            value: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
          },
        ],
      }),
    );
  });

  it("rejects a PATCH with a scalar for a stringList override", async () => {
    const { PATCH } = await importRoute();
    const req = await authedRequest(
      {
        method: "PATCH",
        body: JSON.stringify({
          namespace: "project-a",
          name: "dsv4-flash-pd",
          overrides: { prefill_nodeSelector: "kubernetes.io/hostname=worker-a" },
        }),
      },
      "http://localhost/api/inferenceservices",
    );
    const res = await PATCH(req, undefined);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "overrideNotStringList" });
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
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

  it("creates a service with a stringList override", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: {
          decode_nodeSelector: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
        },
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    expect(createNamespacedCustomObject.mock.calls[0][0].body).toMatchObject({
      spec: {
        overrides: {
          decode_nodeSelector: ["kubernetes.io/hostname=worker-a", "kubernetes.io/hostname=worker-b"],
        },
      },
    });
  });

  it("rejects a scalar for a stringList override", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: { prefill_nodeSelector: "kubernetes.io/hostname=worker-a" },
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "overrideNotStringList" });
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a stringList entry outside the declared enum", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        overrides: { decode_nodeSelector: ["kubernetes.io/hostname=worker-c"] },
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "overrideNotAllowed" });
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a stringList entry containing a comma", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await buildPost({
        namespace: "project-a",
        name: "new-serve",
        profileRef: "metax-sglang-dsv4-pd",
        modelRef: "deepseek-v4-flash-w8a8-v1",
        // prefill_nodeSelector declares no enum, so this guards the comma
        // rule itself rather than the enum check.
        overrides: { prefill_nodeSelector: ["node-pool=a,node-pool=b"] },
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "overrideNotAllowed" });
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
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

describe("inference services delete (DELETE)", () => {
  beforeEach(() => {
    stubCluster();
    stubPrometheusEmpty();
    deleteNamespacedCustomObject.mockResolvedValue({});
  });

  afterEach(() => {
    deleteNamespacedCustomObject.mockReset();
    vi.unstubAllGlobals();
  });

  /** A DELETE with a signed session cookie. */
  function buildDelete(body: unknown) {
    return authedRequest({ method: "DELETE", body: JSON.stringify(body) }, "http://localhost/api/inferenceservices");
  }

  it("deletes the named service in its own namespace", async () => {
    const { DELETE } = await importRoute();
    const res = await DELETE(await buildDelete({ namespace: "project-a", name: "dsv4-flash-pd" }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Named, not selected: the console holds the composite namespace/name, and
    // a bare name would delete the wrong namespace's service.
    expect(deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "ai.cubestack.io",
        version: "v1alpha1",
        namespace: "project-a",
        plural: "inferenceservices",
        name: "dsv4-flash-pd",
      }),
    );
  });

  it("rejects a DELETE without namespace or name", async () => {
    const { DELETE } = await importRoute();
    const res = await DELETE(await buildDelete({ namespace: "project-a" }), undefined);
    expect(res.status).toBe(400);
    expect(deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("answers 404 with the name it could not find", async () => {
    // Deleting something already gone is not an error the user can act on, but
    // it must not read as a success either: the console says which name it was.
    const gone = new Error("not found") as Error & { statusCode: number };
    gone.statusCode = 404;
    deleteNamespacedCustomObject.mockRejectedValue(gone);
    const { DELETE } = await importRoute();
    const res = await DELETE(await buildDelete({ namespace: "project-a", name: "dsv4-flash-pd" }), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nameMissing", params: { name: "dsv4-flash-pd" }, status: 404 });
  });

  it("returns a client-safe 500 when the delete call fails", async () => {
    deleteNamespacedCustomObject.mockRejectedValue(new Error("boom"));
    const { DELETE } = await importRoute();
    const res = await DELETE(await buildDelete({ namespace: "project-a", name: "dsv4-flash-pd" }), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to delete inference service", status: 500 });
  });
});