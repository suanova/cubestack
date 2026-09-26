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

  it("projects spec.volumes / ports / runtime without inventing a workspace path", async () => {
    listClusterCustomObject.mockResolvedValue({
      items: [
        {
          metadata: { name: "pinned", namespace: "project-a" },
          spec: {
            type: "ssh",
            storage: { size: "100Gi", mountPath: "/data" },
            volumes: [{ name: "data-cache", pvcName: "data-cache", mountPath: "/cache", readOnly: true }],
            ports: [{ name: "api", containerPort: 8080 }],
            runtime: { env: [{ name: "HF_TOKEN" }, { name: "HF_HOME" }], args: ["--port", "8080"] },
          },
        },
        {
          metadata: { name: "derived", namespace: "project-a" },
          // spec.storage.size with no mountPath: the controller derives the
          // path, so the projection must say so rather than claim /workspace.
          spec: { type: "jupyter", storage: { size: "100Gi" } },
        },
      ],
    });
    const { GET } = await importRoute();
    const body = await (await GET(await authedGet(), undefined)).json();
    const [pinned, derived] = body.items;

    expect(pinned.storage).toEqual({ size: "100Gi", mountPath: "/data" });
    expect(pinned.volumes).toEqual([{ name: "data-cache", pvcName: "data-cache", mountPath: "/cache", readOnly: true }]);
    // The type is defaulted the way the CRD does; the env value is not
    // projected at all — a value can be a registry token, and the names are
    // what say which variables the environment carries.
    expect(pinned.ports).toEqual([{ name: "api", type: "http", containerPort: 8080 }]);
    expect(pinned.envNames).toEqual(["HF_TOKEN", "HF_HOME"]);
    expect(pinned.args).toEqual(["--port", "8080"]);

    expect(derived.storage).toEqual({ size: "100Gi", mountPath: null });
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
      volumes: [],
      envNames: [],
      args: [],
      ports: [],
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

  it("falls back to the image's published identity when the client states none", async () => {
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

  it("leaves spec.runtime unset for an unpublished image with no stated identity", async () => {
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
    // Nothing states the identity: the platform does not publish this image and
    // the client did not describe it, so the CRD's defaults stay in force.
    expect("runtime" in createNamespacedCustomObject.mock.calls[0][0].body.spec).toBe(false);
  });

  it("lets the client override the account and uid/gid the image would imply", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({
          name: "alice-env",
          namespace: "project-a",
          type: "jupyter",
          image: "harbor.isuanova.com/suanova/jupyter-minimal:latest",
          runtimeUser: "alice",
          runAsUser: 1500,
          runAsGroup: 1500,
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    // The account/uid pairing belongs to the image, not to the platform, and the
    // operator cannot look inside the image to check it (decision.md) — so what
    // the client states wins over what the catalog would have said.
    expect(createNamespacedCustomObject.mock.calls[0][0].body.spec.runtime).toEqual({
      user: "alice",
      securityContext: { runAsUser: 1500, runAsGroup: 1500 },
    });
  });

  it("keeps the image's gid when the client overrides only the uid", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();
    await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({
          name: "jovyan-env",
          namespace: "project-a",
          type: "jupyter",
          image: "harbor.isuanova.com/suanova/jupyter-minimal:latest",
          runAsUser: 1500,
        }),
      }),
      undefined,
    );
    expect(createNamespacedCustomObject.mock.calls[0][0].body.spec.runtime).toEqual({
      user: "jovyan",
      securityContext: { runAsUser: 1500, runAsGroup: 100 },
    });
  });

  it("treats runAsUser 0 as the root request: gid 0 and no account", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({
          name: "root-env",
          namespace: "project-a",
          type: "ssh",
          image: "harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest",
          runAsUser: 0,
          runAsGroup: 0,
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const runtime = createNamespacedCustomObject.mock.calls[0][0].body.spec.runtime;
    expect(runtime.securityContext).toEqual({ runAsUser: 0, runAsGroup: 0 });
    // The controller serves "root" itself and reports spec.runtime.user as
    // overridden, so sending one would only describe a field it ignores.
    expect("user" in runtime).toBe(false);
  });

  it("rejects an account the CRD's schema would refuse", async () => {
    const { POST } = await importRoute();
    for (const runtimeUser of ["Alice", "has space", "9lives", "a".repeat(33)]) {
      const res = await POST(
        await authedRequest({
          method: "POST",
          body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "jupyter", image: "img", runtimeUser }),
        }),
        undefined,
      );
      // Field-level 400 here rather than the API server's opaque 422 on the CR.
      expect(res.status).toBe(400);
      expect(createNamespacedCustomObject).not.toHaveBeenCalled();
    }
  });

  it("rejects a uid or gid that is not a non-negative integer", async () => {
    const { POST } = await importRoute();
    for (const ids of [{ runAsUser: -1 }, { runAsGroup: 1.5 }, { runAsUser: 2147483648 }, { runAsUser: 1e30 }]) {
      const res = await POST(
        await authedRequest({
          method: "POST",
          body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "jupyter", image: "img", ...ids }),
        }),
        undefined,
      );
      expect(res.status).toBe(400);
      expect(createNamespacedCustomObject).not.toHaveBeenCalled();
    }
  });

  it("rejects the account root without the uid 0 that actually asks for root", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "jupyter", image: "img", runtimeUser: "root", runAsUser: 1000 }),
      }),
      undefined,
    );
    // A "root" account at uid 1000 is an image whose sshd serves root but whose
    // process is not root — almost always a mistake, and never what it reads as.
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  // ── step 3's storage / runtime / network sections ──────────────────────────

  /** The spec the last successful POST wrote, for the step-3 cases below. */
  async function postedSpec(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    clearMocks();
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "ssh", image: "harbor.local/ai-images/custom:1.0", storageGi: 100, ...extra }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    return createNamespacedCustomObject.mock.calls[0][0].body.spec;
  }

  /** A request the route must refuse, asserting nothing reached the cluster. */
  async function rejectedPost(extra: Record<string, unknown>): Promise<string> {
    clearMocks();
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "ssh", image: "img", storageGi: 100, ...extra }),
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
    return (await res.json()).error;
  }

  it("states storage.mountPath only when it is given one", async () => {
    // Left empty the field is absent, not "/workspace": the controller derives
    // the path (and HOME) from the runtime identity, and a jupyter image's
    // workspace is /home/jovyan.
    const derived = await postedSpec({});
    expect(derived.storage).toEqual({ size: "100Gi" });

    const pinned = await postedSpec({ mountPath: "/data" });
    expect(pinned.storage).toEqual({ size: "100Gi", mountPath: "/data" });
  });

  it("rejects a workspace path that is not absolute, or that has no claim behind it", async () => {
    expect(await rejectedPost({ mountPath: "data" })).toContain("绝对路径");
    expect(await rejectedPost({ mountPath: "/" })).toContain("绝对路径");
    // spec.storage.mountPath lives inside spec.storage, so a path with no size
    // describes a mount nothing honours — the API server would prune it silently.
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({ name: "ok-name", namespace: "project-a", type: "ssh", image: "img", mountPath: "/data" }),
      }),
      undefined,
    );
    expect(res.status).toBe(400);
  });

  it("derives spec.volumes[].name from the PVC, uniquely", async () => {
    const spec = await postedSpec({
      volumes: [
        { pvcName: "Data_Cache", mountPath: "/data" },
        { pvcName: "data-cache", mountPath: "/cache" },
        { pvcName: "models", mountPath: "/models" },
      ],
    });
    // The name is the pod's own identifier, so it is slugged to a DNS-1123
    // label and de-duplicated rather than asked for — mounting the same PVC
    // twice under two paths is a legitimate request.
    expect(spec.volumes).toEqual([
      { name: "data-cache", pvcName: "Data_Cache", mountPath: "/data" },
      { name: "data-cache-2", pvcName: "data-cache", mountPath: "/cache" },
      { name: "models", pvcName: "models", mountPath: "/models" },
    ]);
  });

  it("rejects volume rows that are half-filled, relative, or at a taken path", async () => {
    expect(await rejectedPost({ volumes: [{ pvcName: "data-cache" }] })).toContain("同时填写");
    expect(await rejectedPost({ volumes: [{ pvcName: "data-cache", mountPath: "data" }] })).toContain("绝对路径");
    expect(
      await rejectedPost({
        volumes: [
          { pvcName: "a", mountPath: "/data" },
          { pvcName: "b", mountPath: "/data" },
        ],
      }),
    ).toContain("重复");
    // The workspace is a mount in the same pod, so its path is taken too.
    expect(await rejectedPost({ mountPath: "/data", volumes: [{ pvcName: "a", mountPath: "/data" }] })).toContain("重复");
  });

  it("drops a volume row the user never filled", async () => {
    const spec = await postedSpec({ volumes: [{ pvcName: "", mountPath: "" }] });
    expect("volumes" in spec).toBe(false);
  });

  it("adds spec.runtime.env and .args alongside the identity the image implies", async () => {
    createNamespacedCustomObject.mockResolvedValue({});
    listClusterCustomObject.mockResolvedValue({ items: [] });
    const { POST } = await importRoute();
    const res = await POST(
      await authedRequest({
        method: "POST",
        body: JSON.stringify({
          name: "ok-name",
          namespace: "project-a",
          type: "jupyter",
          image: "harbor.isuanova.com/suanova/jupyter-minimal:latest",
          env: [{ name: "HF_HOME", value: "/data/hf" }],
          args: '--port 8080 --name "a b"',
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    // Stating an environment variable does not unstate an identity: the two
    // are leaves of one spec.runtime, and the catalog still backs the account.
    expect(createNamespacedCustomObject.mock.calls[0][0].body.spec.runtime).toEqual({
      user: "jovyan",
      securityContext: { runAsGroup: 100 },
      env: [{ name: "HF_HOME", value: "/data/hf" }],
      args: ["--port", "8080", "--name", "a b"],
    });
  });

  it("rejects env names the API server would, and a relative HOME", async () => {
    expect(await rejectedPost({ env: [{ name: "1BAD", value: "x" }] })).toContain("环境变量名");
    expect(await rejectedPost({ env: [{ name: "has space", value: "x" }] })).toContain("环境变量名");
    expect(await rejectedPost({ env: [{ value: "orphan" }] })).toContain("变量名");
    expect(
      await rejectedPost({
        env: [
          { name: "A", value: "1" },
          { name: "A", value: "2" },
        ],
      }),
    ).toContain("重复");
    // HOME decides where the workspace mounts, so a relative one points the
    // container's home at a directory that cannot exist.
    expect(await rejectedPost({ env: [{ name: "HOME", value: "rel" }] })).toContain("HOME");
  });

  it("rejects an unbalanced quote in the arguments rather than guessing", async () => {
    expect(await rejectedPost({ args: '--name "a b' })).toContain("引号");
  });

  it("omits args and env when they state nothing", async () => {
    const spec = await postedSpec({ env: [{ name: "", value: "" }], args: "   " });
    expect("runtime" in spec).toBe(false);
  });

  it("defaults a port's type to http and lets http share a number", async () => {
    const spec = await postedSpec({
      ports: [
        { name: "api", containerPort: 8080 },
        { name: "admin", containerPort: 8080, type: "http" },
      ],
    });
    // The CRD's own default; http is published as a Gateway sub path, so
    // nothing stops two names sharing one container port.
    expect(spec.ports).toEqual([
      { name: "api", type: "http", containerPort: 8080 },
      { name: "admin", type: "http", containerPort: 8080 },
    ]);
  });

  it("rejects ports the CRD or the publisher would refuse", async () => {
    expect(await rejectedPost({ ports: [{ containerPort: 8080 }] })).toContain("名称");
    expect(await rejectedPost({ ports: [{ name: "api", containerPort: 0 }] })).toContain("1–65535");
    expect(await rejectedPost({ ports: [{ name: "api", containerPort: 65536 }] })).toContain("1–65535");
    expect(await rejectedPost({ ports: [{ name: "api", containerPort: 1.5 }] })).toContain("1–65535");
    expect(await rejectedPost({ ports: [{ name: "api", containerPort: 80, type: "sctp" }] })).toContain("端口类型");
    expect(
      await rejectedPost({
        ports: [
          { name: "api", containerPort: 8080, type: "tcp" },
          { name: "api", containerPort: 9090, type: "tcp" },
        ],
      }),
    ).toContain("重复");
    // tcp and udp are published over one L4 pool, where a number is held by a
    // single protocol — the CRD states this in prose, not in its schema.
    expect(
      await rejectedPost({
        ports: [
          { name: "api", containerPort: 9000, type: "tcp" },
          { name: "metrics", containerPort: 9000, type: "udp" },
        ],
      }),
    ).toContain("端口池");
  });

  it("drops a port row the user never filled", async () => {
    // The type always holds a value, so an untouched row must be recognised by
    // its name and number alone.
    const spec = await postedSpec({ ports: [{ type: "tcp" }] });
    expect("ports" in spec).toBe(false);
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