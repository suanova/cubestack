import type { DevEnvironmentSummary } from "@/app/api/devenvironments/route";

// Page-level /api/devenvironments payloads, shared by the vitest unit tests and
// the Playwright e2e suite so both assert against the same mock data.

/** A summary with the demo's magnitude but no fabricated status/metrics. */
export function devEnvironmentSummary(
  overrides: Partial<DevEnvironmentSummary> = {},
): DevEnvironmentSummary {
  return {
    name: "jupyter-nlp-ln",
    namespace: "project-a",
    createdAt: "2026-09-01T06:12:00Z",
    type: "jupyter",
    image: "base-cuda-12.4:v1.6",
    running: true,
    resources: { gpuType: "nvidia", gpuCount: 1, cpu: "16", memory: "64Gi" },
    storage: { size: "200Gi", mountPath: "/workspace" },
    idleTimeout: 3600,
    sshEnabled: false,
    phase: "Running",
    phaseReason: null,
    endpoints: [{ name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-nlp-ln" }],
    conditions: [
      { type: "PodScheduled", status: "True", reason: "Scheduled", message: "" },
      { type: "Ready", status: "True", reason: "Running", message: "" },
    ],
    sshKeysSecret: null,
    ...overrides,
  };
}

/** A list of two environments: one running, one stopped. */
export function devEnvironmentList(): DevEnvironmentSummary[] {
  return [
    devEnvironmentSummary(),
    devEnvironmentSummary({
      name: "ssh-dataset-prep",
      type: "ssh",
      image: "base-cuda-12.1:v1.6",
      running: false,
      resources: { gpuType: "nvidia", gpuCount: 1, cpu: "16", memory: "64Gi" },
      storage: { size: "500Gi", mountPath: "/workspace" },
      idleTimeout: 0,
      phase: "Stopped",
      endpoints: [],
      conditions: [],
      createdAt: "2026-08-30T12:00:00Z",
    }),
  ];
}