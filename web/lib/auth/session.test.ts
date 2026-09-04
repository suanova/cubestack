// @vitest-environment node
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionSecret } from "./config";
import { signSession, verifySession } from "./session";

const SECRET = "unit-test-session-secret";

describe("session cookie signing", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("round-trips a signed session and recovers the user", async () => {
    const token = await signSession("admin");
    expect(token).toBeTruthy();
    const claims = await verifySession(token);
    expect(claims?.user).toBe("admin");
    expect(claims?.exp).toBeGreaterThan(Date.now());
  });

  it("rejects a tampered token (signature break)", async () => {
    const token = await signSession("admin");
    // Corrupt a character inside the signature. The very last base64url char
    // only carries padding bits for an HS256 (32-byte) signature, so flipping
    // it (e.g. A<->B) can leave the digest unchanged; mutate one earlier.
    const at = token.length - 6;
    const broken = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    expect(broken).not.toBe(token);
    expect(await verifySession(broken)).toBeNull();
  });

  it("rejects garbage / empty tokens", async () => {
    expect(await verifySession("")).toBeNull();
    expect(await verifySession("not-a-jwt")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const key = sessionSecret().key;
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("admin")
      .setIssuedAt((Date.now() / 1000) - 10)
      .setExpirationTime((Date.now() / 1000) - 5)
      .sign(key);
    expect(await verifySession(expired)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const otherKey = new TextEncoder().encode("a-different-secret");
    const foreign = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("admin")
      .setExpirationTime((Date.now() / 1000) + 3600)
      .sign(otherKey);
    expect(await verifySession(foreign)).toBeNull();
  });
})