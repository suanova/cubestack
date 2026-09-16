// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";

const {
  getNamespacedCustomObject,
  createNamespacedCustomObject,
  patchNamespacedCustomObject,
} = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  createNamespacedCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({
    getNamespacedCustomObject,
    createNamespacedCustomObject,
    patchNamespacedCustomObject,
  }),
}));

const { gatewayFetch } = vi.hoisted(() => ({ gatewayFetch: vi.fn() }));
vi.mock("@/lib/cubepilot/gateway", () => ({ gatewayFetch }));

const { GET, PUT } = await import("./route");

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const TEMPLATE_CR = {
  metadata: { name: "cubepilot" },
  spec: {
    runtime: "OpenClaw",
    confirmPolicy: "Allowlist",
    models: [
      { name: "glm-5.2-chat", endpoint: "http://ai-gateway.envoy-gateway-system.svc:18080" },
      { name: "deepseek-v4-flash", endpoint: "http://ai-gateway.envoy-gateway-system.svc:18080" },
    ],
  },
};

/** getNamespacedCustomObject is shared by instances and the template; branch on the plural. */
function mockK8s(instanceCr: unknown | null, templateCr: unknown | null = TEMPLATE_CR): void {
  getNamespacedCustomObject.mockImplementation(({ plural }: { plural: string }) => {
    if (plural === "agenttemplates") return templateCr ? Promise.resolve(templateCr) : notFound();
    return instanceCr ? Promise.resolve(instanceCr) : notFound();
  });
}

const INSTANCE_CR = {
  metadata: { name: "tester-cubepilot" },
  spec: { owner: "tester", selectedModel: "glm-5.2-chat", userInstructions: "be terse" },
};

describe("/api/cubepilot/agent/config", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
    // No system catalog by default: an unreachable gateway must never break
    // the page (the template's own models still resolve).
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("GET: no instance yet → empty config with the template's model catalog", async () => {
    mockK8s(null);
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string; models?: unknown[] } };
    expect(body.config).toEqual({
      exists: false,
      selectedModel: "",
      userInstructions: "",
      models: [
        { name: "glm-5.2-chat", endpoint: "http://ai-gateway.envoy-gateway-system.svc:18080", origin: "external", keyed: false },
        { name: "deepseek-v4-flash", endpoint: "http://ai-gateway.envoy-gateway-system.svc:18080", origin: "external", keyed: false },
      ],
      templateMissing: false,
    });
  });

  it("GET: reads spec fields from the instance CR", async () => {
    mockK8s(INSTANCE_CR);
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string; userInstructions: string } };
    expect(res.status).toBe(200);
    expect(body.config.exists).toBe(true);
    expect(body.config.selectedModel).toBe("glm-5.2-chat");
    expect(body.config.userInstructions).toBe("be terse");
  });

  it("GET: an instance name held by another owner reads as absent", async () => {
    // "Tester" is another identity that sanitizes to the same CR name.
    mockK8s({ metadata: { name: "tester-cubepilot" }, spec: { owner: "Tester", selectedModel: "glm-5.2-chat", userInstructions: "secret prompt" } });
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string; userInstructions: string } };
    expect(res.status).toBe(200);
    expect(body.config.exists).toBe(false);
    expect(body.config.selectedModel).toBe("");
    expect(body.config.userInstructions).toBe("");
  });

  it("PUT: first save creates the instance (owner + identity + templateRef)", async () => {
    mockK8s(null);
    const created = {
      metadata: { name: "tester-cubepilot" },
      spec: { owner: "tester", selectedModel: "glm-5.2-chat" },
    };
    createNamespacedCustomObject.mockResolvedValue(created);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "glm-5.2-chat" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string } };
    expect(body.config.exists).toBe(true);
    expect(body.config.selectedModel).toBe("glm-5.2-chat");
    const [init] = createNamespacedCustomObject.mock.calls[0] as [
      { body?: { metadata?: { name?: string }; spec?: Record<string, unknown> } },
    ];
    expect(init.body?.metadata?.name).toBe("tester-cubepilot");
    const spec = init.body?.spec;
    expect(spec?.owner).toBe("tester");
    expect(spec?.templateRef).toBe("cubepilot");
    expect(spec?.identity).toEqual({ mode: "user", principalRef: { userRef: "tester" } });
  });

  it("PUT: existing instance → JSON-Patch add on the changed fields", async () => {
    mockK8s(INSTANCE_CR);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "glm-5.2-chat", userInstructions: "" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ name?: string; body?: unknown[] }];
    expect(init.name).toBe("tester-cubepilot");
    expect(init.body).toEqual([
      { op: "add", path: "/spec/selectedModel", value: "glm-5.2-chat" },
      // "" clears: the field is removed, not written as an empty string.
      { op: "remove", path: "/spec/userInstructions" },
    ]);
  });

  it("GET: a missing builtin template is reported, not silently empty", async () => {
    mockK8s(null, null);
    const body = (await (await GET(await authedGet(), undefined)).json()) as { config: { models: unknown[]; templateMissing?: boolean } };
    expect(body.config.templateMissing).toBe(true);
    expect(body.config.models).toEqual([]);
  });

  it("GET: merges the system catalog after the template's own models", async () => {
    gatewayFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "glm-5.2-chat" }, { id: "system-only" }] }), { status: 200 }),
    );
    mockK8s(null);
    const body = (await (await GET(await authedGet(), undefined)).json()) as { config: { models: Array<{ name: string; origin?: string }> } };
    // The template entry wins for a shared name (it carries endpoint/credential).
    expect(body.config.models.map((m) => [m.name, m.origin])).toEqual([
      ["glm-5.2-chat", "external"],
      ["deepseek-v4-flash", "external"],
      ["system-only", "system"],
    ]);
  });

  it("PUT: a system-catalog model is accepted", async () => {
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "system-only" }] }), { status: 200 }));
    mockK8s(INSTANCE_CR);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "system-only" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
  });

  it("PUT: a model the template does not declare → 400", async () => {
    mockK8s(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "nope" } }) }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('model "nope" is not in the cubepilot template');
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: a template without models accepts only the runtime default", async () => {
    mockK8s(INSTANCE_CR, { metadata: { name: "cubepilot" }, spec: {} });
    const rejected = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "glm-5.2-chat" } }) }),
      undefined,
    );
    expect(rejected.status).toBe(400);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const cleared = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "" } }) }),
      undefined,
    );
    expect(cleared.status).toBe(200);
    expect(patchNamespacedCustomObject.mock.calls[0][0]).toMatchObject({
      body: [{ op: "remove", path: "/spec/selectedModel" }],
    });
  });

  it("PUT: non-string fields → 400", async () => {
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: 42 } }) }),
      undefined,
    );
    expect(res.status).toBe(400);
  });

  it("PUT: invalid JSON → 400", async () => {
    const res = await PUT(await authedRequest({ method: "PUT", body: "not json" }), undefined);
    expect(res.status).toBe(400);
  });

  it("PUT: instance name taken by another user → 409", async () => {
    mockK8s({ metadata: { name: "tester-cubepilot" }, spec: { owner: "other" } });
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "glm-5.2-chat" } }) }),
      undefined,
    );
    expect(res.status).toBe(409);
  });
});
