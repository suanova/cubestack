// Next's `basePath` (next.config.mjs) rewrites <Link>, <Image>, the router and
// static assets for us — but NOT raw fetch() calls, window.location navigation,
// or server-side redirects. Anything we address by hand goes through here so the
// prefix is applied in exactly one place.

import { BASE_PATH } from "../base-path.mjs";

export { BASE_PATH };

/**
 * Prefix a root-relative path with the deployment base path.
 *
 * Idempotent: a path that already carries the prefix is returned unchanged, so
 * a value round-tripped through the `?next=` login redirect can be prefixed
 * again without doubling up.
 */
export function withBasePath(path: string): string {
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  // Root maps to the bare base path: "/cubestack/" would take an extra
  // trailing-slash redirect under Next's default trailingSlash: false.
  if (path === "/") return BASE_PATH;
  return `${BASE_PATH}${path}`;
}

/** fetch() against an app route, carrying the deployment base path. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(withBasePath(path), init);
}
