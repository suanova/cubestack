// @vitest-environment node
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/lib/i18n/dictionaries";

import { authedRequest, bareGet } from "@/test/auth";

const { getNamespacedCustomObject, listNamespacedSecret } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  listNamespacedSecret: vi.fn(),
}));

// The clients are stubbed; `isNotFound` is the real one, so the 404 path is
// tested against the same function the route calls (see the fixture above for
// why its shape matters).
vi.mock("@/lib/kubernetes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kubernetes")>()),
  getCustomObjectsClient: () => ({ getNamespacedCustomObject }),
  getCoreClient: () => ({ listNamespacedSecret }),
}));

const TOKEN = "fa4040c1b2e34d5f8091aa2b3c4d5e6f";
const ENV_URL = "http://localhost/api/devenvironments/token?namespace=project-a&name=jupyter-nlp-ln";

/** The fixture mirrors the real cluster: the CR points at its own token Secret. */
function stubCluster() {
  getNamespacedCustomObject.mockResolvedValue({
    metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
    status: { jupyterTokenSecret: { name: "jupyter-nlp-ln-jupyter-token", namespace: "project-a" } },
  });
  listNamespacedSecret.mockResolvedValue({
    items: [{ metadata: { name: "jupyter-nlp-ln-jupyter-token" }, data: { token: Buffer.from(TOKEN).toString("base64") } }],
  });
}

/**
 * A failed k8s client call, as @kubernetes/client-node 2.x raises it: its
 * generated `ApiException` carries the status on `.code`. Not `.statusCode` —
 * that is the older shape, and a route that reads it turns every 404 into a 500,
 * which is what the live cluster showed before this fixture matched the client.
 */
function httpError(code: number) {
  return Object.assign(new Error(`HTTP-Code: ${code}`), { code });
}

describe("GET /api/devenvironments/token", () => {
  beforeEach(() => stubCluster());
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns the environment's decoded token and the Secret it came from", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(200);
    // The body is a credential: no cache, anywhere in the path, may keep it.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      token: TOKEN,
      secret: { name: "jupyter-nlp-ln-jupyter-token", namespace: "project-a" },
    });
  });

  it("derives the Secret from the environment, so a caller cannot name one", async () => {
    const { GET } = await import("./route");
    // The query names a Secret, and the route ignores it: what is read is the
    // Secret the CR's own status points at. Otherwise this endpoint would be a
    // way to read any Secret in the cluster by name.
    await GET(
      await authedRequest({ method: "GET" }, `${ENV_URL}&secret=kube-system/service-account-token`),
      undefined,
    );
    expect(listNamespacedSecret).toHaveBeenCalledWith({
      namespace: "project-a",
      fieldSelector: "metadata.name=jupyter-nlp-ln-jupyter-token",
    });
  });

  it("refuses a request that names no environment", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, "http://localhost/api/devenvironments/token?namespace=project-a"), undefined);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "requestInvalid" });
    expect(getNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("answers nameMissing when the environment is gone", async () => {
    getNamespacedCustomObject.mockRejectedValue(httpError(404));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nameMissing", params: { name: "jupyter-nlp-ln" } });
  });

  it("answers tokenMissing for an environment that has published none", async () => {
    // An SSH environment never gets a jupyter token secret.
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "ssh-dataset-prep", namespace: "project-a" },
      status: { phase: { name: "Running" } },
    });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "tokenMissing" });
    expect(listNamespacedSecret).not.toHaveBeenCalled();
  });

  it("answers tokenGone when the Secret the environment names is not there", async () => {
    listNamespacedSecret.mockResolvedValue({ items: [] });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "tokenGone", params: { name: "jupyter-nlp-ln-jupyter-token" } });
  });

  it("answers tokenGone when the Secret carries no token entry", async () => {
    listNamespacedSecret.mockResolvedValue({ items: [{ metadata: { name: "jupyter-nlp-ln-jupyter-token" }, data: { username: "jovyan" } }] });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "tokenGone", params: { name: "jupyter-nlp-ln-jupyter-token" } });
  });

  it("answers tokenUnreadable when the cluster read itself fails", async () => {
    listNamespacedSecret.mockRejectedValue(httpError(500));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "tokenUnreadable" });
  });

  it("rejects a request with no session", async () => {
    const { GET } = await import("./route");
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
  });

  it("has a dictionary sentence for every code it can answer with", async () => {
    // The console builds its message from these codes (lib/api-error.ts), so a
    // code without a `dev.err.<code>` entry reaches the user as the bare word.
    // This scan is that tie — the same guard the sibling routes carry.
    const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
    const codes = [...source.matchAll(/refuse\("(\w+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(5);
    for (const code of new Set(codes)) {
      expect(dictionaries["zh-CN"], `dev.err.${code}`).toHaveProperty(`dev.err.${code}`);
    }
  });

  it("answers with a sentence, not a code, and names what it refused", async () => {
    // The wiring the guard above protects: code → dictionary → rendered text.
    // Rendered from the route's *own* body: a code whose sentence interpolates a
    // name the route does not send reads as "环境 '' 不存在", which is exactly
    // what a hand-built body in a test cannot catch.
    const { validationMessage } = await import("@/lib/api-error");
    const t = (key: keyof typeof dictionaries["zh-CN"], params?: Record<string, string | number>) =>
      String(dictionaries["zh-CN"][key]).replace(/\{(\w+)\}/g, (_m, p) => String(params?.[p] ?? ""));

    getNamespacedCustomObject.mockRejectedValue(httpError(404));
    const { GET } = await import("./route");
    const gone = await (await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined)).json();
    const sentence = validationMessage(t, gone, 404, "dev");
    expect(sentence).toContain("jupyter-nlp-ln");
    expect(sentence).not.toContain("{");

    listNamespacedSecret.mockResolvedValue({ items: [] });
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
      status: { jupyterTokenSecret: { name: "jupyter-nlp-ln-jupyter-token", namespace: "project-a" } },
    });
    const missing = await (await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined)).json();
    const goneSentence = validationMessage(t, missing, 404, "dev");
    expect(goneSentence).toContain("jupyter-nlp-ln-jupyter-token");
    expect(goneSentence).not.toContain("{");
  });
});
