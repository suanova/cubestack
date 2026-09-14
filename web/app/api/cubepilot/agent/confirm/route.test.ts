// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authedGet, authedRequest, bareGet } from "@/test/auth";
import { __resetStore } from "@/lib/cubepilot/store";

const { GET, PUT } = await import("./route");

describe("/api/cubepilot/agent/confirm", () => {
  beforeEach(() => {
    __resetStore();
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("returns the merged allowlist view", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      confirmPolicy: string;
      templatePolicy: string;
      override: string;
      allowlist: Array<{ pattern: string; owned: boolean }>;
    };
    expect(body.confirmPolicy).toBe("Allowlist");
    expect(body.allowlist).toHaveLength(7);
    expect(body.allowlist.some((r) => r.pattern === "kubectl get" && r.owned === false)).toBe(true);
  });

  it("saves a policy override with the owned rules only", async () => {
    const res = await PUT(
      await authedRequest({
        method: "PUT",
        body: JSON.stringify({
          confirmPolicy: "None",
          allowlist: [{ pattern: "kubectl apply", argPattern: ".*", owned: true }],
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { override: string; confirmPolicy: string; allowlist: Array<{ owned: boolean }> };
    expect(body.override).toBe("None");
    expect(body.confirmPolicy).toBe("None");
    expect(body.allowlist.filter((r) => r.owned)).toHaveLength(1);
    // Platform rules are re-merged on read.
    expect(body.allowlist).toHaveLength(7);
  });

  it("accepts an empty policy (follow template) and rejects unknown ones", async () => {
    const follow = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "" }) }),
      undefined,
    );
    expect(follow.status).toBe(200);
    expect(((await follow.json()) as { confirmPolicy: string }).confirmPolicy).toBe("Allowlist");

    const bad = await PUT(
      await authedRequest({ method: "PUT", body: JSON.stringify({ confirmPolicy: "Whatever" }) }),
      undefined,
    );
    expect(bad.status).toBe(400);
  });
});
