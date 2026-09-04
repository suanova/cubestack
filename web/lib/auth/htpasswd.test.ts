// @vitest-environment node
import { hashSync } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readNamespacedSecret } = vi.hoisted(() => ({
  readNamespacedSecret: vi.fn(),
}));

vi.mock("@/lib/kubernetes", () => ({
  getCoreClient: () => ({ readNamespacedSecret }),
}));

import { parseHtpasswd, resetHtpasswdCache, verifyCredentials } from "./htpasswd";

describe("parseHtpasswd", () => {
  it("parses user:hash lines into a map", () => {
    const hash1 = hashSync("s3cretA", 4);
    const hash2 = hashSync("s3cretB", 4);
    const entries = parseHtpasswd(`admin:${hash1}\noperator:${hash2}\n`);
    expect([...entries.keys()]).toEqual(["admin", "operator"]);
    expect(entries.get("admin")).toBe(hash1);
    expect(entries.get("operator")).toBe(hash2);
  });

  it("ignores blank lines, comments and malformed entries", () => {
    const entries = parseHtpasswd("# comment\n\n  \nno-colon-here\n:hashonly\nuser:\n  user2  :hash\n");
    expect(entries.size).toBe(1);
    expect(entries.get("user2")).toBe("hash");
  });
});

describe("verifyCredentials", () => {
  beforeEach(() => {
    resetHtpasswdCache();
    delete process.env.HTPASSWD_SECRET_NAME;
    delete process.env.HTPASSWD_SECRET_NAMESPACE;
    delete process.env.HTPASSWD_SECRET_KEY;
  });
  afterEach(() => {
    readNamespacedSecret.mockReset();
    resetHtpasswdCache();
  });

  function stubSecret(lines: string) {
    readNamespacedSecret.mockResolvedValue({
      data: { htpasswd: Buffer.from(lines, "utf8").toString("base64") },
    });
  }

  it("accepts valid credentials for a known user", async () => {
    const hash = hashSync("correct-battery", 4);
    stubSecret(`admin:${hash}\n`);
    expect(await verifyCredentials("admin", "correct-battery")).toBe("admin");
  });

  it("rejects a wrong password and an unknown user", async () => {
    const hash = hashSync("expected", 4);
    stubSecret(`admin:${hash}\n`);
    expect(await verifyCredentials("admin", "wrong")).toBeNull();
    expect(await verifyCredentials("nobody", "expected")).toBeNull();
  });

  it("rejects empty username/password without calling the cluster", async () => {
    const hash = hashSync("pw", 4);
    stubSecret(`admin:${hash}\n`);
    expect(await verifyCredentials("", "pw")).toBeNull();
    expect(await verifyCredentials("admin", "")).toBeNull();
  });

  it("caches the Secret across calls within the TTL", async () => {
    const hash = hashSync("pw", 4);
    stubSecret(`admin:${hash}\n`);
    expect(await verifyCredentials("admin", "pw")).toBe("admin");
    expect(await verifyCredentials("admin", "pw")).toBe("admin");
    expect(readNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it("throws a descriptive error when the Secret is unreadable (404)", async () => {
    readNamespacedSecret.mockRejectedValue({ statusCode: 404, message: "not found" });
    await expect(verifyCredentials("admin", "pw")).rejects.toThrow(/cubestack-htpasswd/);
    await expect(verifyCredentials("admin", "pw")).rejects.toThrow(/not found/);
  });
})