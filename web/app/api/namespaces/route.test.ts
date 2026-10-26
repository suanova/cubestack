// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authedRequest, bareGet } from "@/test/auth";

const { createNamespace } = vi.hoisted(() => ({ createNamespace: vi.fn() }));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ createNamespace }),
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
  });

  it("creates the namespace the wizard named", async () => {
    const { POST } = await import("./route");
    const res = await POST(await post("team-a"), undefined);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "team-a" });
    expect(createNamespace).toHaveBeenCalledWith({ body: { metadata: { name: "team-a" } } });
  });

  it("trims the name it was given", async () => {
    const { POST } = await import("./route");
    await POST(await post("  team-a  "), undefined);

    // A padded name is a different namespace to the API server, and the
    // environment is then created in the trimmed one.
    expect(createNamespace).toHaveBeenCalledWith({ body: { metadata: { name: "team-a" } } });
  });

  it("answers 200 for a namespace that already exists", async () => {
    // The select offers `default` plus this entry, so a user reusing an
    // existing tenant namespace by name is the ordinary case, not a clash.
    createNamespace.mockRejectedValue({ code: 409, message: "already exists" });
    const { POST } = await import("./route");
    const res = await POST(await post("team-a"), undefined);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "team-a" });
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
