import type { OverviewSummary } from "@/app/api/overview/route";

// Page-level /api/overview payloads, shared by the vitest unit tests and the
// Playwright e2e suites so both assert against the same mock data.

const POINTS = 48;

/** A realistic overview payload with the prototype's demo magnitudes. */
export function overviewSummary(
  overrides: Partial<OverviewSummary> = {},
): OverviewSummary {
  const util = new Array<number>(POINTS).fill(58);
  const mem = new Array<number>(POINTS).fill(52);
  util[POINTS - 1] = 62; // current utilization, matches the KPI foot
  mem[POINTS - 1] = 58; // current memory, matches the KPI foot
  return {
    nodes: { total: 16, ready: 15, version: "v1.29" },
    gpu: { vendors: 2, totalCards: 128, compute: 50, inference: 30, allocated: 80, free: 48 },
    inference: { total: 12, ready: 11, scaling: 1 },
    devenv: { total: 8, running: 5, stopped: 3 },
    trend: { util, mem },
    ...overrides,
  };
}
