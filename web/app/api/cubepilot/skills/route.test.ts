// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { listNamespacedCustomObject, getNamespacedCustomObject } = vi.hoisted(() => ({
  listNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ listNamespacedCustomObject, getNamespacedCustomObject }),
}));

const { GET } = await import("./route");

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const SKILLS = [
  { metadata: { name: "cluster-inspect" }, spec: { displayName: "集群巡检", visibility: "Platform" }, status: { phase: "Available" } },
  { metadata: { name: "gpu-health" }, spec: { displayName: "GPU 体检", visibility: "Platform" }, status: { phase: "Unreachable" } },
  { metadata: { name: "tenant-tool" }, spec: { displayName: "租户工具", visibility: "Tenant" }, status: { phase: "Available" } },
];

describe("/api/cubepilot/skills", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
    listNamespacedCustomObject.mockResolvedValue({ items: SKILLS });
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("no instance → enabled = the all-enabled baseline", async () => {
    getNamespacedCustomObject.mockImplementation(notFound);
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean; displayName: string }> };
    expect(body.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["cluster-inspect", true],
      ["gpu-health", false],
      ["tenant-tool", false],
    ]);
    expect(body.skills[0].displayName).toBe("集群巡检");
  });

  it("explicit enabledSkills list = allow-set (even over the baseline)", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-cubepilot" },
      spec: { owner: "tester", enabledSkills: ["gpu-health"] },
    });
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(body.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["cluster-inspect", false],
      ["gpu-health", true],
      ["tenant-tool", false],
    ]);
  });

  it("an instance held by another owner does not leak its allow-set", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-cubepilot" },
      // "Tester" is another identity that sanitizes to the same CR name.
      spec: { owner: "Tester", enabledSkills: ["gpu-health"] },
    });
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    // The caller sees the baseline, not the other identity's selection.
    expect(body.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["cluster-inspect", true],
      ["gpu-health", false],
      ["tenant-tool", false],
    ]);
  });
});
