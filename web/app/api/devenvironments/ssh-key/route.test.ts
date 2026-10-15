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

// A generated ed25519 private key, OpenSSH format: the file the user runs
// `ssh -i id_ed25519 …` with.
const CLIENT_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAaAAAABnMXm\n-----END OPENSSH PRIVATE KEY-----\n";
const ENV_URL = "http://localhost/api/devenvironments/ssh-key?namespace=project-a&name=ssh-dataset-prep";

/** The fixture mirrors the real cluster: the CR points at its own client key Secret. */
function stubCluster() {
  getNamespacedCustomObject.mockResolvedValue({
    metadata: { name: "ssh-dataset-prep", namespace: "project-a" },
    status: { sshClientKeySecret: { name: "ssh-dataset-prep-ssh-client-key", namespace: "project-a" } },
  });
  listNamespacedSecret.mockResolvedValue({
    items: [{ metadata: { name: "ssh-dataset-prep-ssh-client-key" }, data: { id_ed25519: Buffer.from(CLIENT_KEY).toString("base64") } }],
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

describe("GET /api/devenvironments/ssh-key", () => {
  beforeEach(() => stubCluster());
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns the private key as an id_ed25519 download, uncached", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(200);
    // The body is a credential: no cache, anywhere in the path, may keep it.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="id_ed25519"');
    expect(await res.text()).toBe(CLIENT_KEY);
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
      fieldSelector: "metadata.name=ssh-dataset-prep-ssh-client-key",
    });
  });

  it("refuses a request that names no environment", async () => {
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, "http://localhost/api/devenvironments/ssh-key?namespace=project-a"), undefined);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "requestInvalid" });
    expect(getNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("answers nameMissing when the environment is gone", async () => {
    getNamespacedCustomObject.mockRejectedValue(httpError(404));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nameMissing", params: { name: "ssh-dataset-prep" } });
  });

  it("answers keyMissing for an environment whose keys the user supplied", async () => {
    // A spec that names the user's own key Secret mints no client key, so there
    // is nothing to hand out: the user's private half was never in the cluster.
    getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
      status: { phase: { name: "Running" } },
    });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "keyMissing" });
    expect(listNamespacedSecret).not.toHaveBeenCalled();
  });

  it("answers keyGone when the Secret the environment names is not there", async () => {
    listNamespacedSecret.mockResolvedValue({ items: [] });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "keyGone", params: { name: "ssh-dataset-prep-ssh-client-key" } });
  });

  it("answers keyGone when the Secret carries no key entry", async () => {
    listNamespacedSecret.mockResolvedValue({ items: [{ metadata: { name: "ssh-dataset-prep-ssh-client-key" }, data: { "id_ed25519.pub": "c2NzaC1lZDI1NTE5" } }] });
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "keyGone", params: { name: "ssh-dataset-prep-ssh-client-key" } });
  });

  it("answers keyUnreadable when the cluster read itself fails", async () => {
    listNamespacedSecret.mockRejectedValue(httpError(500));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "keyUnreadable" });
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
});
