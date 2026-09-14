// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { GET } = await import("./route");

describe("/api/cubepilot/skills", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the platform skills", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; enabled: boolean }> };
    expect(body.skills.map((s) => s.name)).toEqual([
      "kubectl-platform",
      "gpu-inspect",
      "inference-deploy",
      "devenv-ops",
      "ceph-ops",
      "log-collect",
    ]);
    expect(body.skills.find((s) => s.name === "devenv-ops")?.enabled).toBe(false);
    expect(body.skills.filter((s) => s.enabled)).toHaveLength(4);
  });
});
