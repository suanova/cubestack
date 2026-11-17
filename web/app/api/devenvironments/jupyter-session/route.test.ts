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
// tested against the same function the route calls.
vi.mock("@/lib/kubernetes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kubernetes")>()),
  getCustomObjectsClient: () => ({ getNamespacedCustomObject }),
  getCoreClient: () => ({ listNamespacedSecret }),
}));

const TOKEN = "fa4040c1b2e34d5f8091aa2b3c4d5e6f";
// The address the operator publishes: the Gateway's host and the environment's
// own path, which is what the browser will open too.
const BASE = "http://gateway.example.dev:8080/dev/project-a/jupyter-nlp-ln/";
const ENV_URL = "http://localhost/api/devenvironments/jupyter-session?namespace=project-a&name=jupyter-nlp-ln";

/** The fixture mirrors the real cluster: the CR points at its own token Secret. */
function stubCluster() {
  getNamespacedCustomObject.mockResolvedValue({
    metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
    status: {
      jupyterTokenSecret: { name: "jupyter-nlp-ln-jupyter-token", namespace: "project-a" },
      endpoints: [
        { name: "ssh", address: "ssh://ubuntu@203.0.113.7:2200" },
        { name: "jupyter", address: BASE },
      ],
    },
  });
  listNamespacedSecret.mockResolvedValue({
    items: [{ metadata: { name: "jupyter-nlp-ln-jupyter-token" }, data: { token: Buffer.from(TOKEN).toString("base64") } }],
  });
}

/**
 * What Jupyter answers an authenticated page load with: the identity cookie it
 * names after the host and port, the XSRF cookie, and something else the portal
 * has no business storing.
 */
function jupyterAnswer(status = 200, cookies = [
  "username-gateway.example.dev-8080=c2Vzc2lvbjs=; Path=/dev/project-a/jupyter-nlp-ln/; HttpOnly",
  "_xsrf=2|a1b2c3|deadbeef; Path=/",
  "unrelated=1; Path=/",
]) {
  const headers = new Headers({ "content-type": "text/html" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response("<html></html>", { status, headers });
}

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

describe("GET /api/devenvironments/jupyter-session", () => {
  beforeEach(() => {
    stubCluster();
    vi.stubGlobal("fetch", vi.fn(async () => jupyterAnswer()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("signs in with the environment's token in a header and returns the clean URL", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(200);
    // The response installs a session: no cache anywhere in the path keeps it.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ url: `${BASE}lab` });

    expect(fetchMock()).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock().mock.calls[0];
    // The token never enters a URL: nothing on the way — the Gateway's access
    // log, the browser's history — has a copy to keep.
    expect(url).toBe(`${BASE}lab`);
    expect(url).not.toContain(TOKEN);
    // It authenticates in a header instead.
    expect(new Headers(init.headers).get("authorization")).toBe(`token ${TOKEN}`);
    // And the Secret is the one the environment's status names.
    expect(listNamespacedSecret).toHaveBeenCalledWith({
      namespace: "project-a",
      fieldSelector: "metadata.name=jupyter-nlp-ln-jupyter-token",
    });
  });

  it("cannot be pointed at an address of the caller's choosing", async () => {
    const { GET } = await import("./route");
    // A query that names another address is ignored: the endpoint — and with it
    // the destination the token is sent to — comes from the environment's own
    // status, so this route is not a way to hand a credential to a third party.
    await GET(
      await authedRequest({ method: "GET" }, `${ENV_URL}&address=http://evil.example/`),
      undefined,
    );
    expect(fetchMock().mock.calls[0][0]).toBe(`${BASE}lab`);
  });

  it("relays the identity cookie, scoped to the environment's own path", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    const cookies = res.headers.getSetCookie();
    // The page load that follows installs the XSRF cookie itself, so only the
    // identity — the one cookie the browser must arrive with — is relayed.
    expect(cookies).toEqual([
      "username-gateway.example.dev-8080=c2Vzc2lvbjs=; Path=/dev/project-a/jupyter-nlp-ln/; HttpOnly; SameSite=Lax",
    ]);
    // The environment's own attributes are not trusted: the path is rewritten
    // (it lands on the portal's origin, where Path=/ would be every page), and
    // a cookie this origin has no business storing is dropped.
    expect(cookies.join()).not.toContain("unrelated");
    expect(cookies.join()).not.toContain("_xsrf");
  });

  it("marks the cookies Secure when the environment's endpoint is https", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
      status: {
        jupyterTokenSecret: { name: "jupyter-nlp-ln-jupyter-token", namespace: "project-a" },
        endpoints: [{ name: "jupyter", address: "https://gateway.example.dev/dev/project-a/jupyter-nlp-ln/" }],
      },
    });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(200);
    for (const cookie of res.headers.getSetCookie()) expect(cookie).toContain("; Secure");
  });

  it("does not mark the cookies Secure when the endpoint is plain HTTP", async () => {
    // The console is often served over TLS behind an ingress while the Gateway
    // listener is plain HTTP. Secure follows the address the cookie is *sent*
    // to, so it must not be set here — the browser would drop the cookie on
    // the very page it is about to open.
    const { GET } = await import("./route");
    const res = await GET(
      await authedRequest({ method: "GET", headers: { "x-forwarded-proto": "https" } }, ENV_URL),
      undefined,
    );
    expect(res.status).toBe(200);
    for (const cookie of res.headers.getSetCookie()) expect(cookie).not.toContain("; Secure");
  });

  it("refuses a request that names no environment", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      await authedRequest({ method: "GET" }, "http://localhost/api/devenvironments/jupyter-session?namespace=project-a"),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "requestInvalid" });
    expect(getNamespacedCustomObject).not.toHaveBeenCalled();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("rejects a request without a session before reading the cluster", async () => {
    const { GET } = await import("./route");
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
    expect(getNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("answers jupyterMissing for an environment with no jupyter endpoint", async () => {
    // An SSH environment never publishes one.
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "ssh-dataset-prep", namespace: "project-a" },
      status: { jupyterTokenSecret: { name: "ssh-dataset-prep-jupyter-token", namespace: "project-a" }, endpoints: [] },
    });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "jupyterMissing", params: { name: "jupyter-nlp-ln" } });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("answers jupyterLoginFailed when Jupyter sends a page instead of a session", async () => {
    // A 302 to /login is what an unaccepted token looks like; following it
    // would land the user on a form this route cannot fill in.
    vi.stubGlobal("fetch", vi.fn(async () => jupyterAnswer(302, [])));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "jupyterLoginFailed" });
  });

  it("answers jupyterLoginFailed when the page carries no cookie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jupyterAnswer(200, ["unrelated=1; Path=/"])));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "jupyterLoginFailed" });
  });

  it("answers jupyterUnreachable when the endpoint cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "jupyterUnreachable" });
  });

  it("carries the credential refusal through when the environment has no token", async () => {
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
      status: { endpoints: [{ name: "jupyter", address: BASE }] },
    });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "tokenMissing" });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("has a dictionary sentence for every code it can answer with", async () => {
    // The console builds its message from these codes (lib/api-error.ts), so a
    // code without a `dev.err.<code>` entry reaches the user as the bare word.
    // The credential refusals this route passes through are answered — and
    // scanned — in lib/jupyter.ts (see the token route's own guard).
    const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
    const codes = [...source.matchAll(/refuse\("(\w+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(4);
    for (const code of new Set(codes)) {
      expect(dictionaries["zh-CN"], `dev.err.${code}`).toHaveProperty(`dev.err.${code}`);
    }
  });
});
