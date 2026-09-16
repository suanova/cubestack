// CubePilot agent API (cubepilot-api) client — the server-side fetch layer for
// the REST-only surface of the CubePilot contract (docs/cubepilot/api.md
// §1 "Path A"): the chat SSE stream, session history, and HITL approval /
// question channels. These have no CRD form, so the portal proxies them and
// injects the caller's identity via the X-CubePilot-User header (the API has
// no auth of its own; the portal's session is the gate).
//
// The API is a separate stateless service (one Deployment + Service per the
// reference chart). Base-URL resolution mirrors gateway.ts:
//   1. CUBESTACK_PILOT_URL (explicit; off-cluster dev points here)
//   2. in-cluster default: http://cubepilot-api.<operator ns>.svc:8080
//      (the chart's Service name, in the same namespace as the agent CRs)
//   3. null → the routes answer 503 with a setup hint.

import { logger } from "@/lib/log";

import { inCluster } from "./gateway";
import { tasksNamespace } from "./taskcrd";

/** The reference chart's API Service name (api.name default). */
export const PILOT_SERVICE_NAME = "cubepilot-api";
const PILOT_PORT = 8080;

/** The in-cluster default base for the agent API (Service DNS in the operator ns). */
export function defaultPilotBase(): string {
  return `http://${PILOT_SERVICE_NAME}.${tasksNamespace()}.svc:${PILOT_PORT}`;
}

/**
 * The agent API base URL, or null when it cannot be reached from here (no env
 * override and not running in the cluster).
 */
export function resolvePilotBase(): string | null {
  const env = (process.env.CUBESTACK_PILOT_URL ?? "").trim();
  if (env) return env.replace(/\/+$/, "");
  if (inCluster()) return defaultPilotBase();
  return null;
}

/**
 * fetch() against the agent API. `path` must start with "/" (e.g.
 * "/api/v1/messages"). The caller's identity is attached as X-CubePilot-User;
 * a JSON content type is set for POSTs with a body unless already present.
 */
export async function pilotFetch(path: string, user: string, init: RequestInit = {}): Promise<Response> {
  const base = resolvePilotBase();
  if (!base) {
    logger("pilot").warn("agent API base unresolved — chat is unavailable", {
      hint: "set CUBESTACK_PILOT_URL or install cubepilot-api in " + (process.env.CUBESTACK_TASKS_NAMESPACE ?? "cubestack-system"),
    });
    throw new Error("agent API base unresolved");
  }
  logger("pilot").debug("upstream", { method: init.method ?? "GET", url: base + path });
  const headers: Record<string, string> = {
    "X-CubePilot-User": user,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(base + path, { ...init, headers });
}
