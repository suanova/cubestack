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

const { gatewayFetch, gatewayOpenAiBase } = vi.hoisted(() => ({ gatewayFetch: vi.fn(), gatewayOpenAiBase: vi.fn() }));
vi.mock("@/lib/cubepilot/gateway", () => ({ gatewayFetch, gatewayOpenAiBase }));

/** The model API a save writes into the template. */
const MODEL_API = "http://ai-gateway.envoy-gateway-system.svc:18080/v1";

/** The selection a save writes on the instance: the platform alias plus the
 *  first model the gateway serves. */
const SELECTED_MODEL = "cubestack/qwen38-27b";

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
    // The gateway serves one model by default: a save selects it under the
    // platform alias, and the catalog lists it as a system entry.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "qwen38-27b" }] }), { status: 200 }));
    gatewayOpenAiBase.mockResolvedValue(MODEL_API);
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
        { name: "qwen38-27b", origin: "system" },
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

  it("PUT: first save points the template at the model API, then creates the instance", async () => {
    mockK8s(null);
    const created = {
      metadata: { name: "tester-cubepilot" },
      spec: { owner: "tester", selectedModel: SELECTED_MODEL },
    };
    createNamespacedCustomObject.mockResolvedValue(created);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "be terse" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string } };
    expect(body.config.exists).toBe(true);
    expect(body.config.selectedModel).toBe(SELECTED_MODEL);
    // 1) the template gained the platform model entry pointing at the model API
    const [tplPatch] = patchNamespacedCustomObject.mock.calls[0] as [{ plural?: string; body?: unknown[] }];
    expect(tplPatch.plural).toBe("agenttemplates");
    expect(tplPatch.body).toEqual([
      { op: "add", path: "/spec/models/-", value: { name: "cubestack", endpoint: MODEL_API } },
    ]);
    const [init] = createNamespacedCustomObject.mock.calls[0] as [
      { body?: { metadata?: { name?: string }; spec?: Record<string, unknown> } },
    ];
    expect(init.body?.metadata?.name).toBe("tester-cubepilot");
    const spec = init.body?.spec;
    expect(spec?.owner).toBe("tester");
    expect(spec?.templateRef).toBe("cubepilot");
    expect(spec?.identity).toEqual({ mode: "user", principalRef: { userRef: "tester" } });
    expect(spec?.selectedModel).toBe(SELECTED_MODEL);
  });

  it("PUT: the template is refreshed and the instance forced onto the platform model", async () => {
    mockK8s(INSTANCE_CR);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "deepseek-v4-flash", userInstructions: "" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    // 1) template: the platform entry is appended (the catalog keeps its own
    //    entries), 2) instance: the alias replaces whatever the body asked for.
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; name?: string; body?: unknown[] }]>;
    expect(calls[0][0].plural).toBe("agenttemplates");
    expect(calls[0][0].body).toEqual([
      { op: "add", path: "/spec/models/-", value: { name: "cubestack", endpoint: MODEL_API } },
    ]);
    expect(calls[1][0].plural).toBe("agentinstances");
    expect(calls[1][0].name).toBe("tester-cubepilot");
    expect(calls[1][0].body).toEqual([
      { op: "add", path: "/spec/selectedModel", value: SELECTED_MODEL },
      // "" clears: the field is removed, not written as an empty string.
      { op: "remove", path: "/spec/userInstructions" },
    ]);
  });

  it("PUT: nothing is written when the model API serves no models", async () => {
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    mockK8s(INSTANCE_CR);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("serves no models");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: an up-to-date platform entry is not rewritten", async () => {
    mockK8s(INSTANCE_CR, {
      metadata: { name: "cubepilot" },
      spec: { models: [{ name: "cubestack", endpoint: MODEL_API }] },
    });
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    expect(res.status).toBe(200);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string }]>;
    expect(calls.map((c) => c[0].plural)).toEqual(["agentinstances"]);
  });

  it("PUT: a moved model API rewrites the endpoint and drops a foreign credential", async () => {
    mockK8s(INSTANCE_CR, {
      metadata: { name: "cubepilot" },
      spec: { models: [{ name: "cubestack", endpoint: "http://old:8080/v1", credentialRef: { name: "someone-elses" } }] },
    });
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    expect(calls[0][0].body).toEqual([
      { op: "replace", path: "/spec/models/0/endpoint", value: MODEL_API },
      { op: "remove", path: "/spec/models/0/credentialRef" },
    ]);
  });

  it("PUT: nothing is written when the model API cannot be resolved", async () => {
    gatewayOpenAiBase.mockResolvedValue(null);
    mockK8s(INSTANCE_CR);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("model API");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: nothing is written when the builtin template is missing", async () => {
    mockK8s(INSTANCE_CR, null);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    expect(res.status).toBe(503);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("GET: a missing builtin template is reported, not silently empty", async () => {
    // No gateway models either: the assertion is about the template, and
    // catalog merging is covered by its own test.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
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
