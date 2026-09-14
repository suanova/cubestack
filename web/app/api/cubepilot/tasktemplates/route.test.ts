// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { authedGet, bareGet } from "@/test/auth";

const { GET } = await import("./route");

describe("/api/cubepilot/tasktemplates", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    expect((await GET(await bareGet(), undefined)).status).toBe(401);
  });

  it("lists the preset templates", async () => {
    const res = await GET(await authedGet(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskTemplates: Array<{ name: string; instruction: string; defaultCron: string; paramsSchema: Array<{ name: string }> }>;
    };
    expect(body.taskTemplates.map((t) => t.name)).toEqual(["cluster-inspect", "gpu-health", "inference-verify"]);
    expect(body.taskTemplates[0].defaultCron).toBe("0 6 * * *");
    expect(body.taskTemplates[2].paramsSchema.map((p) => p.name)).toEqual(["namespace"]);
  });
});
