// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { listNamespace } = vi.hoisted(() => ({ listNamespace: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespace }),
}));

/** The namespaces a live CubeStack install advertises. */
function stubNamespaces(names: string[]) {
  listNamespace.mockResolvedValue({ items: names.map((name) => ({ metadata: { name } })) });
}

async function options(): Promise<{ namespaces: Array<{ name: string }>; defaultNamespace: string | null }> {
  const { GET } = await import("./route");
  const res = await GET(await authedGet(), undefined);
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/devenvironments/options", () => {
  beforeEach(() => {
    vi.resetModules();
    listNamespace.mockReset();
    delete process.env.CUBESTACK_DEFAULT_NAMESPACE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CUBESTACK_DEFAULT_NAMESPACE;
  });

  it("leaves the platform's own namespaces out of what it offers", async () => {
    // The list measured on cs7, which the wizard used to present in full.
    stubNamespaces([
      "ai-gateway-system",
      "cubestack-system",
      "default",
      "envoy-gateway-system",
      "kube-node-lease",
      "kube-public",
      "kube-system",
      "lws-system",
      "metallb-system",
      "metax-operator",
      "project-a",
      "rook-ceph",
    ]);

    const body = await options();
    // kube-* is Kubernetes' own; the rest is where the platform installs. A
    // development environment is a StatefulSet, a PVC and Routes, and putting
    // one in the platform's control plane is not a choice the wizard should
    // offer — the portal's RBAC would allow it.
    expect(body.namespaces).toEqual([{ name: "default" }, { name: "project-a" }]);
  });

  it("opens on `default` rather than on whatever sorts first", async () => {
    stubNamespaces(["ai-gateway-system", "project-a", "default", "team-b"]);

    const body = await options();
    // Sorted ascending, so the first entry is team-b and the alphabetically
    // first of all is a platform namespace — neither is the answer.
    expect(body.namespaces.map((n) => n.name)).toEqual(["default", "project-a", "team-b"]);
    expect(body.defaultNamespace).toBe("default");
  });

  it("opens on the platform's configured namespace when there is one", async () => {
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "team-b";
    stubNamespaces(["default", "project-a", "team-b"]);

    // An explicit platform decision beats the conventional default: otherwise
    // the setting could never take effect on a cluster that has `default`.
    expect((await options()).defaultNamespace).toBe("team-b");
  });

  it("ignores a configured namespace the cluster does not have", async () => {
    process.env.CUBESTACK_DEFAULT_NAMESPACE = "ai-gateway-system";
    stubNamespaces(["default", "project-a"]);

    // Configured or not, a namespace that is not offered cannot be selected.
    expect((await options()).defaultNamespace).toBe("default");
  });

  it("falls back to the first namespace it offers when there is no `default`", async () => {
    stubNamespaces(["kube-system", "project-a", "team-b"]);

    // Confined by the filter to the user's own namespaces, so the fallback can
    // no longer land in a platform namespace the way it used to.
    expect((await options()).defaultNamespace).toBe("project-a");
  });

  it("names no default when the cluster offers no namespace", async () => {
    stubNamespaces(["kube-system", "cubestack-system"]);

    expect(await options()).toMatchObject({ namespaces: [], defaultNamespace: null });
  });

  it("rejects an unauthenticated request", async () => {
    stubNamespaces(["default"]);
    const { GET } = await import("./route");
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
    expect(listNamespace).not.toHaveBeenCalled();
  });
});
