// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet } from "@/test/auth";

const { listNode, listClusterCustomObject } = vi.hoisted(() => ({
  listNode: vi.fn(),
  listClusterCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNode }),
  getCustomObjectsClient: () => ({ listClusterCustomObject }),
}));

const STEP = 1800;
const POINTS = 48;

function trendResult(now: number) {
  const start = now - POINTS * STEP;
  return {
    status: "success",
    data: {
      result: [
        {
          metric: {},
          // Three real points then gaps; the route pads to 48 with the last value.
          values: [
            [start, "10"],
            [start + STEP, "20"],
            [start + 2 * STEP, "30"],
          ],
        },
      ],
    },
  };
}

function stubPrometheus(payload: object | null) {
  if (payload === null) {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connection refused"))));
    return;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    })),
  );
}

/** The operator CR fixtures: 2 vendors / 20 cards, 2 isvc, 3 devenv, 1 profile. */
function stubCluster() {
  listNode.mockResolvedValue({
    items: [
      {
        status: {
          nodeInfo: { kubeletVersion: "v1.29.3" },
          conditions: [{ type: "Ready", status: "True" }],
          allocatable: { "nvidia.com/gpu": "16" },
        },
      },
      {
        status: {
          conditions: [{ type: "Ready", status: "True" }],
          allocatable: { "metax-tech.com/gpu": "4" },
          capacity: { "metax-tech.com/gpu": "4" },
        },
      },
      {
        status: {
          conditions: [{ type: "Ready", status: "False" }],
          allocatable: { cpu: "32" },
        },
      },
    ],
  });

  listClusterCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "inferenceservices") {
      return Promise.resolve({
        items: [
          {
            spec: { profileRef: "profile-a" },
            status: {
              conditions: [{ type: "Ready", status: "True" }],
              roles: [
                { name: "engine", replicas: 2, groupSize: 2 }, // 2 groups x 2 pods x 1 gpu = 4
                { name: "router", replicas: 1, groupSize: null }, // CPU-only role -> 0
              ],
            },
          },
          {
            spec: { profileRef: "profile-a" },
            status: {
              conditions: [{ type: "Progressing", status: "True" }],
              roles: [{ name: "engine", replicas: 4, groupSize: 1 }], // 4 x 1 x 1 = 4
            },
          },
        ],
      });
    }
    if (plural === "devenvironments") {
      return Promise.resolve({
        items: [
          { spec: { resources: { gpuCount: 2 } }, status: { phase: { name: "Running" } } },
          { spec: { resources: { gpuCount: 2 } }, status: { phase: { name: "Running" } } },
          { spec: { resources: { gpuCount: 2 } }, status: { phase: { name: "Stopped" } } },
        ],
      });
    }
    // inferenceruntimeprofiles
    return Promise.resolve({
      items: [
        {
          metadata: { name: "profile-a" },
          spec: {
            roles: [
              { name: "engine", podTemplate: { resources: { gpuPerPod: 1 } } },
              { name: "router", podTemplate: { resources: { gpuPerPod: 0 } } },
            ],
          },
        },
      ],
    });
  });
}

describe("overview route", () => {
  beforeEach(() => {
    stubCluster();
  });

  afterEach(() => {
    listNode.mockReset();
    listClusterCustomObject.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns the full live summary from nodes and the operator CRs", async () => {
    stubPrometheus(trendResult(Math.floor(Date.now() / 1000)));
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      nodes: { total: 3, ready: 2, version: "v1.29" },
      gpu: {
        vendors: 2,
        totalCards: 20, // 16 nvidia + 4 metax
        compute: 6, // all 3 devenv count, stopped included
        inference: 8, // 4 + 4
        allocated: 14,
        free: 6,
      },
      inference: { total: 2, ready: 1, scaling: 1 },
      devenv: { total: 3, running: 2, stopped: 1 },
    });
    // The trend is real Prometheus data: 3 points padded to the 48-bucket chart.
    expect(body.trend.util).toHaveLength(POINTS);
    expect(body.trend.util[0]).toBe(10);
    expect(body.trend.util[2]).toBe(30);
    expect(body.trend.util[POINTS - 1]).toBe(30);
    expect(body.trend.mem).toHaveLength(POINTS);
  });

  it("degrades the trend to null when Prometheus is unreachable, keeping the CR data", async () => {
    stubPrometheus(null);
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trend).toBeNull();
    expect(body.nodes.total).toBe(3);
    expect(body.inference.total).toBe(2);
  });

  it("returns 500 with a client-safe error when the cluster call fails", async () => {
    stubPrometheus(trendResult(Math.floor(Date.now() / 1000)));
    listNode.mockRejectedValue(new Error("boom"));
    const { GET } = await import("./route");
    const res = await GET(await authedGet(), undefined);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load overview" });
  });
});
