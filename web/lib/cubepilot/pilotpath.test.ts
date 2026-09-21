import { describe, expect, it } from "vitest";

import { enc, upstreamPath } from "./pilotpath";

// The portal's CubePilot proxy forwards exactly what this maps, so a path it
// answers with a string is a path a caller can reach with their own identity
// attached — and one it answers null for is a 404. Both halves matter, which is
// why the cases below are as much about what is REFUSED as what is allowed.

describe("upstreamPath — allowed", () => {
  it("maps the conversation itself, read and send", () => {
    // One path, two verbs: GET appends nothing and reads the transcript, POST
    // appends the message and answers with the turn it starts.
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "messages"])).toBe("/api/v1/sessions/k/messages");
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "messages"])).toBe("/api/v1/sessions/k/messages");
  });

  it("maps a session sub-resource to the method it answers", () => {
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "turn"])).toBe("/api/v1/sessions/k/turn");
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "abort"])).toBe("/api/v1/sessions/k/abort");
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "approvals"])).toBe("/api/v1/sessions/k/approvals");
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "approvals", "decision"])).toBe(
      "/api/v1/sessions/k/approvals/decision",
    );
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "questions"])).toBe("/api/v1/sessions/k/questions");
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "questions", "answer"])).toBe(
      "/api/v1/sessions/k/questions/answer",
    );
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "questions", "cancel"])).toBe(
      "/api/v1/sessions/k/questions/cancel",
    );
  });

  it("keeps a key's own slashes inside the key", () => {
    // Session keys are colon- and slash-shaped (`agent:main:conv-portal`), and
    // the API matches sub-resources by suffix — so the key is everything up to
    // the resource, re-encoded as one path. A two-segment tail moves the split,
    // not the key.
    expect(upstreamPath("GET", ["api", "v1", "sessions", "agent:main", "conv-1", "messages"])).toBe(
      `/api/v1/sessions/${enc(["agent:main", "conv-1"])}/messages`,
    );
    expect(upstreamPath("POST", ["api", "v1", "sessions", "agent:main", "conv-1", "questions", "answer"])).toBe(
      `/api/v1/sessions/${enc(["agent:main", "conv-1"])}/questions/answer`,
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

  it("refuses the API's own top-level send route, which no longer exists", () => {
    // A conversation is named by its path now, so there is nothing to send TO
    // without one. The proxy refusing it is what keeps a stale client from
    // reaching a route that is no longer there.
    expect(upstreamPath("POST", ["api", "v1", "messages"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "messages"])).toBeNull();
  });

  it("refuses a sub-resource asked for with the wrong method", () => {
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "turn"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "abort"])).toBeNull();
    // A collection and the action at its tail are two different paths, and
    // neither answers the other's method.
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "approvals"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "approvals", "decision"])).toBeNull();
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "questions"])).toBeNull();
    // DELETE with no key at all names nothing.
    expect(upstreamPath("DELETE", ["api", "v1", "sessions"])).toBeNull();
  });

  it("refuses a tail with no key in front of it", () => {
    // Otherwise the key would encode as the empty string and the request would
    // address a session that does not exist.
    expect(upstreamPath("POST", ["api", "v1", "sessions", "approvals", "decision"])).toBeNull();
    expect(upstreamPath("POST", ["api", "v1", "sessions", "questions", "answer"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "messages"])).toBeNull();
  });

  it("refuses a key that could climb out of the sessions prefix", () => {
    // encodeURIComponent leaves "." and ".." alone, so they are refused here
    // rather than encoded.
    expect(upstreamPath("DELETE", ["api", "v1", "sessions", ".."])).toBeNull();
    expect(upstreamPath("DELETE", ["api", "v1", "sessions", "."])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "..", "messages"])).toBeNull();
    expect(upstreamPath("GET", ["api", "v1", "sessions", "", "messages"])).toBeNull();
    expect(upstreamPath("POST", ["api", "v1", "sessions", "..", "approvals", "decision"])).toBeNull();
  });

  it("refuses an unknown sub-resource", () => {
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "transcript"])).toBeNull();
    expect(upstreamPath("POST", ["api", "v1", "sessions", "k", "delete"])).toBeNull();
    // turn/events is a real route upstream; this portal follows a turn by
    // polling the transcript, so it is not one this proxy carries.
    expect(upstreamPath("GET", ["api", "v1", "sessions", "k", "turn", "events"])).toBeNull();
  });
});
