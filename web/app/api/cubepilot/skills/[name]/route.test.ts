// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const {
  getNamespacedCustomObject,
  listNamespacedCustomObject,
  patchNamespacedCustomObject,
} = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject, listNamespacedCustomObject, patchNamespacedCustomObject }),
}));

const { POST } = await import("./route");

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const SKILLS = [
  { metadata: { name: "cluster-inspect" }, spec: { displayName: "集群巡检", visibility: "Platform" }, status: { phase: "Available" } },
  { metadata: { name: "gpu-health" }, spec: { displayName: "GPU 体检", visibility: "Platform" }, status: { phase: "Unreachable" } },
];

const INSTANCE = (enabledSkills?: string[], owner = "tester") => ({
  metadata: { name: "tester-cubepilot" },
  spec: { owner, ...(enabledSkills ? { enabledSkills } : {}) },
});

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

/** getNamespacedCustomObject serves both skills and the instance; branch by
 *  plural (a skill resolves only for its own name). */
function mockK8s(skill: unknown | null, instance: unknown | null, items: unknown[] = SKILLS): void {
  const skillName = (skill as { metadata?: { name?: string } } | null)?.metadata?.name;
  getNamespacedCustomObject.mockImplementation(({ plural, name }: { plural: string; name: string }) => {
    if (plural === "skills") return skill && name === skillName ? Promise.resolve(skill) : notFound();
    return instance ? Promise.resolve(instance) : notFound();
  });
  listNamespacedCustomObject.mockResolvedValue({ items });
}

const post = async (action: string, name = "cluster-inspect") =>
  POST(
    await authedRequest({ method: "POST", body: JSON.stringify({ action }) }),
    ctx(name),
  );

describe("/api/cubepilot/skills/[name]", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    const res = await POST(await bareGet(), ctx("cluster-inspect"));
    expect(res.status).toBe(401);
  });

  it("unknown skill → 404", async () => {
    mockK8s(null, INSTANCE());
    const res = await post("install", "nope");
    expect(res.status).toBe(404);
  });

  it("install: unreachable skill → 409", async () => {
    mockK8s(SKILLS[1], INSTANCE());
    const res = await POST(
      await authedRequest({ method: "POST", body: JSON.stringify({ action: "install" }) }),
      ctx("gpu-health"),
    );
    expect(res.status).toBe(409);
  });

  it("no instance yet → 409 (provision first)", async () => {
    mockK8s(SKILLS[0], null);
    const res = await post("install");
    expect(res.status).toBe(409);
  });

  it("not the caller's instance → 403", async () => {
    mockK8s(SKILLS[0], INSTANCE(undefined, "other"));
    const res = await post("install");
    expect(res.status).toBe(403);
  });

  it("install on the baseline is a no-op (no patch)", async () => {
    mockK8s(SKILLS[0], INSTANCE());
    const res = await post("install");
    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(body.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["cluster-inspect", true],
      ["gpu-health", false],
    ]);
  });

  it("uninstall on the baseline materializes baseline-minus-one", async () => {
    // A two-skill baseline so the materialized set is non-empty.
    const ceph = { metadata: { name: "ceph" }, spec: { displayName: "Ceph", visibility: "Platform" }, status: { phase: "Available" } };
    mockK8s(SKILLS[0], INSTANCE(), [SKILLS[0], ceph]);
    const res = await post("uninstall");
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ name?: string; body?: unknown[] }];
    expect(init.name).toBe("tester-cubepilot");
    expect(init.body).toEqual([{ op: "add", path: "/spec/enabledSkills", value: ["ceph"] }]);
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(body.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["cluster-inspect", false],
      ["ceph", true],
    ]);
  });

  it("uninstalling the last baseline skill writes nothing (empty set reads back as the baseline)", async () => {
    mockK8s(SKILLS[0], INSTANCE());
    const res = await post("uninstall");
    expect(res.status).toBe(200);
    // baseline = [cluster-inspect]; minus the one is [], identical to the
    // current (absent) list → no patch (same round-trip edge as the reference).
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(body.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["cluster-inspect", true],
      ["gpu-health", false],
    ]);
  });

  it("install into an explicit list appends and persists", async () => {
    mockK8s(SKILLS[0], INSTANCE(["gpu-health"]));
    const res = await post("install");
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ name?: string; body?: unknown[] }];
    expect(init.name).toBe("tester-cubepilot");
    expect(init.body).toEqual([{ op: "add", path: "/spec/enabledSkills", value: ["gpu-health", "cluster-inspect"] }]);
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(body.skills.map((s) => [s.name, s.enabled])).toEqual([
      ["cluster-inspect", true],
      ["gpu-health", true],
    ]);
  });

  it("invalid action → 400", async () => {
    mockK8s(SKILLS[0], INSTANCE());
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ action: "enable" }) }), ctx("cluster-inspect"));
    expect(res.status).toBe(400);
  });
});
