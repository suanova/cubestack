// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const { listNamespacedSecret } = vi.hoisted(() => ({
  listNamespacedSecret: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ listNamespacedSecret }),
}));

async function importRoute() {
  return import("./route");
}

/** A request carrying a valid session, aimed at the ssh-keys route. */
function req(namespace?: string) {
  const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
  return authedRequest({ method: "GET" }, `http://localhost/api/devenvironments/ssh-keys${qs}`);
}

describe("GET /api/devenvironments/ssh-keys", () => {
  beforeEach(() => {
    vi.resetModules();
    listNamespacedSecret.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the labelled key Secrets in the namespace, with their data keys", async () => {
    listNamespacedSecret.mockResolvedValue({
      items: [
        { metadata: { name: "alice-keys" }, data: { "alice@laptop": "a2V5", "alice@phone": "cGhvbmU=" } },
        { metadata: { name: "bob-keys" }, data: { "bob@desktop": "c2VjcmV0" } },
      ],
    });
    const { GET } = await importRoute();
    const res = await GET(await req("project-a"), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      namespace: "project-a",
      secrets: [
        { name: "alice-keys", keys: ["alice@laptop", "alice@phone"] },
        { name: "bob-keys", keys: ["bob@desktop"] },
      ],
    });
    // The list is scoped to the namespace and the operator's delegation label,
    // so the wizard never offers a key Secret the controller would refuse. The
    // data values are never echoed back — only the keys that fill the picker.
    expect(listNamespacedSecret).toHaveBeenCalledWith({
      namespace: "project-a",
      labelSelector: "ai.cubestack.io/ssh-keys-delegated=true",
    });
  });

  it("drops a labelled Secret that holds no data keys", async () => {
    listNamespacedSecret.mockResolvedValue({
      items: [
        { metadata: { name: "empty-keys" }, data: {} },
        { metadata: { name: "used-keys" }, data: { "user@host": "dmFsdWU=" } },
      ],
    });
    const { GET } = await importRoute();
    const res = await GET(await req("project-a"), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    // A labelled Secret with no data entries cannot serve as authorized_keys,
    // so it is excluded rather than offered as a dead-end choice.
    expect(body.secrets).toEqual([{ name: "used-keys", keys: ["user@host"] }]);
  });

  it("returns an empty list when no labelled Secret exists", async () => {
    listNamespacedSecret.mockResolvedValue({ items: [] });
    const { GET } = await importRoute();
    const res = await GET(await req("project-a"), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secrets).toEqual([]);
  });

  it("rejects a request without a namespace", async () => {
    const { GET } = await importRoute();
    const res = await GET(await req(), undefined);
    expect(res.status).toBe(400);
    expect(listNamespacedSecret).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request", async () => {
    const { GET } = await importRoute();
    const res = await GET(await bareGet(), undefined);
    expect(res.status).toBe(401);
    expect(listNamespacedSecret).not.toHaveBeenCalled();
  });
});
