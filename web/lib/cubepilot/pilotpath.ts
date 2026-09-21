// The allow-list that decides which CubePilot agent-API requests the portal
// will proxy (app/api/cubepilot/pilot/[...path]/route.ts).
//
// It lives here, apart from the route, because it is the boundary rather than
// the plumbing: every request it answers null for is a 404, and every request it
// maps is forwarded with the caller's identity attached. Pure string work, so it
// is under unit test rather than reachable only through a running server.

/**
 * Encode a session key (its "/"-separated segments) into one upstream path, or
 * null when it cannot be encoded. encodeURIComponent leaves "." and ".."
 * untouched, so a decoded request carrying %2e%2e would join into a path the
 * URL parser resolves away, escaping the /api/v1/sessions prefix.
 */
export const enc = (segments: string[]): string | null => {
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.map(encodeURIComponent).join("/");
};

/**
 * The session sub-resources this portal may reach, as the trailing path
 * segments plus the method that addresses them. The tail is what identifies a
 * sub-resource: the key in front of it is everything else, because a key may
 * contain slashes and the API recovers it by stripping a known suffix.
 *
 * It is the set of requests THIS portal makes, not the set the API offers.
 * `turn/events` is a real route upstream and deliberately absent: this pane
 * follows a turn by polling its transcript rather than by observing it.
 */
const SUBRESOURCE: Array<{ tail: string[]; method: string }> = [
  // The conversation itself, both halves: GET reads the transcript, POST
  // appends a message and answers with the turn that message starts.
  { tail: ["messages"], method: "GET" },
  { tail: ["messages"], method: "POST" },
  { tail: ["turn"], method: "GET" },
  { tail: ["abort"], method: "POST" },
  { tail: ["approvals"], method: "GET" },
  { tail: ["approvals", "decision"], method: "POST" },
  { tail: ["questions"], method: "GET" },
  { tail: ["questions", "answer"], method: "POST" },
  { tail: ["questions", "cancel"], method: "POST" },
];

/**
 * Maps an allowed request to its upstream path, or null when the shape is not
 * one of the client-facing chat/session endpoints. A session key may contain
 * slashes (the API matches session sub-resources by suffix), so the key is
 * everything between "sessions" and the sub-resource's own tail.
 */
export function upstreamPath(method: string, segments: string[]): string | null {
  if (segments[0] !== "api" || segments[1] !== "v1") return null;
  const rest = segments.slice(2);
  if (rest.length === 1 && rest[0] === "sessions" && method === "GET") return "/api/v1/sessions";
  // DELETE names the session itself (api.md §4.7), and its key is everything
  // after `sessions/` — the API matches sub-resources by suffix, so a key that
  // happens to end in `/messages` is still a key. Handled before the sub-resource
  // table below, which reads the tail as a resource name.
  if (rest.length >= 2 && rest[0] === "sessions" && method === "DELETE") {
    const key = enc(rest.slice(1));
    return key === null ? null : `/api/v1/sessions/${key}`;
  }
  if (rest.length < 3 || rest[0] !== "sessions") return null;
  for (const { tail, method: answers } of SUBRESOURCE) {
    if (answers !== method) continue;
    // The key is what is left of the path in front of the tail, and it has to
    // be at least one segment: without this the bare `sessions/<tail>` would
    // encode as the empty key and address a session that does not exist.
    if (rest.length < tail.length + 2) continue;
    if (!tail.every((segment, i) => rest[rest.length - tail.length + i] === segment)) continue;
    const key = enc(rest.slice(1, -tail.length));
    return key === null ? null : `/api/v1/sessions/${key}/${tail.join("/")}`;
  }
  return null;
}
