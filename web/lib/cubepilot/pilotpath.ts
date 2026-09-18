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
 * Maps an allowed request to its upstream path, or null when the shape is not
 * one of the client-facing chat/session endpoints. A session key may contain
 * slashes (the API matches session sub-resources by suffix), so the key is
 * everything between "sessions" and the tail segment.
 */
export function upstreamPath(method: string, segments: string[]): string | null {
  if (segments[0] !== "api" || segments[1] !== "v1") return null;
  const rest = segments.slice(2);
  if (rest.length === 1 && rest[0] === "messages" && method === "POST") return "/api/v1/messages";
  if (rest.length === 1 && rest[0] === "sessions" && method === "GET") return "/api/v1/sessions";
  // DELETE names the session itself (api.md §4.7), and its key is everything
  // after `sessions/` — the API matches sub-resources by suffix, so a key that
  // happens to end in `/messages` is still a key. Handled before the sub-resource
  // table below, which reads the last segment as a resource name.
  if (rest.length >= 2 && rest[0] === "sessions" && method === "DELETE") {
    const key = enc(rest.slice(1));
    return key === null ? null : `/api/v1/sessions/${key}`;
  }
  if (rest.length < 3 || rest[0] !== "sessions") return null;
  const tail = rest[rest.length - 1];
  if (tail === "pending") {
    const action = rest[rest.length - 2];
    // sessions/<key…>/<approval|question>/pending — the key is ≥1 segment.
    if ((action === "approval" || action === "question") && method === "GET" && rest.length >= 4) {
      const key = enc(rest.slice(1, -2));
      return key === null ? null : `/api/v1/sessions/${key}/${action}/pending`;
    }
    return null;
  }
  const tailMethod: Record<string, string> = {
    messages: "GET",
    abort: "POST",
    turn: "GET",
    approval: "POST",
    question: "POST",
  };
  if (tailMethod[tail] === method) {
    const key = enc(rest.slice(1, -1));
    return key === null ? null : `/api/v1/sessions/${key}/${tail}`;
  }
  return null;
}
