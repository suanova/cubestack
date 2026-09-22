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
          image: "harbor.isuanova.com/suanova/base-cuda:latest",
          running: true,
          resources: { gpu: { vendor: "nvidia", count: 2 }, cpu: "16", memory: "64Gi" },
          storage: { size: "200Gi", mountPath: "/home/ubuntu" },
          lifecycle: { idleTimeout: 3600 },
        },
        status: {
          phase: { name: "Running" },
          endpoints: [{ name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-nlp-ln" }],
          conditions: [
            { type: "PodScheduled", status: "True", reason: "Scheduled", message: "" },
            { type: "Ready", status: "True", reason: "Running", message: "" },
          ],
          sshClientKeySecret: { name: "jupyter-nlp-ln-ssh-client-key" },
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
          image: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest",
          running: false,
          // No count: the projection has to apply the CRD's default of 1.
          resources: { gpu: { vendor: "metax" }, cpu: "32", memory: "128Gi" },
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
      image: "harbor.isuanova.com/suanova/base-cuda:latest",
      running: true,
      resources: { gpu: { vendor: "nvidia", count: 2 }, cpu: "16", memory: "64Gi" },
      storage: { size: "200Gi", mountPath: "/home/ubuntu" },
      idleTimeout: 3600,
      phase: "Running",
      sshClientKeySecret: "jupyter-nlp-ln-ssh-client-key",
      endpoints: [{ name: "jupyter", address: "https://dev.cubestack.local/ws/jupyter-nlp-ln" }],
    });
    expect(jupyter.conditions).toHaveLength(2);
    expect(jupyter.conditions[0]).toMatchObject({ type: "PodScheduled", status: "True" });

    const [, ssh] = body.items;
    expect(ssh.phase).toBe("Stopped");
    expect(ssh.endpoints).toEqual([]);
    // gpu.vendor is taken as written and gpu.count falls back to the CRD's 1.
    expect(ssh.resources.gpu).toEqual({ vendor: "metax", count: 1 });
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
      // No spec.resources.gpu block: the environment requests no accelerator,
      // which is a state the UI must render rather than invent a GPU for.
      resources: { gpu: null, cpu: "—", memory: "—" },
      storage: null,
      idleTimeout: 0,
      sshEnabled: false,
      phase: null,
      phaseReason: null,
      endpoints: [],
      conditions: [],
      sshClientKeySecret: null,
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
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "Bad Name", namespace: "project-a", type: "jupyter", image: "img", accelerator: "nvidia", gpuCount: 1 }) }), undefined);
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects an unknown namespace", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "ok-name", namespace: "missing", type: "jupyter", image: "img", accelerator: "nvidia", gpuCount: 1 }) }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("不存在");
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects a duplicate env name in the namespace", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "jupyter-nlp-ln", namespace: "project-a", type: "jupyter", image: "img", accelerator: "nvidia", gpuCount: 1 }) }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("已存在");
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range gpuCount", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "jupyter", image: "img", accelerator: "nvidia", gpuCount: 0 }) }), undefined);
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("rejects an accelerator that is not one of the three choices", async () => {
    const { POST } = await importRoute();
    const res = await POST(await authedRequest({ method: "POST", body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "jupyter", image: "img", accelerator: "amd", gpuCount: 1 }) }), undefined);
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
          image: "harbor.isuanova.com/suanova/base-cuda:latest",
          accelerator: "nvidia",
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
        image: "harbor.isuanova.com/suanova/base-cuda:latest",
        running: true,
        resources: { gpu: { vendor: "nvidia", count: 4 }, cpu: "64", memory: "256Gi" },
        // Derived from the image, never sent by the client: the self-authored
        // family runs as account ubuntu (uid/gid 1000, the platform default).
        runtime: { user: "ubuntu" },
        storage: { size: "300Gi" },
        lifecycle: { idleTimeout: 1800 },
      },
    });
  });

  it("omits spec.resources.gpu entirely when no accelerator is requested", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({
          name: "cpu-env",
          namespace: "project-a",
          type: "ssh",
          image: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest",
          accelerator: "none",
          // Ignored: the CRD has no zero count, so a stray count must not
          // become a request for cards.
          gpuCount: 8,
          cpu: "16",
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const spec = createNamespacedCustomObject.mock.calls[0][0].body.spec;
    // Absence is the only spelling of "no accelerator", and it is what keeps
    // the image out of the controller's brand gate.
    expect("gpu" in spec.resources).toBe(false);
  });

  it("derives spec.runtime from the image, because the layout is not discoverable", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();

    await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "jovyan-env", namespace: "project-a", type: "jupyter", image: "harbor.isuanova.com/suanova/jupyter-minimal:latest" }),
      }),
      undefined,
    );
    // The stock-derived image keeps docker-stacks' jovyan, whose gid (100) no
    // other spec field implies — the platform default is 1000.
    expect(createNamespacedCustomObject.mock.calls[0][0].body.spec.runtime).toEqual({
      user: "jovyan",
      securityContext: { runAsGroup: 100 },
    });

    createNamespacedCustomObject.mockClear();
    await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "ubuntu-env", namespace: "project-a", type: "ssh", image: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest" }),
      }),
      undefined,
    );
    // 1000:1000 already is the platform default, so nothing overrides it.
    expect(createNamespacedCustomObject.mock.calls[0][0].body.spec.runtime).toEqual({
      user: "ubuntu",
    });
  });

  it("leaves spec.runtime unset for an image the platform does not publish", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "byo-env", namespace: "project-a", type: "ssh", image: "harbor.local/ai-images/custom:1.0" }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    // A bring-your-own image states its own identity in the spec — the
    // platform cannot guess it, so it leaves the CRD's defaults in force.
    expect("runtime" in createNamespacedCustomObject.mock.calls[0][0].body.spec).toBe(false);
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

  it("toggles spec.running via a JSON-Patch array", async () => {
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const res = await PATCH(
      await authedRequest({ method: "PATCH", body: JSON.stringify({ namespace: "project-a", name: "jupyter-nlp-ln", running: false }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const arg = patchNamespacedCustomObject.mock.calls[0][0];
    // JSON-Patch array: the client pins application/json-patch+json, so an
    // object body would be rejected with a 400 decode error. `add` replaces
    // the value when present and creates it when absent.
    expect(arg.body).toEqual([{ op: "add", path: "/spec/running", value: false }]);
    expect(arg.fieldManager).toBe("cubestack-web");
  });

  it("patches an existing resource that omits spec.running (add creates the field)", async () => {
    // The clustered fixture includes an env (ssh-dataset-prep) whose spec has
    // no `running` key; JSON-Patch `add` on the existing spec object creates
    // the member, so the same body works for resources that predate the field.
    patchNamespacedCustomObject.mockResolvedValue({});
    const { PATCH } = await importRoute();
    const res = await PATCH(
      await authedRequest({ method: "PATCH", body: JSON.stringify({ namespace: "project-a", name: "ssh-dataset-prep", running: true }) }),
      undefined,
    );
    expect(res.status).toBe(200);
    const arg = patchNamespacedCustomObject.mock.calls[0][0];
    expect(arg.name).toBe("ssh-dataset-prep");
    expect(arg.body).toEqual([{ op: "add", path: "/spec/running", value: true }]);
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