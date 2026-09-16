// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";

const { getNamespacedCustomObject, patchNamespacedCustomObject } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject, patchNamespacedCustomObject }),
}));

const { GET, PUT } = await import("./route");

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const INSTANCE_CR = {
  metadata: { name: "tester-cubepilot" },
  spec: {
    owner: "tester",
    approvalPolicy: "AlwaysAsk",
    allowlist: [{ pattern: "kubectl get" }],
  },
};

/** The instance read after a patch (call #2) returns postPatch when given. */
function mockK8s(instanceCr: unknown | null, postPatch?: unknown): void {
  let instanceCalls = 0;
  getNamespacedCustomObject.mockImplementation(() => {
    if (!instanceCr) return notFound();
    instanceCalls++;
    return Promise.resolve(instanceCalls === 1 ? instanceCr : (postPatch ?? instanceCr));
  });
  patchNamespacedCustomObject.mockResolvedValue(postPatch ?? instanceCr);
}

interface confirmViewBody {
  exists: boolean;
  confirmPolicy: string;
  templatePolicy: string;
  override: string;
  allowlist: Array<{ pattern: string; argPattern?: string; label?: string; owned: boolean }>;
  channel: string;
}

describe("/api/cubepilot/agent/confirm", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("GET: no instance → the default posture with the hardcoded allowlist", async () => {
    mockK8s(null);
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as confirmViewBody;
    expect(body.exists).toBe(false);
    expect(body.confirmPolicy).toBe("Allowlist");
    expect(body.templatePolicy).toBe("Allowlist");
    expect(body.override).toBe("");
    expect(body.channel).toBe("unknown");
    // The platform defaults are hardcoded (never read from a CR): kubectl plus
    // the read-only shell tools, none of them owned.
    expect(body.allowlist.map((r) => r.pattern)).toEqual([
      "kubectl", "ls", "cat", "pwd", "grep", "head", "tail", "wc", "jq", "echo", "printf", "which",
    ]);
    expect(body.allowlist.every((r) => r.owned === false)).toBe(true);
    expect(body.allowlist[0].label).toContain("read-only operations");
    expect(body.allowlist[1].label).toBe("ls — read-only, plain args");
  });

  it("GET: the instance override wins and its own rules follow the defaults", async () => {
    mockK8s(INSTANCE_CR);
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as confirmViewBody;
    expect(body.confirmPolicy).toBe("AlwaysAsk");
    expect(body.override).toBe("AlwaysAsk");
    const owned = body.allowlist.filter((r) => r.owned);
    expect(owned).toEqual([{ pattern: "kubectl get", owned: true }]);
    // Defaults first, then the caller's own rules.
    expect(body.allowlist.slice(12)).toEqual(owned);
  });

  it("PUT: no instance → 409 (provision first)", async () => {
    mockK8s(null);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "AlwaysAsk" }) }), undefined);
    expect(res.status).toBe(409);
  });

  it("PUT: invalid policy → 400", async () => {
    mockK8s(INSTANCE_CR);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "Maybe" }) }), undefined);
    expect(res.status).toBe(400);
  });

  it("PUT: a rule whose pattern is not a string → 400", async () => {
    mockK8s(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ allowlist: [{ pattern: 42 }] }) }),
      undefined,
    );
    expect(res.status).toBe(400);
  });

  it("PUT: persists the owned state and returns the new view", async () => {
    // The view after the patch re-reads the instance; return the patched CR.
    mockK8s(INSTANCE_CR, {
      metadata: { name: "tester-cubepilot" },
      spec: { owner: "tester", approvalPolicy: "", allowlist: [{ pattern: "helm ls" }] },
    });    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "", allowlist: [{ pattern: " helm ls " }] }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ name?: string; body?: unknown[] }];
    expect(init.name).toBe("tester-cubepilot");
    // "" = follow the template: the enum-validated field is removed, not set to
    // an empty string (the CRD rejects "").
    expect(init.body).toEqual([
      { op: "remove", path: "/spec/approvalPolicy" },
      { op: "add", path: "/spec/allowlist", value: [{ pattern: "helm ls" }] },
    ]);
    // Back to the default policy after the reset; the hardcoded defaults are
    // still in the view and only the caller's own rule is owned.
    const body = (await res.json()) as confirmViewBody;
    expect(body.confirmPolicy).toBe("Allowlist");
    expect(body.override).toBe("");
    expect(body.allowlist.filter((r) => r.owned)).toEqual([{ pattern: "helm ls", owned: true }]);
    expect(body.allowlist).toHaveLength(13);
  });

  it("PUT: sanitizes the owned rules (trim, dedupe, drop empty)", async () => {
    mockK8s(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({
        method: "PUT",
        body: JSON.stringify({
          allowlist: [{ pattern: "  helm ls  " }, { pattern: "helm ls" }, { pattern: "   " }, { pattern: "ceph df", argPattern: " -s " }],
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: Array<{ path: string; value: unknown }> }];
    expect(init.body?.find((op) => op.path === "/spec/allowlist")?.value).toEqual([
      { pattern: "helm ls" },
      { pattern: "ceph df", argPattern: "-s" },
    ]);
  });

  it("GET: an instance held by another owner exposes nothing of theirs", async () => {
    mockK8s({
      metadata: { name: "tester-cubepilot" },
      // "Tester" is another identity that sanitizes to the same CR name.
      spec: { owner: "Tester", approvalPolicy: "None", allowlist: [{ pattern: "kubectl get" }] },
    });
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as confirmViewBody;
    expect(res.status).toBe(200);
    expect(body.exists).toBe(false);
    expect(body.override).toBe("");
    expect(body.allowlist.some((r) => r.owned)).toBe(false);
  });

  it("PUT: clearing the policy when no override exists patches nothing", async () => {
    mockK8s({ metadata: { name: "tester-cubepilot" }, spec: { owner: "tester" } });
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "" }) }), undefined);
    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: the policy can be lowered to None", async () => {
    mockK8s(INSTANCE_CR);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "None" }) }), undefined);
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([{ op: "add", path: "/spec/approvalPolicy", value: "None" }]);
  });

  it("PUT: instance owned by someone else → 409", async () => {
    mockK8s({ metadata: { name: "tester-cubepilot" }, spec: { owner: "other" } });
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "None" }) }), undefined);
    expect(res.status).toBe(409);
  });
});
