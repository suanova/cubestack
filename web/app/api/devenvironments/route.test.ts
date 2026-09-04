// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, authedRequest } from "@/test/auth";

const { listNamespace, listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject, deleteNamespacedCustomObject } = vi.hoisted(() => ({
  listNamespace: vi.fn(),
  listClusterCustomObject: vi.fn(),
  patchNamespacedCustomObject: vi.fn(),
  createNamespacedCustomObject: vi.fn(),
  deleteNamespacedCustomObject: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace }),
  getCustomObjectsClient: () => ({ listClusterCustomObject, patchNamespacedCustomObject, createNamespacedCustomObject, deleteNamespacedCustomObject }),
}));

/** The cluster fixture mirrors the real KinD data: one running, one stopped env. */
function stubCluster() {
  listNamespace.mockResolvedValue({ items: [{ metadata: { name: "project-a" } }, { metadata: { name: "default" } }] });
  listClusterCustomObject.mockResolvedValue({
    items: [
      {
        metadata: {
          name: "jupyter-nlp-ln",
          namespace: "project-a",
          creationTimestamp: "2026-09-01T06:12:00Z",
        },
        spec: {
          type: "jupyter",
          image: "base-cuda-12.4:v1.6",
          running: true,
          resources: { gpuType: "nvidia", gpuCount: 2, cpu: "16", memory: "64Gi" },
          storage: { size: "200Gi", mountPath: "/workspace" },
          lifecycle: { idleTimeout: 3600 },
        },
        status: {
          phase: { name: "Running" },
          endpoints: [{ name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-nlp-ln" }],
          conditions: [
            { type: "PodScheduled", status: "True", reason: "Scheduled", message: "" },
            { type: "Ready", status: "True", reason: "Running", message: "" },
          ],
          sshKeysSecret: { name: "jupyter-nlp-ln-ssh" },
        },
      },
      {
        metadata: {
          name: "ssh-dataset-prep",
          namespace: "project-a",
          creationTimestamp: "2026-08-30T12:00:00Z",
        },
        spec: {
          type: "ssh",
          image: "base-cuda-12.1:v1.6",
          running: false,
          resources: { gpuType: "metax", gpuCount: 1, cpu: "32", memory: "128Gi" },
        },
        status: { phase: { name: "Stopped" } },
      },
    ],
  });
}

async function importRoute() {
  return import("./route");
}

function clearMocks() {
  listNamespace.mockClear();
  listClusterCustomObject.mockClear();
  patchNamespacedCustomObject.mockClear();
  createNamespacedCustomObject.mockClear();
  deleteNamespacedCustomObject.mockClear();
}

describe("GET /api/devenvironments", () => {
  beforeEach(() => {
    vi.resetModules();
    clearMocks();
    stubCluster();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every environment, newest first, projected with resolved spec/status", async () => {
    const { GET } = await importRoute();
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Newest first: jupyter-nlp-ln (09-01) before ssh-dataset-prep (08-30).
    expect(body.items.map((i: { name: string }) => i.name)).toEqual(["jupyter-nlp-ln", "ssh-dataset-prep"]);

    const [jupyter] = body.items;
    expect(jupyter).toMatchObject({
      name: "jupyter-nlp-ln",
      namespace: "project-a",
      type: "jupyter",
      image: "base-cuda-12.4:v1.6",
      running: true,
      resources: { gpuType: "nvidia", gpuCount: 2, cpu: "16", memory: "64Gi" },
      storage: { size: "200Gi", mountPath: "/workspace" },
      idleTimeout: 3600,
      phase: "Running",
      sshKeysSecret: "jupyter-nlp-ln-ssh",
      endpoints: [{ name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-nlp-ln" }],
    });
    expect(jupyter.conditions).toHaveLength(2);
    expect(jupyter.conditions[0]).toMatchObject({ type: "PodScheduled", status: "True" });

    const [, ssh] = body.items;
    expect(ssh.phase).toBe("Stopped");
    expect(ssh.endpoints).toEqual([]);
  });

  it("defaults absent spec fields so rendering never crashes", async () => {
    listClusterCustomObject.mockResolvedValue({
      items: [
        {
          metadata: { name: "minimal", namespace: "default" },
          // No spec at all: every optional field must still project.
        },
      ],
    });
    const { GET } = await importRoute();
    const res = await GET(await authedGet(), undefined);
    const body = await res.json();
    expect(body.items[0]).toEqual({
      name: "minimal",
      namespace: "default",
      createdAt: null,
      type: "ssh", // default type per the CRD
      image: "—",
      running: false,
      resources: { gpuType: "nvidia", gpuCount: 1, cpu: "—", memory: "—" },
      storage: null,
      idleTimeout: 0,
      sshEnabled: false,
      phase: null,
      phaseReason: null,
      endpoints: [],
      conditions: [],
      sshKeysSecret: null,
    });
  });
});

describe("POST /api/devenvironments", () => {
  beforeEach(() => {
    vi.resetModules();
    clearMocks();
    stubCluster();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a non-DNS-1123 name", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "Bad Name", namespace: "project-a", type: "jupyter", image: "img", gpuCount: 1 }) }), undefined);
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects an unknown namespace", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "ok-name", namespace: "missing", type: "jupyter", image: "img", gpuCount: 1 }) }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("不存在");
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a duplicate env name in the namespace", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "jupyter-nlp-ln", namespace: "project-a", type: "jupyter", image: "img", gpuCount: 1 }) }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("已存在");
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range gpuCount", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "jupyter", image: "img", gpuCount: 0 }) }), undefined);
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("creates the CR with CRD-backed fields and carries over optional cpu/memory", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [{ metadata: { name: "jupyter-nlp-ln", namespace: "project-a" } }] });
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({
          name: "jupyter-recsys",
          namespace: "project-a",
          type: "jupyter",
          image: "base-cuda-12.4:v1.6",
          gpuType: "metax",
          gpuCount: 4,
          cpu: "64",
          memory: "256Gi",
          storageGi: 300,
          idleTimeout: 1800,
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const arg = createNamespacedCustomObject.mock.calls[0][0];
    expect(arg.namespace).toBe("project-a");
    expect(arg.plural).toBe("devenvironments");
    expect(arg.body).toMatchObject({
      apiVersion: "ai.cubestack.io/v1alpha1",
      kind: "DevEnvironment",
      metadata: { name: "jupyter-recsys", namespace: "project-a" },
      spec: {
        type: "jupyter",
        image: "base-cuda-12.4:v1.6",
        running: true,
        resources: { gpuType: "metax", gpuCount: 4, cpu: "64", memory: "256Gi" },
        storage: { size: "300Gi" },
        lifecycle: { idleTimeout: 1800 },
      },
    });
  });
});

describe("PATCH /api/devenvironments", () => {
  beforeEach(() => {
    vi.resetModules();
    clearMocks();
    stubCluster();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toggles spec.running via a merge patch", async () => {
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const res = await PATCH(
      await authedRequest({ method: "PATCH", body: JSON.stringify({ namespace: "project-a", name: "jupyter-nlp-ln", running: false }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const arg = patchNamespacedCustomObject.mock.calls[0][0];
    // Merge-patch object body (not a JSON-Patch `replace` array) so the API
    // server creates /spec/running when the resource omits it.
    expect(arg.body).toEqual({ spec: { running: false } });
    expect(arg.fieldManager).toBe("cubestack-web");
  });

  it("patches an existing resource that omits spec.running (merge creates the field)", async () => {
    // The clustered fixture includes an env (ssh-dataset-prep) whose spec has
    // no `running` key; the merge-patch body must be sent unchanged so the API
    // server creates spec.running rather than failing a `replace` on an absent
    // target.
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const res = await PATCH(
      await authedRequest({ method: "PATCH", body: JSON.stringify({ namespace: "project-a", name: "ssh-dataset-prep", running: true }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const arg = patchNamespacedCustomObject.mock.calls[0][0];
    expect(arg.name).toBe("ssh-dataset-prep");
    expect(arg.body).toEqual({ spec: { running: true } });
  });

  it("rejects a missing running boolean", async () => {
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const res = await PATCH(await authedRequest({ method: "PATCH", body: JSON.stringify({ namespace: "project-a", name: "x" }) }), undefined);
    expect(res.status).toBe(400);
    expect(patchNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/devenvironments", () => {
  beforeEach(() => {
    vi.resetModules();
    clearMocks();
    stubCluster();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the named environment", async () => {
    deleteNamespacedCustomObject.mockResolvedValue({});
    const { DELETE } = await importRoute();
    const res = await DELETE(await authedRequest({ method: "DELETE", body: JSON.stringify({ namespace: "project-a", name: "ssh-dataset-prep" }) }), undefined);
    expect(res.status).toBe(200);
    const arg = deleteNamespacedCustomObject.mock.calls[0][0];
    expect(arg).toMatchObject({ namespace: "project-a", name: "ssh-dataset-prep", plural: "devenvironments" });
  });

  it("rejects a missing name", async () => {
    deleteNamespacedCustomObject.mockResolvedValue({});
    const { DELETE } = await importRoute();
    const res = await DELETE(await authedRequest({ method: "DELETE", body: JSON.stringify({ namespace: "project-a" }) }), undefined);
    expect(res.status).toBe(400);
    expect(deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });
});