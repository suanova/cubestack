// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const {
  getNamespacedCustomObject,
  patchNamespacedCustomObject,
  listNamespacedCustomObject,
  createNamespacedSecret,
  patchNamespacedSecret,
  deleteNamespacedSecret,
} = vi.hoisted(() => ({
    getNamespacedCustomObject: vi.fn(),
    patchNamespacedCustomObject: vi.fn(),
    listNamespacedCustomObject: vi.fn(),
    createNamespacedSecret: vi.fn(),
    patchNamespacedSecret: vi.fn(),
    deleteNamespacedSecret: vi.fn(),
  }));

vi.mock("@/lib/kubernetes", () => ({
  getCustomObjectsClient: () => ({ getNamespacedCustomObject, patchNamespacedCustomObject, listNamespacedCustomObject }),
  getCoreClient: () => ({ createNamespacedSecret, patchNamespacedSecret, deleteNamespacedSecret }),
}));

const { POST } = await import("./route");
const { PUT, DELETE } = await import("./[name]/route");

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

const TEMPLATE_CR = {
  metadata: { name: "cubepilot", resourceVersion: "1000" },
  spec: {
    runtime: "OpenClaw",
    providers: [
      { name: "deepseek", endpoint: "http://gw:8080/v1", models: ["deepseek-chat"], credentialRef: { name: "llm-deepseek" } },
    ],
  },
};

function mockK8s(template: unknown | null = TEMPLATE_CR, instances: unknown[] = []): void {
  getNamespacedCustomObject.mockImplementation(() => (template ? Promise.resolve(template) : Promise.reject(Object.assign(new Error("not found"), { statusCode: 404 }))));
  listNamespacedCustomObject.mockResolvedValue({ items: instances });
  patchNamespacedCustomObject.mockResolvedValue(template);
  createNamespacedSecret.mockResolvedValue({});
  patchNamespacedSecret.mockResolvedValue({});
  deleteNamespacedSecret.mockResolvedValue({});
}

const post = (body: unknown) => authedRequest({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown) => authedRequest({ method: "PUT", body: JSON.stringify(body) });

describe("/api/cubepilot/agent/llms", () => {
  beforeEach(() => {
    process.env.CUBESTACK_TASKS_NAMESPACE = "cubestack-system";
    vi.clearAllMocks();
    mockK8s();
  });

  afterEach(() => {
    delete process.env.CUBESTACK_TASKS_NAMESPACE;
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await POST(await bareGet(), undefined)).status).toBe(401);
  });

  it("appends a public provider to the template (no Secret, no credentialRef)", async () => {
    const res = await POST(
      await post({
        name: "VLLM Proxy",
        endpoint: "http://llm.local:8080/v1/chat/completions",
        models: ["qwen3-32b", " qwen3-32b ", "llama-4"],
        public: true,
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ plural?: string; name?: string; body?: unknown[] }];
    expect(init.plural).toBe("agenttemplates");
    expect(init.name).toBe("cubepilot");
    // The name is sanitized to a label and the ids are trimmed + de-duplicated.
    expect(init.body).toEqual([
      {
        op: "add",
        path: "/spec/providers/-",
        value: { name: "vllm-proxy", endpoint: "http://llm.local:8080/v1", models: ["qwen3-32b", "llama-4"] },
      },
    ]);
    expect(createNamespacedSecret).not.toHaveBeenCalled();
  });

  it("creates the credential Secret for a keyed provider and references it only", async () => {
    const res = await POST(
      await post({ name: "kimi", endpoint: "https://api.moonshot.cn/v1", models: ["kimi-k2"], apiKey: "sk-secret" }),
      undefined,
    );
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: Array<{ value?: unknown }> }];
    expect(init.body?.[0]?.value).toEqual({
      name: "kimi",
      endpoint: "https://api.moonshot.cn/v1",
      models: ["kimi-k2"],
      credentialRef: { name: "llm-kimi" },
    });
    const [secret] = createNamespacedSecret.mock.calls[0] as [{ namespace?: string; body?: { metadata?: { name?: string }; data?: Record<string, string> } }];
    expect(secret.namespace).toBe("cubestack-system");
    expect(secret.body?.metadata?.name).toBe("llm-kimi");
    // base64("sk-secret") — the key never reaches the CR.
    expect(secret.body?.data?.apiKey).toBe("c2stc2VjcmV0");
  });

  it("writes the whole providers array when the template has none yet", async () => {
    mockK8s({ metadata: { name: "cubepilot" }, spec: {} });
    await POST(await post({ name: "first", endpoint: "https://x/v1", models: ["m"], public: true }), undefined);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([
      { op: "add", path: "/spec/providers", value: [{ name: "first", endpoint: "https://x/v1", models: ["m"] }] },
    ]);
  });

  it("409s on a duplicate provider name", async () => {
    mockK8s({ metadata: { name: "cubepilot" }, spec: { providers: [{ name: "kimi", endpoint: "https://x/v1", models: ["m"] }] } });
    const res = await POST(await post({ name: "kimi", endpoint: "https://y/v1", models: ["m"], public: true }), undefined);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already exists");
  });

  it("refuses a 33rd provider before the API server does", async () => {
    const providers = Array.from({ length: 32 }, (_, i) => ({ name: `p${i}`, endpoint: "https://x/v1", models: ["m"] }));
    mockK8s({ metadata: { name: "cubepilot" }, spec: { providers } });
    const res = await POST(await post({ name: "extra", endpoint: "https://y/v1", models: ["m"], public: true }), undefined);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("at most 32");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("validates name, endpoint, model ids and the apiKey/public pair", async () => {
    // Empty name / bad URL / no model ids / no credential.
    expect((await POST(await post({ name: " ", endpoint: "https://x/v1", models: ["m"], public: true }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "nope", models: ["m"], public: true }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "https://x/v1", models: [], public: true }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "https://x/v1", models: ["*"], public: true }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "https://x/v1", models: ["m"] }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "https://x/v1", models: ["m"], apiKey: "k", public: true }), undefined)).status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a name that cannot name a k8s object, before touching the template", async () => {
    // A "." does not survive the label sanitizer, so the name stays usable; the
    // refusal here is an id the CRD's CEL rule refuses.
    const res = await POST(await post({ name: "a", endpoint: "https://x/v1", models: ["a//b"], public: true }), undefined);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unusable");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("refuses a models value that is not an array of strings (POST and PUT)", async () => {
    // A bare string would otherwise iterate per character ("abc" → a, b, c) and
    // a non-array would throw outside the route's try blocks.
    const postRes = await POST(await post({ name: "a", endpoint: "https://x/v1", models: "abc", public: true }), undefined);
    expect(postRes.status).toBe(400);
    expect(((await postRes.json()) as { error: string }).error).toContain("array of model id strings");
    const putRes = await PUT(await put({ endpoint: "https://x/v1", models: [1, 2] }), ctx("deepseek"));
    expect(putRes.status).toBe(400);
    expect(((await putRes.json()) as { error: string }).error).toContain("array of model id strings");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rolls the provider back when the credential cannot be written", async () => {
    // The re-read after the failed write sees the entry the first patch added.
    const withProvider = {
      metadata: { name: "cubepilot", resourceVersion: "1000" },
      spec: {
        providers: [...TEMPLATE_CR.spec.providers, { name: "kimi", endpoint: "https://api.moonshot.cn/v1", models: ["kimi-k2"], credentialRef: { name: "llm-kimi" } }],
      },
    };
    getNamespacedCustomObject.mockResolvedValueOnce(TEMPLATE_CR).mockResolvedValue(withProvider);
    createNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const res = await POST(await post({ name: "kimi", endpoint: "https://api.moonshot.cn/v1", models: ["kimi-k2"], apiKey: "sk-1" }), undefined);
    expect(res.status).toBe(502);
    // A provider without its Secret is selectable and then fails every turn, so
    // the entry goes away again — but only while the template still holds the
    // state this request wrote, hence the version test.
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ body?: unknown[] }]>;
    expect(calls[calls.length - 1][0].body).toEqual([
      { op: "test", path: "/metadata/resourceVersion", value: "1000" },
      { op: "remove", path: "/spec/providers/1" },
    ]);
  });

  it("reports the credential failure when the rollback is refused", async () => {
    const withProvider = {
      metadata: { name: "cubepilot", resourceVersion: "1000" },
      spec: {
        providers: [...TEMPLATE_CR.spec.providers, { name: "kimi", endpoint: "https://api.moonshot.cn/v1", models: ["kimi-k2"], credentialRef: { name: "llm-kimi" } }],
      },
    };
    getNamespacedCustomObject.mockResolvedValueOnce(TEMPLATE_CR).mockResolvedValue(withProvider);
    createNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    // The API server rejects the version test: someone patched the template
    // after our provider write, so the entry under that index is no longer ours.
    patchNamespacedCustomObject
      .mockResolvedValueOnce(TEMPLATE_CR)
      .mockRejectedValueOnce(Object.assign(new Error("test failed"), { statusCode: 409 }));
    const res = await POST(await post({ name: "kimi", endpoint: "https://api.moonshot.cn/v1", models: ["kimi-k2"], apiKey: "sk-1" }), undefined);
    expect(res.status).toBe(502);
    expect(patchNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it("refuses to rename an existing provider", async () => {
    const res = await PUT(await put({ name: "other", endpoint: "https://x/v1", models: ["m"], public: true }), ctx("deepseek"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("immutable");
  });

  it("edits the endpoint and the model list, keyed → public removing the owned Secret", async () => {
    const res = await PUT(await put({ endpoint: "https://new/v1", models: ["deepseek-chat", "deepseek-reasoner"], public: true }), ctx("deepseek"));
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([
      { op: "replace", path: "/spec/providers/0/endpoint", value: "https://new/v1" },
      { op: "replace", path: "/spec/providers/0/models", value: ["deepseek-chat", "deepseek-reasoner"] },
      { op: "remove", path: "/spec/providers/0/credentialRef" },
    ]);
    expect(deleteNamespacedSecret).toHaveBeenCalledWith({ name: "llm-deepseek", namespace: "cubestack-system" });
  });

  it("skips the model-list op when the ids are unchanged", async () => {
    await PUT(await put({ endpoint: "https://new/v1", models: ["deepseek-chat"], public: true }), ctx("deepseek"));
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([
      { op: "replace", path: "/spec/providers/0/endpoint", value: "https://new/v1" },
      { op: "remove", path: "/spec/providers/0/credentialRef" },
    ]);
  });

  it("refuses to drop model ids that an instance still selects (PUT)", async () => {
    // Replacing deepseek-chat with another id drops the ref the instance runs.
    mockK8s(TEMPLATE_CR, [
      { metadata: { name: "admin-cubepilot" }, spec: { owner: "admin", selectedModel: "deepseek/deepseek-chat", templateRef: "cubepilot" } },
      { metadata: { name: "other-cubepilot" }, spec: { owner: "x", selectedModel: "something-else", templateRef: "cubepilot" } },
    ]);
    const res = await PUT(await put({ endpoint: "https://new/v1", models: ["deepseek-reasoner"], public: true }), ctx("deepseek"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("admin-cubepilot");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("drops model ids no instance selects (PUT)", async () => {
    const res = await PUT(await put({ endpoint: "https://new/v1", models: ["deepseek-reasoner"], public: true }), ctx("deepseek"));
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([
      { op: "replace", path: "/spec/providers/0/endpoint", value: "https://new/v1" },
      { op: "replace", path: "/spec/providers/0/models", value: ["deepseek-reasoner"] },
      { op: "remove", path: "/spec/providers/0/credentialRef" },
    ]);
  });

  it("keeps the stored credential when a keyed edit omits the key", async () => {
    const res = await PUT(await put({ endpoint: "https://same-key/v1", models: ["deepseek-chat"], apiKey: "", public: false }), ctx("deepseek"));
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([{ op: "replace", path: "/spec/providers/0/endpoint", value: "https://same-key/v1" }]);
    expect(patchNamespacedSecret).not.toHaveBeenCalled();
  });

  it("refreshes the Secret when a keyed edit carries a new key", async () => {
    // The Secret already exists (create → 409), so the key is refreshed in place.
    createNamespacedSecret.mockRejectedValueOnce(Object.assign(new Error("already exists"), { statusCode: 409 }));
    await PUT(await put({ endpoint: "https://new/v1", models: ["deepseek-chat"], apiKey: "sk-2", public: false }), ctx("deepseek"));
    const [secret] = patchNamespacedSecret.mock.calls[0] as [{ name?: string; body?: { data?: Record<string, string> } }];
    expect(secret.name).toBe("llm-deepseek");
    expect(secret.body?.data?.apiKey).toBe("c2stMg==");
  });

  it("restores the previous provider when the credential write fails", async () => {
    // The Secret refresh is refused after the template already changed.
    createNamespacedSecret.mockRejectedValueOnce(Object.assign(new Error("already exists"), { statusCode: 409 }));
    patchNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const res = await PUT(await put({ endpoint: "https://new/v1", models: ["deepseek-chat"], apiKey: "sk-2", public: false }), ctx("deepseek"));
    expect(res.status).toBe(502);
    // index and `previous` come from the read that preceded the edit, so the
    // restore is only valid for the version our own edit produced.
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ body?: unknown[] }]>;
    expect(calls[calls.length - 1][0].body).toEqual([
      { op: "test", path: "/metadata/resourceVersion", value: "1000" },
      { op: "replace", path: "/spec/providers/0", value: TEMPLATE_CR.spec.providers[0] },
    ]);
  });

  it("removes a provider and its owned credential Secret", async () => {
    const res = await DELETE(await bareGet(), ctx("deepseek"));
    // bareGet carries no session → 401; the authorised path is exercised below.
    expect(res.status).toBe(401);
    const ok = await DELETE(await authedRequest({ method: "DELETE" }), ctx("deepseek"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: "deepseek" });
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([{ op: "remove", path: "/spec/providers/0" }]);
    expect(deleteNamespacedSecret).toHaveBeenCalledWith({ name: "llm-deepseek", namespace: "cubestack-system" });
  });

  it("leaves a hand-made credential Secret in place, with a warning", async () => {
    mockK8s({
      metadata: { name: "cubepilot" },
      spec: { providers: [{ name: "shared", endpoint: "https://x/v1", models: ["m"], credentialRef: { name: "cubepilot-llm" } }] },
    });
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("shared"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warning?: string }).warning).toContain("left in place");
    expect(deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("reports the delete even when the Secret cleanup fails", async () => {
    deleteNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("deepseek"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted?: string; warning?: string };
    // The provider is gone; a Secret left behind is a cleanup problem, not a
    // failed delete.
    expect(body.deleted).toBe("deepseek");
    expect(body.warning).toContain("could not be removed");
  });

  it("refuses to delete a provider one of whose refs an instance still selects", async () => {
    mockK8s(TEMPLATE_CR, [
      { metadata: { name: "admin-cubepilot" }, spec: { owner: "admin", selectedModel: "deepseek/deepseek-chat", templateRef: "cubepilot" } },
      { metadata: { name: "other-cubepilot" }, spec: { owner: "x", selectedModel: "something-else", templateRef: "cubepilot" } },
    ]);
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("deepseek"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("admin-cubepilot");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("404s an unknown provider", async () => {
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
