// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";
import { MAX_LOGO_BYTES } from "@/lib/settings/logo";

const mocks = vi.hoisted(() => ({
  readNamespacedConfigMap: vi.fn(),
  createNamespacedConfigMap: vi.fn(),
  patchNamespacedConfigMap: vi.fn(),
}));

vi.mock("@/lib/kubernetes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kubernetes")>();
  return {
    ...actual,
    getCoreClient: () => ({
      readNamespacedConfigMap: mocks.readNamespacedConfigMap,
      createNamespacedConfigMap: mocks.createNamespacedConfigMap,
      patchNamespacedConfigMap: mocks.patchNamespacedConfigMap,
    }),
  };
});

const LOGO = "data:image/png;base64,iVBORw0KGgo=";
const NAME = "cubestack-portal-branding";
const NAMESPACE = "cubestack-system";

function put(logo: unknown) {
  return authedRequest({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logo }),
  });
}

function putBody(body: unknown) {
  return authedRequest({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/settings/branding", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    delete process.env.PORTAL_ADMIN_USERS;
    delete process.env.BRANDING_CONFIGMAP_NAME;
    delete process.env.BRANDING_CONFIGMAP_NAMESPACE;
  });

  describe("GET", () => {
    it("returns the stored logo and whether the caller may edit", async () => {
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: { logo: LOGO } });
      const { GET } = await import("./route");
      const res = await GET(await authedGet());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: LOGO, title: null, subtitle: null, canEdit: false });
      expect(mocks.readNamespacedConfigMap).toHaveBeenCalledWith({ name: NAME, namespace: NAMESPACE });
    });

    it("returns null when the branding ConfigMap does not exist", async () => {
      mocks.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
      const { GET } = await import("./route");
      const res = await GET(await authedGet());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: null, title: null, subtitle: null, canEdit: false });
    });

    it("reports canEdit for an admin", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: {} });
      const { GET } = await import("./route");
      const res = await GET(await authedGet());

      expect(await res.json()).toEqual({ logo: null, title: null, subtitle: null, canEdit: true });
    });

    it("reports a cluster failure instead of pretending there is no logo", async () => {
      mocks.readNamespacedConfigMap.mockRejectedValue(new Error("forbidden"));
      const { GET } = await import("./route");
      const res = await GET(await authedGet());

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "brandingLoadFailed" });
    });

    it("serves the logo to an anonymous visitor without edit rights", async () => {
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: { logo: LOGO } });
      const { GET } = await import("./route");
      const res = await GET(await bareGet());

      // The login page paints the logo before anyone is signed in.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: LOGO, title: null, subtitle: null, canEdit: false });
    });
  });

  describe("PUT", () => {
    it("forbids a signed-in user who is not an admin", async () => {
      process.env.PORTAL_ADMIN_USERS = "someone-else";
      const { PUT } = await import("./route");
      const res = await PUT(await put(LOGO), undefined);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "brandingForbidden" });
      expect(mocks.patchNamespacedConfigMap).not.toHaveBeenCalled();
      expect(mocks.createNamespacedConfigMap).not.toHaveBeenCalled();
    });

    it("patches an existing ConfigMap", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: {} });
      const { PUT } = await import("./route");
      const res = await PUT(await put(LOGO), undefined);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: LOGO, title: null, subtitle: null, canEdit: true });
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [{ op: "add", path: "/data/logo", value: LOGO }],
      });
      expect(mocks.createNamespacedConfigMap).not.toHaveBeenCalled();
    });

    it("adds the whole data map when the ConfigMap has none", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({});
      const { PUT } = await import("./route");
      const res = await PUT(await put(LOGO), undefined);

      expect(res.status).toBe(200);
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [{ op: "add", path: "/data", value: { logo: LOGO } }],
      });
    });

    it("creates the ConfigMap when it is missing", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
      const { PUT } = await import("./route");
      const res = await PUT(await put(LOGO), undefined);

      expect(res.status).toBe(200);
      expect(mocks.createNamespacedConfigMap).toHaveBeenCalledWith({
        namespace: NAMESPACE,
        body: {
          metadata: { name: NAME, labels: { "app.kubernetes.io/managed-by": "cubestack-portal" } },
          data: { logo: LOGO },
        },
      });
    });

    it("patches when a concurrent save wins the create race", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockRejectedValueOnce({ code: 404 }).mockResolvedValue({ data: {} });
      mocks.createNamespacedConfigMap.mockRejectedValue({ code: 409 });
      const { PUT } = await import("./route");
      const res = await PUT(await put(LOGO), undefined);

      expect(res.status).toBe(200);
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [{ op: "add", path: "/data/logo", value: LOGO }],
      });
    });

    it("removes the key when asked to restore the default", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: { logo: LOGO } });
      const { PUT } = await import("./route");
      const res = await PUT(await put(null), undefined);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: null, title: null, subtitle: null, canEdit: true });
      // JSON Patch removes the key; a null ConfigMap value is not valid.
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [{ op: "remove", path: "/data/logo" }],
      });
    });

    it("does not patch when there is no logo to remove", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: {} });
      const { PUT } = await import("./route");
      const res = await PUT(await put(null), undefined);

      expect(res.status).toBe(200);
      expect(mocks.patchNamespacedConfigMap).not.toHaveBeenCalled();
    });

    it("does not create a ConfigMap just to clear an absent logo", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
      const { PUT } = await import("./route");
      const res = await PUT(await put(null), undefined);

      expect(res.status).toBe(200);
      expect(mocks.createNamespacedConfigMap).not.toHaveBeenCalled();
      expect(mocks.patchNamespacedConfigMap).not.toHaveBeenCalled();
    });

    it("updates the brand name and subtitle", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: { logo: LOGO } });
      const { PUT } = await import("./route");
      const res = await PUT(await putBody({ title: "  Acme Cloud ", subtitle: "智能算力平台" }), undefined);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: LOGO, title: "Acme Cloud", subtitle: "智能算力平台", canEdit: true });
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [
          { op: "add", path: "/data/title", value: "Acme Cloud" },
          { op: "add", path: "/data/subtitle", value: "智能算力平台" },
        ],
      });
    });

    it("leaves fields that were not sent unchanged", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: { title: "Old", subtitle: "Sub" } });
      const { PUT } = await import("./route");
      const res = await PUT(await putBody({ title: "New" }), undefined);

      expect(await res.json()).toEqual({ logo: null, title: "New", subtitle: "Sub", canEdit: true });
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [{ op: "add", path: "/data/title", value: "New" }],
      });
    });

    it("removes a text field cleared with whitespace", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: { title: "Old", subtitle: "Sub" } });
      const { PUT } = await import("./route");
      const res = await PUT(await putBody({ title: "   " }), undefined);

      expect(await res.json()).toEqual({ logo: null, title: null, subtitle: "Sub", canEdit: true });
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [{ op: "remove", path: "/data/title" }],
      });
    });

    it("creates the ConfigMap for text-only branding", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockRejectedValue({ code: 404 });
      const { PUT } = await import("./route");
      const res = await PUT(await putBody({ title: "Acme" }), undefined);

      expect(res.status).toBe(200);
      expect(mocks.createNamespacedConfigMap).toHaveBeenCalledWith({
        namespace: NAMESPACE,
        body: {
          metadata: { name: NAME, labels: { "app.kubernetes.io/managed-by": "cubestack-portal" } },
          data: { title: "Acme" },
        },
      });
    });

    it("clears all branding on a full reset", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: { logo: LOGO, title: "Acme", subtitle: "Sub" } });
      const { PUT } = await import("./route");
      const res = await PUT(await putBody({ logo: null, title: null, subtitle: null }), undefined);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: null, title: null, subtitle: null, canEdit: true });
      expect(mocks.patchNamespacedConfigMap).toHaveBeenCalledWith({
        name: NAME,
        namespace: NAMESPACE,
        body: [
          { op: "remove", path: "/data/logo" },
          { op: "remove", path: "/data/title" },
          { op: "remove", path: "/data/subtitle" },
        ],
      });
    });

    it.each([{ title: "a".repeat(65) }, { title: 42 }, { subtitle: "line\nbreak" }, { subtitle: {} }])(
      "rejects invalid text (%j)",
      async (body) => {
        process.env.PORTAL_ADMIN_USERS = "tester";
        const { PUT } = await import("./route");
        const res = await PUT(await putBody(body), undefined);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "brandingInvalid" });
        expect(mocks.patchNamespacedConfigMap).not.toHaveBeenCalled();
      },
    );

    it.each([
      {},
      { logo: 42 },
      { logo: {} },
      { logo: "https://example.com/logo.png" },
      { logo: "data:text/html;base64,PGgxPmhpPC9oMT4=" },
      { logo: `data:image/png;base64,${"A".repeat(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8)}` },
    ])("rejects an invalid logo value (%j)", async (body) => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      const { PUT } = await import("./route");
      const res = await PUT(
        await authedRequest({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        undefined,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "brandingInvalid" });
      expect(mocks.patchNamespacedConfigMap).not.toHaveBeenCalled();
    });

    it("reports a cluster failure instead of a saved logo", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      mocks.readNamespacedConfigMap.mockResolvedValue({ data: {} });
      mocks.patchNamespacedConfigMap.mockRejectedValue(new Error("forbidden"));
      const { PUT } = await import("./route");
      const res = await PUT(await put(LOGO), undefined);

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "brandingSaveFailed" });
    });

    it("rejects an unauthenticated request", async () => {
      process.env.PORTAL_ADMIN_USERS = "tester";
      const { PUT } = await import("./route");
      const res = await PUT(await bareGet(), undefined);

      expect(res.status).toBe(401);
    });
  });
});
