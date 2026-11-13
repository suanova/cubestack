// @vitest-environment node
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/lib/i18n/dictionaries";

import { authedRequest, bareGet } from "@/test/auth";

const { getNamespacedCustomObject, listNamespacedPod } = vi.hoisted(() => ({
  getNamespacedCustomObject: vi.fn(),
  listNamespacedPod: vi.fn(),
}));

// The clients are stubbed; `isNotFound` is the real one, so the 404 path is
// tested against the same function the route calls.
vi.mock("@/lib/kubernetes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kubernetes")>()),
  getCustomObjectsClient: () => ({ getNamespacedCustomObject }),
  getCoreClient: () => ({ listNamespacedPod }),
}));

const ENV_URL = "http://localhost/api/devenvironments/pod-status?namespace=project-a&name=jupyter-nlp-ln";

/** A pod of the environment, with whatever status the case is about. */
function pod(status: unknown, created = "2026-11-13T02:00:00Z") {
  return { metadata: { name: "jupyter-nlp-ln-0", creationTimestamp: created }, status };
}

/** The cluster as the route sees it: the environment exists, and has these pods. */
function stubCluster(pods: unknown[]) {
  getNamespacedCustomObject.mockResolvedValue({
    metadata: { name: "jupyter-nlp-ln", namespace: "project-a" },
  });
  listNamespacedPod.mockResolvedValue({ items: pods });
}

/**
 * A failed k8s client call, as @kubernetes/client-node 2.x raises it: its
 * generated `ApiException` carries the status on `.code`.
 */
function httpError(code: number) {
  return Object.assign(new Error(`HTTP-Code: ${code}`), { code });
}

describe("GET /api/devenvironments/pod-status", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("reports a container that cannot pull its image", async () => {
    stubCluster([
      pod({
        containerStatuses: [
          { name: "jupyter", state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image \"harbor.isuanova.com/…\"" } } },
        ],
      }),
    ]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      failure: { container: "jupyter", reason: "ImagePullBackOff", message: "Back-off pulling image \"harbor.isuanova.com/…\"" },
    });
  });

  it("carries the exit code of the run behind a CrashLoopBackOff", async () => {
    // The waiting state's own message is a back-off countdown; the exit code of
    // the run that crashed is the fact that explains it.
    stubCluster([
      pod({
        containerStatuses: [
          {
            name: "jupyter",
            state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
            lastState: { terminated: { reason: "Error", exitCode: 137 } },
          },
        ],
      }),
    ]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(await res.json()).toEqual({
      failure: { container: "jupyter", reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container", exitCode: 137 },
    });
  });

  it("blames the init container first", async () => {
    // A pod whose init container cannot start never reaches its app containers,
    // so their waiting states describe a second problem caused by the first.
    stubCluster([
      pod({
        initContainerStatuses: [
          { name: "init-ssh-keys", state: { terminated: { reason: "Error", exitCode: 1, message: "chown: Operation not permitted" } } },
        ],
        containerStatuses: [{ name: "jupyter", state: { waiting: { reason: "PodInitializing" } } }],
      }),
    ]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(await res.json()).toEqual({
      failure: { container: "init-ssh-keys", reason: "Error", message: "chown: Operation not permitted", exitCode: 1 },
    });
  });

  it("reports a container that was OOM-killed", async () => {
    stubCluster([
      pod({ containerStatuses: [{ name: "jupyter", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] }),
    ]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(await res.json()).toEqual({ failure: { container: "jupyter", reason: "OOMKilled", exitCode: 137 } });
  });

  it("says nothing about a pod that is still starting", async () => {
    // A completed init container and a container being created are the normal
    // path; a line under them would read as a failure that is not there.
    stubCluster([
      pod({
        initContainerStatuses: [{ name: "init-ssh-keys", state: { terminated: { reason: "Completed", exitCode: 0 } } }],
        containerStatuses: [{ name: "jupyter", state: { waiting: { reason: "ContainerCreating" } } }],
      }),
    ]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(await res.json()).toEqual({ failure: null });
  });

  it("reports the scheduler's message when the pod could not be placed", async () => {
    stubCluster([
      pod({
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/3 nodes are available: 3 Insufficient nvidia.com/gpu.",
          },
        ],
      }),
    ]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(await res.json()).toEqual({
      failure: { reason: "Unschedulable", message: "0/3 nodes are available: 3 Insufficient nvidia.com/gpu." },
    });
  });

  it("reads the newest pod, so a roll does not report the container it replaces", async () => {
    stubCluster([
      pod({ containerStatuses: [{ name: "jupyter", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] }, "2026-11-13T01:00:00Z"),
      pod({ containerStatuses: [{ name: "jupyter", state: { waiting: { reason: "ContainerCreating" } } }] }, "2026-11-13T02:00:00Z"),
    ]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(await res.json()).toEqual({ failure: null });
  });

  it("answers null for an environment that has no pod", async () => {
    // Stopped, or not yet reconciled: nothing is wrong, there is just no pod.
    stubCluster([]);
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ failure: null });
  });

  it("finds the pod by the environment's label, not by anything the caller sends", async () => {
    // The request names a DevEnvironment; the pod is the one carrying the label
    // the controller puts on that environment's pods. A pod-name parameter is
    // ignored, so this is not a way to read an arbitrary pod.
    stubCluster([]);
    const { GET } = await import("./route");
    await GET(
      await authedRequest({ method: "GET" }, `${ENV_URL}&pod=kube-system/coredns-abc`),
      undefined,
    );
    expect(listNamespacedPod).toHaveBeenCalledWith({
      namespace: "project-a",
      labelSelector: "ai.cubestack.io/dev-environment=jupyter-nlp-ln",
    });
  });

  it("refuses a request that names no environment", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      await authedRequest({ method: "GET" }, "http://localhost/api/devenvironments/pod-status?namespace=project-a"),
      undefined,
    );
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
    // A name that is not an environment must not look like "no failure".
    expect(listNamespacedPod).not.toHaveBeenCalled();
  });

  it("answers podUnreadable when the pod list fails", async () => {
    stubCluster([]);
    listNamespacedPod.mockRejectedValue(httpError(403));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "podUnreadable" });
  });

  it("answers podUnreadable when the environment read itself fails", async () => {
    getNamespacedCustomObject.mockRejectedValue(httpError(500));
    const { GET } = await import("./route");
    const res = await GET(await authedRequest({ method: "GET" }, ENV_URL), undefined);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "podUnreadable" });
  });

  it("rejects a request with no session", async () => {
    const { GET } = await import("./route");
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
  });

  it("has a dictionary sentence for every code it can answer with", async () => {
    // The console builds its message from these codes (lib/api-error.ts), so a
    // code without a `dev.err.<code>` entry reaches the user as the bare word.
    const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
    const codes = [...source.matchAll(/refuse\("(\w+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(3);
    for (const code of new Set(codes)) {
      expect(dictionaries["zh-CN"], `dev.err.${code}`).toHaveProperty(`dev.err.${code}`);
    }
  });
});
