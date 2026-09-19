import { describe, expect, it } from "vitest";

import { enc, upstreamPath } from "./pilotpath";

// The portal's CubePilot proxy forwards exactly what this maps, so a path it
// answers with a string is a path a caller can reach with their own identity
// attached — and one it answers null for is a 404. Both halves matter, which is
// why the cases below are as much about what is REFUSED as what is allowed.

describe("upstreamPath — allowed", () => {
  it("maps the chat send", () => {
    expect(upstreamPath("POST", ["api", "v1", "messages"])).toBe("/api/v1/messages");
  });

  it("maps a session sub-resource to the method it answers", () => {
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "messages"])).toBe("/api/v1/sessions/k/messages");
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "turn"])).toBe("/api/v1/sessions/k/turn");
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "abort"])).toBe("/api/v1/sessions/k/abort");
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "approval"])).toBe("/api/v1/sessions/k/approval");
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "question"])).toBe("/api/v1/sessions/k/question");
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "approval", "pending"])).toBe(
      "/api/v1/sessions/k/approval/pending",
    );
  });

  it("keeps a key's own slashes inside the key", () => {
    // Session keys are colon- and slash-shaped (`agent:main:conv-portal`), and
    // the API matches sub-resources by suffix — so the key is everything up to
    // the resource, re-encoded as one path.
    expect(upstreamPath("GET", ["api", "v1", "sessions", "agent:main", "conv-1", "messages"])).toBe(
      `/api/v1/sessions/${enc(["agent:main", "conv-1"])}/messages`,
    );
  });

  it("maps DELETE to the session itself (api.md §4.7)", () => {
    expect(upstreamPath("DELETE", ["api", "v1", "sessions", "k"])).toBe("/api/v1/sessions/k");
  });

  it("reads DELETE's key as the whole tail, not as a sub-resource", () => {
    // The API's own rule: no sub-resource accepts DELETE, so a DELETE always
    // names the session the path ends at — even when its key ends in a segment
    // that names a resource elsewhere. Reading the last segment as a resource
    // name, the way the GET table does, would turn this into the key "a".
    expect(upstreamPath("DELETE", ["api", "v1", "sessions", "a", "messages"])).toBe("/api/v1/sessions/a/messages");
    expect(upstreamPath("DELETE", ["api", "v1", "sessions", "a", "b", "turn"])).toBe("/api/v1/sessions/a/b/turn");
  });
});

describe("upstreamPath — refused", () => {
  it("refuses everything outside /api/v1", () => {
    expect(upstreamPath("GET", ["api", "v2", "sessions", "k", "messages"])).toBeNull();
    expect(upstreamPath("GET", ["healthz"])).toBeNull();
    expect(upstreamPath("GET", [])).toBeNull();
  });

  it("refuses a sub-resource asked for with the wrong method", () => {
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "messages"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "abort"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "approval"])).toBeNull();
    // DELETE with no key at all names nothing.
    expect(upstreamPath("DELETE", ["api", "v1", "sessions"])).toBeNull();
  });

  it("refuses a key that could climb out of the sessions prefix", () => {
    // encodeURIComponent leaves "." and ".." alone, so they are refused here
    // rather than encoded.
    expect(upstreamPath("DELETE", ["api", "v1", "sessions", ".."])).toBeNull();
    expect(upstreamPath("DELETE", ["api", "v1", "sessions", "."])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "..", "messages"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "", "messages"])).toBeNull();
  });

  it("refuses an unknown sub-resource", () => {
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "transcript"])).toBeNull();
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "delete"])).toBeNull();
  });
});
