import type { DevEnvironmentSummary } from "@/app/api/devenvironments/route";

// Page-level /api/devenvironments payloads, shared by the vitest unit tests and
// the Playwright e2e suite so both assert against the same mock data.

/**
 * A summary with the demo's magnitude but no fabricated status/metrics. The
 * default names a GPU environment — a jupyter environment on the self-authored
 * `base-cuda` image, which runs as account `ubuntu` — so the shared fixture
 * covers a requested accelerator as well as an absent one.
 */
export function devEnvironmentSummary(
  overrides: Partial<DevEnvironmentSummary> = {},
): DevEnvironmentSummary {
  return {
    name: "jupyter-nlp-ln",
    namespace: "project-a",
    createdAt: "2026-09-01T06:12:00Z",
    type: "jupyter",
    image: "harbor.isuanova.com/suanova/base-cuda:latest",
    running: true,
    resources: { gpu: { vendor: "nvidia", count: 1 }, cpu: "16", memory: "64Gi" },
    storage: { size: "200Gi", mountPath: "/home/ubuntu" },
    idleTimeout: 3600,
    sshEnabled: false,
    phase: "Running",
    phaseReason: null,
    endpoints: [{ name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-nlp-ln" }],
    conditions: [
      { type: "PodScheduled", status: "True", reason: "Scheduled", message: "" },
      { type: "Ready", status: "True", reason: "Running", message: "" },
    ],
    sshClientKeySecret: "jupyter-nlp-ln-ssh-client-key",
    ...overrides,
  };
}

/**
 * A list of two environments: one running with a GPU, one stopped without —
 * `resources.gpu: null` is how an environment that requests no accelerator
 * projects, and it is the case the CPU images are used in.
 */
export function devEnvironmentList(): DevEnvironmentSummary[] {
  return [
    devEnvironmentSummary(),
    devEnvironmentSummary({
      name: "ssh-dataset-prep",
      type: "ssh",
      image: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest",
      running: false,
      resources: { gpu: null, cpu: "32", memory: "128Gi" },
      storage: { size: "500Gi", mountPath: "/home/ubuntu" },
      idleTimeout: 0,
      phase: "Stopped",
      endpoints: [],
      conditions: [],
      sshClientKeySecret: null,
      createdAt: "2026-08-30T12:00:00Z",
    }),
  ];
}
