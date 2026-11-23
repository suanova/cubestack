import { describe, expect, it } from "vitest";

import { envError, type EnvVar } from "./env";

describe("envError", () => {
  const roles = ["prefill", "decode", "router"];

  it("accepts a valid entry", () => {
    expect(envError([{ name: "A", value: "1", roles: ["prefill"] }], roles)).toBeNull();
  });

  it("rejects an unknown role", () => {
    expect(envError([{ name: "A", value: "1", roles: ["main"] }], roles)).toEqual({
      code: "envRoleUnknown",
      params: { name: "A", role: "main" },
    });
  });

  it("rejects a reserved prefix or a code-loading name", () => {
    for (const name of ["KUBERNETES_SERVICE_HOST", "CUBESTACK_ROLE", "LD_PRELOAD", "PYTHONPATH"]) {
      expect(envError([{ name, value: "x", roles: ["prefill"] }], roles)?.code).toBe("envNameReserved");
    }
  });

  it("rejects the same name for overlapping roles", () => {
    expect(
      envError(
        [
          { name: "A", value: "1", roles: ["prefill"] },
          { name: "A", value: "2", roles: ["prefill", "decode"] },
        ],
        roles,
      )?.code,
    ).toBe("envDuplicate");
  });

  it("accepts the same name for disjoint roles", () => {
    expect(
      envError(
        [
          { name: "A", value: "1", roles: ["prefill"] },
          { name: "A", value: "2", roles: ["decode"] },
        ],
        roles,
      ),
    ).toBeNull();
  });

  it("rejects an empty role list and an invalid name", () => {
    expect(envError([{ name: "A", value: "1", roles: [] }], roles)?.code).toBe("envRoleRequired");
    expect(envError([{ name: "MC-GID", value: "1", roles: ["prefill"] }], roles)?.code).toBe("envNameInvalid");
  });

  it("rejects a malformed entry shape instead of throwing", () => {
    expect(envError([{ name: "A", roles: ["prefill"] } as unknown as EnvVar], roles)?.code).toBe("envNameInvalid");
    expect(envError([{ name: true, value: "x", roles: ["prefill"] } as unknown as EnvVar], roles)?.code).toBe(
      "envNameInvalid",
    );
  });
});
