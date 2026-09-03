import type { InferenceServiceSummary } from "@/app/api/inferenceservices/route";

// Page-level /api/inferenceservices payloads, shared by the vitest unit tests
// and (potentially) e2e suites so both assert against the same mock data.

/** A summary with the demo's magnitude but no fabricated status/metrics. */
export function inferenceServiceSummary(
  overrides: Partial<InferenceServiceSummary> = {},
): InferenceServiceSummary {
  return {
    name: "dsv4-flash-pd",
    namespace: "project-a",
    profileRef: "metax-sglang-dsv4-pd",
    modelRef: "deepseek-v4-flash-w8a8-v1",
    published: true,
    routeModelName: "dsv4-flash",
    timeoutSeconds: 60,
    createdAt: "2026-09-01T06:12:00Z",
    engine: "sglang",
    engineVersion: "vendor-0.5.12-rc1",
    vendor: "metax",
    gpuModel: "MXC500",
    gpuPerPod: 8,
    modelName: null,
    modelVersion: null,
    overrideNums: { decodeReplicas: 2, prefillReplicas: 1, maxModelLen: 131072 },
    decode: { current: 2, min: 1, max: 16 },
    prefill: { current: 1, min: 1, max: 8 },
    groupSize: { current: 1, enum: [1, 2, 4] },
    ready: null,
    progressing: false,
    conditions: [],
    roles: [],
    internalEndpoint: null,
    publicEndpoint: null,
    metrics: null,
    ...overrides,
  };
}

/** A list of two services mirroring the real KinD cluster, newest first. */
export function inferenceServiceList(): InferenceServiceSummary[] {
  return [
    inferenceServiceSummary({
      name: "dsv4-pro-pd",
      routeModelName: "dsv4-pro",
      modelRef: "deepseek-v4-pro-w8a8-v1",
      createdAt: "2026-09-01T07:55:53Z",
      // The operator-reported public endpoint (a non-default host, to prove the
      // page renders the observed value rather than a hardcoded gateway host).
      publicEndpoint: "https://gw.prod.cubestack.example/v1/models/dsv4-pro",
    }),
    inferenceServiceSummary({}),
  ];
}