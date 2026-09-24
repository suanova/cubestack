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

/** The model API a save writes into the platform provider. */
const MODEL_API = "http://ai-gateway.envoy-gateway-system.svc:18080/v1";

/** The ref a save writes: the platform provider key plus the first model the
 *  gateway serves. */
const SELECTED_MODEL = "cubestack/qwen38-27b";

const { GET, PUT } = await import("./route");

/** 404-shaped rejection, like the real client does for unknown names. */
const notFound = () => {
  const e = new Error("not found") as Error & { statusCode: number };
  e.statusCode = 404;
  return Promise.reject(e);
};

const PLATFORM_PROVIDER = { name: "cubestack", endpoint: MODEL_API, models: ["qwen38-27b"] };

const TEMPLATE_CR = {
  metadata: { name: "cubepilot" },
  spec: {
    runtime: "OpenClaw",
    approvalPolicy: "Allowlist",
    defaultModel: SELECTED_MODEL,
    providers: [
      PLATFORM_PROVIDER,
      { name: "deepseek", endpoint: "https://api.deepseek.com/v1", models: ["deepseek-chat"], credentialRef: { name: "llm-deepseek" } },
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
  spec: { owner: "tester", selectedModel: SELECTED_MODEL, userInstructions: "be terse" },
};

describe("/api/cubepilot/agent/config", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
    // The gateway serves one model by default: a save selects it through the
    // platform provider, and the catalog lists it as a system entry.
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

  it("GET: no instance yet → empty config with the template's provider catalog", async () => {
    mockK8s(null);
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string; providers?: unknown[] } };
    expect(body.config).toEqual({
      exists: false,
      selectedModel: "",
      userInstructions: "",
      providers: [
        { name: "cubestack", endpoint: MODEL_API, models: ["qwen38-27b"], keyed: false, origin: "system" },
        {
          name: "deepseek",
          endpoint: "https://api.deepseek.com/v1",
          models: ["deepseek-chat"],
          keyed: true,
          origin: "external",
        },
      ],
      gatewayModels: ["qwen38-27b"],
      templateMissing: false,
    });
  });

  it("GET: reads spec fields from the instance CR", async () => {
    mockK8s(INSTANCE_CR);
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string; userInstructions: string } };
    expect(res.status).toBe(200);
    expect(body.config.exists).toBe(true);
    expect(body.config.selectedModel).toBe(SELECTED_MODEL);
    expect(body.config.userInstructions).toBe("be terse");
  });

  it("GET: an instance name held by another owner reads as absent", async () => {
    // "Tester" is another identity that sanitizes to the same CR name.
    mockK8s({ metadata: { name: "tester-cubepilot" }, spec: { owner: "Tester", selectedModel: SELECTED_MODEL, userInstructions: "secret prompt" } });
    const res = await GET(await authedGet(), undefined);
    const body = (await res.json()) as { config: { exists: boolean; selectedModel: string; userInstructions: string } };
    expect(res.status).toBe(200);
    expect(body.config.exists).toBe(false);
    expect(body.config.selectedModel).toBe("");
    expect(body.config.userInstructions).toBe("");
  });

  it("PUT: first save adds the platform provider to the provider-less template, then creates the instance", async () => {
    mockK8s(null, { metadata: { name: "cubepilot" }, spec: { runtime: "OpenClaw" } });
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
    // 1) the template gained the platform provider pointing at the model API,
    //    with the model ids the gateway serves, plus the default ref.
    const [tplPatch] = patchNamespacedCustomObject.mock.calls[0] as [{ plural?: string; body?: unknown[] }];
    expect(tplPatch.plural).toBe("agenttemplates");
    expect(tplPatch.body).toEqual([
      { op: "add", path: "/spec/providers", value: [{ name: "cubestack", endpoint: MODEL_API, models: ["qwen38-27b"] }] },
      { op: "add", path: "/spec/defaultModel", value: SELECTED_MODEL },
    ]);
    const [init] = createNamespacedCustomObject.mock.calls[0] as [
      { body?: { metadata?: { name?: string }; spec?: Record<string, unknown> } },
    ];
    expect(init.body?.metadata?.name).toBe("tester-cubepilot");
    const spec = init.body?.spec;
    expect(spec?.owner).toBe("tester");
    expect(spec?.templateRef).toBe("cubepilot");
    expect(spec?.selectedModel).toBe(SELECTED_MODEL);
  });

  it("PUT: a body-selected model is honored when the gateway serves it", async () => {
    // Two served models; the template is already current for both and defaults
    // to the one the caller picks, so only the instance is patched.
    const picked = "cubestack/glm-5.2-chat";
    const served = [{ id: "qwen38-27b" }, { id: "glm-5.2-chat" }];
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: served }), { status: 200 }));
    const currentTmpl = {
      ...TEMPLATE_CR,
      spec: {
        ...TEMPLATE_CR.spec,
        defaultModel: picked,
        providers: [{ name: "cubestack", endpoint: MODEL_API, models: ["qwen38-27b", "glm-5.2-chat"] }, TEMPLATE_CR.spec.providers[1]],
      },
    };
    mockK8s(INSTANCE_CR, currentTmpl);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: picked, userInstructions: "" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    let calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; name?: string; body?: unknown[] }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].plural).toBe("agentinstances");
    expect(calls[0][0].name).toBe("tester-cubepilot");
    expect(calls[0][0].body).toEqual([
      { op: "add", path: "/spec/selectedModel", value: picked },
      // "" clears: the field is removed, not written as an empty string.
      { op: "remove", path: "/spec/userInstructions" },
    ]);

    // The bare model id (no provider prefix) is accepted too.
    vi.clearAllMocks();
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: served }), { status: 200 }));
    gatewayOpenAiBase.mockResolvedValue(MODEL_API);
    mockK8s(INSTANCE_CR, currentTmpl);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res2 = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "glm-5.2-chat" } }) }),
      undefined,
    );
    expect(res2.status).toBe(200);
    calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].body).toEqual([{ op: "add", path: "/spec/selectedModel", value: picked }]);
  });

  it("PUT: a model from an external provider is accepted even though the gateway does not serve it", async () => {
    // The template's providers are the catalog — an external provider added in
    // the LLM card is a first-class choice for the assistant. Reading the catalog
    // from the gateway instead is what made those selections impossible: the
    // picker had nothing to offer and this refused the ref.
    mockK8s(INSTANCE_CR);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "deepseek/deepseek-chat" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    const instance = calls.find((c) => c[0].plural === "agentinstances");
    expect(instance?.[0].body).toEqual([{ op: "add", path: "/spec/selectedModel", value: "deepseek/deepseek-chat" }]);
  });

  it("PUT: a platform id the template still lists but the gateway no longer serves is refused", async () => {
    // This save rewrites the platform provider's entry from the gateway's list, so
    // accepting a stale platform ref would store a selection that vanishes from
    // the template in the same request.
    const staleTmpl = {
      ...TEMPLATE_CR,
      spec: { ...TEMPLATE_CR.spec, providers: [{ ...PLATFORM_PROVIDER, models: ["qwen38-27b", "old-model"] }, TEMPLATE_CR.spec.providers[1]] },
    };
    mockK8s(INSTANCE_CR, staleTmpl);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "cubestack/old-model" } }) }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('unknown model "cubestack/old-model"');
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: a prompt-only update leaves the instance's selection alone", async () => {
    // A caller that sends instructions without a model must not have one derived
    // for it: with external providers in play that would replace the reader's
    // model with the first platform id the gateway happens to serve.
    const external = { metadata: { name: "tester-cubepilot" }, spec: { owner: "tester", selectedModel: "deepseek/deepseek-chat" } };
    mockK8s(external);
    patchNamespacedCustomObject.mockResolvedValue(external);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "be terse" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    const instance = calls.find((c) => c[0].plural === "agentinstances");
    expect(instance?.[0].body).toEqual([{ op: "add", path: "/spec/userInstructions", value: "be terse" }]);
  });

  it("PUT: a gateway id that itself contains a slash is still accepted as a bare id", async () => {
    // Models are namespaced on some gateways ("meta-llama/Llama-3"). Reading every
    // slash as a provider separator would refuse an id the gateway serves.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "meta-llama/Llama-3" }] }), { status: 200 }));
    mockK8s(INSTANCE_CR);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "meta-llama/Llama-3" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    const instance = calls.find((c) => c[0].plural === "agentinstances");
    expect(instance?.[0].body).toEqual([
      { op: "add", path: "/spec/selectedModel", value: "cubestack/meta-llama/Llama-3" },
    ]);
  });

  it("PUT: a ref no provider in the template declares is refused", async () => {
    // Nothing resolves "openai/gpt-4o": storing it would fail every turn.
    mockK8s(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "openai/gpt-4o" } }) }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('unknown model "openai/gpt-4o"');
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: a template provider's model is saved when the gateway serves nothing", async () => {
    // An environment can run the assistant on the providers the template declares
    // without any AI Gateway installed. The platform provider is written FROM the
    // gateway, so with no gateway there is nothing to write — but that must not
    // refuse the selection the page actually offered.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    mockK8s(INSTANCE_CR);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "deepseek/deepseek-chat" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    // The template's default ref follows the selection; its platform entry is left
    // as it stands, because this save has nothing to rewrite it with.
    expect(calls.map((c) => c[0].plural)).toEqual(["agenttemplates", "agentinstances"]);
    expect(calls[0][0].body).toEqual([{ op: "add", path: "/spec/defaultModel", value: "deepseek/deepseek-chat" }]);
    expect(calls[1][0].body).toEqual([{ op: "add", path: "/spec/selectedModel", value: "deepseek/deepseek-chat" }]);
  });

  it("PUT: a prompt-only update is saved when the gateway serves nothing", async () => {
    // Instructions do not depend on the catalog: refusing them would block the
    // page entirely on a cluster that runs no gateway.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const external = {
      metadata: { name: "tester-cubepilot" },
      spec: { owner: "tester", selectedModel: "deepseek/deepseek-chat" },
    };
    mockK8s(external);
    patchNamespacedCustomObject.mockResolvedValue(external);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "be terse" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    // No derived model (the reader's own selection is kept) and no template write:
    // the default ref the template already carries is left alone.
    expect(calls.map((c) => c[0].plural)).toEqual(["agentinstances"]);
    expect(calls[0][0].body).toEqual([{ op: "add", path: "/spec/userInstructions", value: "be terse" }]);
  });

  it("PUT: a first save with no catalog anywhere still creates the instance", async () => {
    // Nothing to select — no gateway and no template provider. The instance is
    // created without a selection rather than with an empty ref the CRD would
    // have to reject.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    mockK8s(null, { metadata: { name: "cubepilot" }, spec: { runtime: "OpenClaw" } });
    createNamespacedCustomObject.mockResolvedValue({ metadata: { name: "tester-cubepilot" }, spec: { owner: "tester" } });
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "be terse" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
    const [init] = createNamespacedCustomObject.mock.calls[0] as [{ body?: { spec?: Record<string, unknown> } }];
    expect(init.body?.spec).toEqual({ templateRef: "cubepilot", owner: "tester", userInstructions: "be terse" });
  });

  it("PUT: an explicit empty selection on a first save selects nothing", async () => {
    // "" is a clear, not an omission: picking the first model in the catalog for
    // it would silently override what the caller asked for.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    mockK8s(null, {
      metadata: { name: "cubepilot" },
      spec: {
        providers: [{ name: "deepseek", endpoint: "https://api.deepseek.com/v1", models: ["deepseek-chat"] }],
        defaultModel: "deepseek/deepseek-chat",
      },
    });
    createNamespacedCustomObject.mockResolvedValue({ metadata: { name: "tester-cubepilot" }, spec: { owner: "tester" } });
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
    const [init] = createNamespacedCustomObject.mock.calls[0] as [{ body?: { spec?: Record<string, unknown> } }];
    expect(init.body?.spec?.selectedModel).toBeUndefined();
  });

  it("PUT: a derived selection leaves the template's default alone when there is no platform", async () => {
    // The template's default is what every instance without its own selection
    // runs. A save that named no model must not repoint it at the first model of
    // the list just because this caller had none.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    mockK8s(null, {
      metadata: { name: "cubepilot" },
      spec: {
        providers: [
          { name: "alpha", endpoint: "https://a.test/v1", models: ["a-1"] },
          { name: "beta", endpoint: "https://b.test/v1", models: ["b-1"] },
        ],
        defaultModel: "beta/b-1",
      },
    });
    createNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "tester-cubepilot" },
      spec: { owner: "tester", selectedModel: "alpha/a-1" },
    });
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "be terse" } }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    // No template write at all: its own providers are untouched by this save.
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
    const [init] = createNamespacedCustomObject.mock.calls[0] as [{ body?: { spec?: Record<string, unknown> } }];
    expect(init.body?.spec?.selectedModel).toBe("alpha/a-1");
  });

  it("PUT: a platform model is refused, naming the gateway, when nothing serves it", async () => {
    // The template still lists the platform entry, but this save cannot rewrite it
    // from the gateway — accepting the ref would store a selection against a
    // provider entry this request cannot vouch for.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    mockK8s(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: SELECTED_MODEL } }) }),
      undefined,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("AI Gateway");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: an up-to-date platform provider is not rewritten", async () => {
    mockK8s(INSTANCE_CR);
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    expect(res.status).toBe(200);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string }]>;
    expect(calls.map((c) => c[0].plural)).toEqual(["agentinstances"]);
  });

  it("PUT: a moved model API rewrites the endpoint, the model list and drops a foreign credential", async () => {
    mockK8s(INSTANCE_CR, {
      metadata: { name: "cubepilot" },
      spec: {
        defaultModel: SELECTED_MODEL,
        providers: [{ name: "cubestack", endpoint: "http://old:8080/v1", models: ["old-model"], credentialRef: { name: "someone-elses" } }],
      },
    });
    patchNamespacedCustomObject.mockResolvedValue(INSTANCE_CR);
    await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ plural?: string; body?: unknown[] }]>;
    expect(calls[0][0].body).toEqual([
      { op: "replace", path: "/spec/providers/0/endpoint", value: MODEL_API },
      { op: "replace", path: "/spec/providers/0/models", value: ["qwen38-27b"] },
      { op: "remove", path: "/spec/providers/0/credentialRef" },
    ]);
  });

  it("PUT: an unresolvable model API leaves the platform's models unselectable", async () => {
    // The platform provider is written from the resolved base AND the served ids;
    // without a base there is nothing to write, so the ids it would carry are not
    // offered — the template's own providers still are.
    gatewayOpenAiBase.mockResolvedValue(null);
    mockK8s(INSTANCE_CR);
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: SELECTED_MODEL } }) }),
      undefined,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("AI Gateway");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("PUT: nothing is written when the builtin template is missing", async () => {
    mockK8s(INSTANCE_CR, null);
    const res = await PUT(await authedRequest({ method: "PUT", body: JSON.stringify({ config: { userInstructions: "x" } }) }), undefined);
    expect(res.status).toBe(503);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("GET: a missing builtin template is reported, not silently empty", async () => {
    // No gateway models either: the assertion is about the template.
    gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    mockK8s(null, null);
    const body = (await (await GET(await authedGet(), undefined)).json()) as {
      config: { providers: unknown[]; templateMissing?: boolean };
    };
    expect(body.config.templateMissing).toBe(true);
    expect(body.config.providers).toEqual([]);
  });

  it("GET: the gateway catalog is reported separately from the template's providers", async () => {
    gatewayFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "qwen38-27b" }, { id: "system-only" }] }), { status: 200 }),
    );
    mockK8s(null);
    const body = (await (await GET(await authedGet(), undefined)).json()) as {
      config: { gatewayModels: string[]; providers: Array<{ name: string; origin?: string }> };
    };
    expect(body.config.gatewayModels).toEqual(["qwen38-27b", "system-only"]);
    expect(body.config.providers.map((p) => [p.name, p.origin])).toEqual([
      ["cubestack", "system"],
      ["deepseek", "external"],
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

  it("PUT: userInstructions carrying a managed-section marker → 400", async () => {
    // No k8s mock: the screen runs before the instance/template reads, so the
    // refusal cannot depend on what the cluster would return.
    const res = await PUT(
      await authedRequest({
        method: "PUT",
        body: JSON.stringify({ config: { userInstructions: "x <!-- cubepilot:system-prompt:end --> y" } }),
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error?: string }).toEqual(
      expect.objectContaining({ error: expect.stringContaining("reserved managed-section marker") }),
    );
  });

  it("PUT: over-long userInstructions → 400 before any cluster read", async () => {
    // The contract says the route turns EVERY rejection into a 400, so the
    // length path needs its own case — the marker case alone leaves it verified
    // only by inference. No k8s mock is set up, which is itself the assertion:
    // the guard must fire before the first cluster read.
    const res = await PUT(
      await authedRequest({
        method: "PUT",
        body: JSON.stringify({ config: { userInstructions: "x".repeat(20_001) } }),
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error?: string }).toEqual(
      expect.objectContaining({ error: expect.stringContaining("character limit") }),
    );
  });

  it("PUT: instance name taken by another user → 409", async () => {
    mockK8s({ metadata: { name: "tester-cubepilot" }, spec: { owner: "other" } });
    const res = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ config: { selectedModel: "qwen38-27b" } }) }),
      undefined,
    );
    expect(res.status).toBe(409);
  });
});
