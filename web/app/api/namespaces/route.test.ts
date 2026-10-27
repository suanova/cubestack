// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const { createNamespace, listNamespace } = vi.hoisted(() => ({ createNamespace: vi.fn(), listNamespace: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ createNamespace, listNamespace }),
}));

/** The request the wizards make: one name, and nothing else. */
function post(name: unknown) {
  return authedRequest({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

describe("POST /api/namespaces", () => {
  beforeEach(() => {
    createNamespace.mockReset();
    createNamespace.mockResolvedValue({ metadata: { name: "team-a" } });
    listNamespace.mockReset();
    listNamespace.mockResolvedValue({ items: [{ metadata: { name: "team-a" } }] });
  });

  it("creates the namespace the wizard named", async () => {
    const { POST } = await import("./route");
    const res = await POST(await post("team-a"), undefined);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "team-a" });
    expect(createNamespace).toHaveBeenCalledWith({ body: { metadata: { name: "team-a" } } });
    expect(listNamespace).not.toHaveBeenCalled();
  });

  it("trims the name it was given", async () => {
    const { POST } = await import("./route");
    await POST(await post("  team-a  "), undefined);

    // A padded name is a different namespace to the API server, and the
    // environment is then created in the trimmed one.
    expect(createNamespace).toHaveBeenCalledWith({ body: { metadata: { name: "team-a" } } });
  });

  it.each([{ code: 409 }, { statusCode: 409 }])("answers 200 for an existing tenant namespace (%j)", async (conflict) => {
    // The select offers `default` plus this entry, so a user reusing an
    // existing tenant namespace by name is the ordinary case, not a clash.
    createNamespace.mockRejectedValue(conflict);
    const { POST } = await import("./route");
    const res = await POST(await post("team-a"), undefined);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "team-a" });
    expect(listNamespace).toHaveBeenCalledWith({ fieldSelector: "metadata.name=team-a" });
  });

  it.each([
    { labels: { "app.kubernetes.io/managed-by": "kustomize" } },
    { labels: { "app.kubernetes.io/managed-by": "Helm" } },
    { labels: { "ai.cubestack.io/managed-by": "cubestack" } },
    { annotations: { "meta.helm.sh/release-name": "platform" } },
    { annotations: { "meta.helm.sh/release-namespace": "platform-system" } },
    { ownerReferences: [{ apiVersion: "v1", kind: "Namespace", name: "platform", uid: "platform-uid" }] },
  ])("rejects reuse when cluster metadata declares management (%j)", async (metadata) => {
    createNamespace.mockRejectedValue({ code: 409 });
    listNamespace.mockResolvedValue({ items: [{ metadata: { name: "team-a", ...metadata } }] });
    const { POST } = await import("./route");
    const res = await POST(await post("team-a"), undefined);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "namespaceManaged", params: { name: "team-a" } });
  });

  it("rejects reuse of a reserved Kubernetes namespace without management labels", async () => {
    createNamespace.mockRejectedValue({ code: 409 });
    listNamespace.mockResolvedValue({ items: [{ metadata: { name: "kube-system" } }] });
    const { POST } = await import("./route");
    const res = await POST(await post("kube-system"), undefined);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "namespaceManaged", params: { name: "kube-system" } });
  });

  it.each([null, {}, [], "team-a", 42, { name: null }, { name: 42 }, { name: false }, { name: [] }, { name: {} }])(
    "rejects a malformed request body (%j)", async (body) => {
      const { POST } = await import("./route");
      const req = await authedRequest({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const res = await POST(req, undefined);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "namespaceNameInvalid" });
      expect(createNamespace).not.toHaveBeenCalled();
    },
  );

  it.each(["{", ""])("rejects invalid JSON (%j)", async (body) => {
    const { POST } = await import("./route");
    const res = await POST(await authedRequest({ method: "POST", body }), undefined);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "namespaceNameInvalid" });
    expect(createNamespace).not.toHaveBeenCalled();
  });

  it.each(["unreadable", "missing"])("does not report success when conflict metadata is %s", async (state) => {
    createNamespace.mockRejectedValue({ code: 409 });
    if (state === "unreadable") listNamespace.mockRejectedValue(new Error("forbidden"));
    else listNamespace.mockResolvedValue({ items: [] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { POST } = await import("./route");
      const res = await POST(await post("team-a"), undefined);
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "namespaceCreateFailed" });
    } finally {
      error.mockRestore();
    }
  });

  it("rejects a name that is not a DNS-1123 label", async () => {
    const { POST } = await import("./route");
    for (const name of ["", "Team-A", "team_a", "-team", "team-", "a".repeat(64), "team.a"]) {
      const res = await POST(await post(name), undefined);
      expect(res.status, name).toBe(400);
      expect(await res.json()).toEqual({ error: "namespaceNameInvalid" });
    }
    expect(createNamespace).not.toHaveBeenCalled();
  });

  it("reports a cluster failure rather than a namespace that was not created", async () => {
    createNamespace.mockRejectedValue(new Error("forbidden"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { POST } = await import("./route");
      const res = await POST(await post("team-a"), undefined);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "namespaceCreateFailed",
        params: { error: "forbidden" },
      });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("rejects an unauthenticated request", async () => {
    const { POST } = await import("./route");
    const res = await POST(await bareGet(), undefined);

    expect(res.status).toBe(401);
    expect(createNamespace).not.toHaveBeenCalled();
  });
});
