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
    models: [{ name: "glm-5.2-chat", endpoint: "http://gw:8080/v1", credentialRef: { name: "llm-glm-5.2-chat" } }],
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

  it("appends a public model to the template (no Secret, no credentialRef)", async () => {
    const res = await POST(
      await post({ name: "Local Qwen", endpoint: "http://llm.local:8080/v1/chat/completions", public: true }),
      undefined,
    );
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ plural?: string; name?: string; body?: unknown[] }];
    expect(init.plural).toBe("agenttemplates");
    expect(init.name).toBe("cubepilot");
    expect(init.body).toEqual([
      { op: "add", path: "/spec/models/-", value: { name: "local-qwen", endpoint: "http://llm.local:8080/v1" } },
    ]);
    expect(createNamespacedSecret).not.toHaveBeenCalled();
  });

  it("creates the credential Secret for a keyed model and references it only", async () => {
    const res = await POST(await post({ name: "kimi", endpoint: "https://api.moonshot.cn/v1", apiKey: "sk-secret" }), undefined);
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: Array<{ value?: { credentialRef?: { name?: string } } }> }];
    expect(init.body?.[0]?.value).toEqual({
      name: "kimi",
      endpoint: "https://api.moonshot.cn/v1",
      credentialRef: { name: "llm-kimi" },
    });
    const [secret] = createNamespacedSecret.mock.calls[0] as [{ namespace?: string; body?: { metadata?: { name?: string }; data?: Record<string, string> } }];
    expect(secret.namespace).toBe("cubestack-system");
    expect(secret.body?.metadata?.name).toBe("llm-kimi");
    // base64("sk-secret") — the key never reaches the CR.
    expect(secret.body?.data?.apiKey).toBe("c2stc2VjcmV0");
  });

  it("writes the whole models array when the template has none yet", async () => {
    mockK8s({ metadata: { name: "cubepilot" }, spec: {} });
    await POST(await post({ name: "first", endpoint: "https://x/v1", public: true }), undefined);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([
      { op: "add", path: "/spec/models", value: [{ name: "first", endpoint: "https://x/v1" }] },
    ]);
  });

  it("409s on a duplicate name", async () => {
    mockK8s({ metadata: { name: "cubepilot" }, spec: { models: [{ name: "kimi", endpoint: "https://x/v1" }] } });
    const res = await POST(await post({ name: "kimi", endpoint: "https://y/v1", public: true }), undefined);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already exists");
  });

  it("validates name, endpoint and the apiKey/public pair", async () => {
    expect((await POST(await post({ name: " ", endpoint: "https://x/v1", public: true }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "nope", public: true }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "https://x/v1" }), undefined)).status).toBe(400);
    expect((await POST(await post({ name: "a", endpoint: "https://x/v1", apiKey: "k", public: true }), undefined)).status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a name that cannot name a Secret, before touching the template", async () => {
    const res = await POST(await post({ name: "a..b", endpoint: "https://x/v1", public: true }), undefined);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("does not yield a valid Secret name");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rolls the model back when the credential cannot be written", async () => {
    // The re-read after the failed write sees the entry the first patch added.
    const withModel = {
      metadata: { name: "cubepilot", resourceVersion: "1000" },
      spec: {
        models: [...TEMPLATE_CR.spec.models, { name: "kimi", endpoint: "https://api.moonshot.cn/v1", credentialRef: { name: "llm-kimi" } }],
      },
    };
    getNamespacedCustomObject.mockResolvedValueOnce(TEMPLATE_CR).mockResolvedValue(withModel);
    createNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const res = await POST(await post({ name: "kimi", endpoint: "https://api.moonshot.cn/v1", apiKey: "sk-1" }), undefined);
    expect(res.status).toBe(502);
    // A model without its Secret is selectable and then fails every turn, so the
    // entry goes away again — but only while the template still holds the state
    // this request wrote, hence the version test.
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ body?: unknown[] }]>;
    expect(calls[calls.length - 1][0].body).toEqual([
      { op: "test", path: "/metadata/resourceVersion", value: "1000" },
      { op: "remove", path: "/spec/models/1" },
    ]);
  });

  it("reports the credential failure when the rollback is refused", async () => {
    const withModel = {
      metadata: { name: "cubepilot", resourceVersion: "1000" },
      spec: {
        models: [...TEMPLATE_CR.spec.models, { name: "kimi", endpoint: "https://api.moonshot.cn/v1", credentialRef: { name: "llm-kimi" } }],
      },
    };
    getNamespacedCustomObject.mockResolvedValueOnce(TEMPLATE_CR).mockResolvedValue(withModel);
    createNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    // The API server rejects the version test: someone patched the template
    // after our model write, so the entry under that index is no longer ours.
    patchNamespacedCustomObject
      .mockResolvedValueOnce(TEMPLATE_CR)
      .mockRejectedValueOnce(Object.assign(new Error("test failed"), { statusCode: 409 }));
    const res = await POST(await post({ name: "kimi", endpoint: "https://api.moonshot.cn/v1", apiKey: "sk-1" }), undefined);
    expect(res.status).toBe(502);
    expect(patchNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it("refuses to rename an existing model", async () => {
    const res = await PUT(await put({ name: "other", endpoint: "https://x/v1", public: true }), ctx("glm-5.2-chat"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("immutable");
  });

  it("edits the endpoint, keyed → public removing the owned Secret", async () => {
    const res = await PUT(await put({ endpoint: "https://new/v1", public: true }), ctx("glm-5.2-chat"));
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([
      { op: "replace", path: "/spec/models/0/endpoint", value: "https://new/v1" },
      { op: "remove", path: "/spec/models/0/credentialRef" },
    ]);
    expect(deleteNamespacedSecret).toHaveBeenCalledWith({ name: "llm-glm-5.2-chat", namespace: "cubestack-system" });
  });

  it("keeps the stored credential when a keyed edit omits the key", async () => {
    const res = await PUT(await put({ endpoint: "https://same-key/v1", apiKey: "", public: false }), ctx("glm-5.2-chat"));
    expect(res.status).toBe(200);
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([{ op: "replace", path: "/spec/models/0/endpoint", value: "https://same-key/v1" }]);
    expect(patchNamespacedSecret).not.toHaveBeenCalled();
  });

  it("refreshes the Secret when a keyed edit carries a new key", async () => {
    // The Secret already exists (create → 409), so the key is refreshed in place.
    createNamespacedSecret.mockRejectedValueOnce(Object.assign(new Error("already exists"), { statusCode: 409 }));
    await PUT(await put({ endpoint: "https://new/v1", apiKey: "sk-2", public: false }), ctx("glm-5.2-chat"));
    const [secret] = patchNamespacedSecret.mock.calls[0] as [{ name?: string; body?: { data?: Record<string, string> } }];
    expect(secret.name).toBe("llm-glm-5.2-chat");
    expect(secret.body?.data?.apiKey).toBe("c2stMg==");
  });

  it("restores the previous entry when the credential write fails", async () => {
    // The Secret refresh is refused after the template already changed.
    createNamespacedSecret.mockRejectedValueOnce(Object.assign(new Error("already exists"), { statusCode: 409 }));
    patchNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const res = await PUT(await put({ endpoint: "https://new/v1", apiKey: "sk-2", public: false }), ctx("glm-5.2-chat"));
    expect(res.status).toBe(502);
    // index and `previous` come from the read that preceded the edit, so the
    // restore is only valid for the version our own edit produced.
    const calls = patchNamespacedCustomObject.mock.calls as Array<[{ body?: unknown[] }]>;
    expect(calls[calls.length - 1][0].body).toEqual([
      { op: "test", path: "/metadata/resourceVersion", value: "1000" },
      { op: "replace", path: "/spec/models/0", value: TEMPLATE_CR.spec.models[0] },
    ]);
  });

  it("refuses an edit whose name cannot name a Secret, before patching", async () => {
    const res = await PUT(await put({ endpoint: "https://x/v1", public: true }), ctx("a..b"));
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("removes a model and its owned credential Secret", async () => {
    const res = await DELETE(await bareGet(), ctx("glm-5.2-chat"));
    // bareGet carries no session → 401; the authorised path is exercised below.
    expect(res.status).toBe(401);
    const ok = await DELETE(await authedRequest({ method: "DELETE" }), ctx("glm-5.2-chat"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: "glm-5.2-chat" });
    const [init] = patchNamespacedCustomObject.mock.calls[0] as [{ body?: unknown[] }];
    expect(init.body).toEqual([{ op: "remove", path: "/spec/models/0" }]);
    expect(deleteNamespacedSecret).toHaveBeenCalledWith({ name: "llm-glm-5.2-chat", namespace: "cubestack-system" });
  });

  it("leaves a hand-made credential Secret in place, with a warning", async () => {
    mockK8s({
      metadata: { name: "cubepilot" },
      spec: { models: [{ name: "shared", endpoint: "https://x/v1", credentialRef: { name: "cubepilot-llm" } }] },
    });
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("shared"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warning?: string }).warning).toContain("left in place");
    expect(deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("reports the delete even when the Secret cleanup fails", async () => {
    deleteNamespacedSecret.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("glm-5.2-chat"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted?: string; warning?: string };
    // The model is gone; a Secret left behind is a cleanup problem, not a
    // failed delete.
    expect(body.deleted).toBe("glm-5.2-chat");
    expect(body.warning).toContain("could not be removed");
  });

  it("refuses to delete a model an instance still selects", async () => {
    mockK8s(TEMPLATE_CR, [
      { metadata: { name: "admin-cubepilot" }, spec: { owner: "admin", selectedModel: "glm-5.2-chat", templateRef: "cubepilot" } },
      { metadata: { name: "other-cubepilot" }, spec: { owner: "x", selectedModel: "something-else", templateRef: "cubepilot" } },
    ]);
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("glm-5.2-chat"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("admin-cubepilot");
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("404s an unknown model", async () => {
    const res = await DELETE(await authedRequest({ method: "DELETE" }), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
