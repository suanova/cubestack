// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { sessionSecret } from "./config";

// Next's type declarations mark NODE_ENV read-only; tests need to flip it.
function setNodeEnv(value: string): void {
  (process.env as { NODE_ENV?: string }).NODE_ENV = value;
}

describe("sessionSecret", () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
    setNodeEnv("test");
  });

  it("uses an explicit SESSION_SECRET when present", () => {
    process.env.SESSION_SECRET = "stable-secret";
    const { key, ephemeral } = sessionSecret();
    expect(ephemeral).toBe(false);
    expect(new TextDecoder().decode(key)).toBe("stable-secret");
  });

  it("falls back to an ephemeral random key outside production", () => {
    setNodeEnv("development");
    delete process.env.SESSION_SECRET;
    const a = sessionSecret();
    expect(a.ephemeral).toBe(true);
    expect(a.key.length).toBe(32);
    // A second read reuses the same cached process-local key.
    const b = sessionSecret();
    expect(b.key).toEqual(a.key);
  });

  it("throws when SESSION_SECRET is missing in production (fail closed)", () => {
    setNodeEnv("production");
    delete process.env.SESSION_SECRET;
    expect(() => sessionSecret()).toThrow(/SESSION_SECRET/);
  });
})