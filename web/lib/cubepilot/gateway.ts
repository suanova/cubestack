// AI Gateway client — reaches the Envoy AI Gateway from the portal's
// server-side route handlers. The base URL is resolved as:
//   1. CUBESTACK_GATEWAT_URL when set (e.g. http://<node>:30880 for a
//      NodePort, or an in-cluster DNS name);
//   2. the ai-gateway Service discovered in envoy-gateway-system:
//      - inside the cluster: plain in-cluster DNS (http://<svc>.<ns>.svc:<port>);
//      - local dev: the API-server service proxy, which works off-cluster and
//        is authenticated with the kubeconfig credentials (client certs/token);
//   3. in-cluster last resort: the well-known default base
//      (DEFAULT_GATEWAY_BASE), which needs no RBAC to list Services.
// CUBESTACK_GATEWAY_TOKEN, when set, is sent as a bearer header on every
// gateway request.

import { request as httpRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import { getCoreClient, getKubeConfig } from "@/lib/kubernetes";
import { logger } from "@/lib/log";

/** Namespace the AI Gateway Service is expected to live in
 *  (CUBESTACK_GATEWAY_NAMESPACE overrides the default). */
export const GATEWAY_NAMESPACE = (process.env.CUBESTACK_GATEWAY_NAMESPACE ?? "").trim() || "envoy-gateway-system";

/**
 * Well-known in-cluster base of the Envoy AI Gateway. Used when the portal
 * runs inside a cluster and CUBESTACK_GATEWAT_URL is unset — including when
 * Service discovery is unavailable (e.g. no RBAC to list Services). It is an
 * in-cluster DNS name, so it is only offered when actually running in-cluster.
 */
const DEFAULT_GATEWAY_BASE = "http://envoy-default-ai-gateway.envoy-gateway-system.svc:8080";

/** A resolved gateway base plus how to reach it. */
export interface GatewayBase {
  url: string;
  /** direct: plain URL (env override / in-cluster DNS). apiserver: service proxy. */
  via: "direct" | "apiserver";
  /** Set when CUBESTACK_GATEWAT_URL supplied the URL rather than discovery. */
  configured?: boolean;
}

export function inCluster(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT);
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Discover the ai-gateway Service in envoy-gateway-system and map it to a
 * reachable base: an in-cluster DNS URL when running in the cluster, or an
 * API-server service-proxy URL off-cluster. Null when nothing is found or the
 * cluster cannot be listed.
 */
async function discoverGatewayBase(): Promise<GatewayBase | null> {
  try {
    const core = getCoreClient();
    const res = await core.listNamespacedService({ namespace: GATEWAY_NAMESPACE });
    const svc = (res.items ?? []).find((s) => /ai-gateway/i.test(s.metadata?.name ?? ""));
    if (!svc) return null;
    const name = svc.metadata?.name ?? "";
    const port = svc.spec?.ports?.[0]?.port ?? 8080;
    if (inCluster()) {
      return { url: `http://${name}.${GATEWAY_NAMESPACE}.svc:${port}`, via: "direct" };
    }
    const cluster = getKubeConfig().getCurrentCluster();
    if (!cluster?.server) return null;
    return {
      url: `${cluster.server.replace(/\/+$/, "")}/api/v1/namespaces/${GATEWAY_NAMESPACE}/services/${name}:${port}/proxy`,
      via: "apiserver",
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the gateway base. CUBESTACK_GATEWAT_URL wins; otherwise the
 * ai-gateway Service is discovered (see discoverGatewayBase); in-cluster,
 * the well-known default base is the last resort; null when nothing applies.
 */
export async function resolveGatewayBase(): Promise<GatewayBase | null> {
  const explicit = (process.env.CUBESTACK_GATEWAT_URL ?? "").trim();
  if (explicit) {
    logger("gateway").debug("base from CUBESTACK_GATEWAT_URL", { url: explicit });
    return { url: explicit.replace(/\/+$/, ""), via: "direct", configured: true };
  }
  const discovered = await discoverGatewayBase();
  if (discovered) {
    logger("gateway").debug("base discovered from the Service", { url: discovered.url, via: discovered.via });
    return discovered;
  }
  if (inCluster()) {
    logger("gateway").debug("base from the well-known in-cluster name", { url: DEFAULT_GATEWAY_BASE });
    return { url: DEFAULT_GATEWAY_BASE, via: "direct" };
  }
  logger("gateway").warn("no gateway base resolved — system model list and playground chat are unavailable", {
    hint: "set CUBESTACK_GATEWAT_URL or install the gateway in " + GATEWAY_NAMESPACE,
  });
  return null;
}

/** Bearer header for the gateway when CUBESTACK_GATEWAY_TOKEN is set. */
export function gatewayTokenHeader(): Record<string, string> {
  const token = (process.env.CUBESTACK_GATEWAY_TOKEN ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Warn once per process — this is a property of the deployment, not of a call. */
let warnedPlainHttpToken = false;

/**
 * Note a bearer token about to cross a plain-HTTP hop on a base we resolved
 * ourselves (the in-cluster Service DNS the chart documents, where the token
 * stays on the cluster network). It is not refused — that is the supported
 * default. A base the operator configured is held to a higher standard; see
 * gatewayFetch.
 */
function warnIfTokenOverPlainHttp(url: string, headers: Record<string, string>): void {
  if (warnedPlainHttpToken || !headers.Authorization || url.startsWith("https://")) return;
  warnedPlainHttpToken = true;
  logger("gateway").warn("CUBESTACK_GATEWAY_TOKEN is sent over a non-HTTPS gateway URL", {
    url,
    hint: "serve the gateway over https, or drop the token where the network is trusted",
  });
}

/** Decode base64 cert data, or read a PEM file, into a Buffer (or undefined). */
function readTlsData(data?: string, file?: string): Buffer | undefined {
  if (data) return Buffer.from(data, "base64");
  if (file) {
    const raw = safeRead(file);
    if (raw !== undefined) return Buffer.from(raw);
  }
  return undefined;
}

/** Token from the user entry: direct token, or the in-cluster tokenFile provider. */
function resolveUserToken(user: { token?: string; authProvider?: unknown } | null | undefined): string | undefined {
  if (!user) return undefined;
  if (user.token) return user.token;
  const provider = user.authProvider as { name?: string; config?: { tokenFile?: string } } | undefined;
  if (provider?.name === "tokenFile" && provider.config?.tokenFile) return safeRead(provider.config.tokenFile);
  return undefined;
}

function toResponseHeaders(h: Record<string, string | string[] | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/**
 * fetch() against the k8s API server using the active kubeconfig credentials
 * (client certificate/key or token), for the service-proxy path. Node's
 * global fetch cannot carry client certificates, so this speaks raw TLS via
 * node:https and adapts the streamed response into a web Response.
 */
function apiServerFetch(url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const kc = getKubeConfig();
    const cluster = kc.getCurrentCluster();
    const user = kc.getCurrentUser();
    const u = new URL(url);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    const token = resolveUserToken(user);
    if (token) headers.Authorization = `Bearer ${token}`;
    const isHttps = u.protocol === "https:";
    const base = {
      hostname: u.hostname,
      port: isHttps ? Number(u.port) || 443 : Number(u.port) || 80,
      path: `${u.pathname}${u.search}`,
      method: init.method ?? "GET",
      headers,
    };
    const agent = isHttps
      ? new Agent({
          ca: readTlsData(cluster?.caData, cluster?.caFile),
          cert: readTlsData(user?.certData, user?.certFile),
          key: readTlsData(user?.keyData, user?.keyFile),
          keepAlive: false,
        })
      : undefined;
    const req = isHttps ? httpsRequest({ ...base, agent }) : httpRequest(base);
    req.on("response", (res) => {
      resolve(new Response(Readable.toWeb(res as Readable) as ReadableStream<Uint8Array>, {
        status: res.statusCode ?? 0,
        headers: toResponseHeaders(res.headers),
      }));
    });
    req.on("error", reject);
    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });
}

/**
 * fetch() against the AI Gateway. `path` is appended to the resolved base
 * (service-proxy bases end in /proxy, so /v1/models lands after the marker).
 */
export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await resolveGatewayBase();
  if (!base) {
    throw new Error(
      `AI gateway not found: set CUBESTACK_GATEWAT_URL or install the gateway in namespace ${GATEWAY_NAMESPACE}`,
    );
  }
  const token = gatewayTokenHeader();
  // A base we resolved ourselves may be plain HTTP (the in-cluster Service DNS
  // the chart documents) — warned about, not refused. A configured one is the
  // operator's own URL: sending the token over cleartext there is refused,
  // because nothing about an http:// URL they typed implies a trusted network.
  if (base.configured && token.Authorization && !base.url.startsWith("https://")) {
    // Logged as well as thrown: some callers treat a gateway failure as "no
    // models" and would otherwise swallow the reason.
    logger("gateway").warn("refusing to send CUBESTACK_GATEWAY_TOKEN over a non-HTTPS CUBESTACK_GATEWAT_URL", {
      url: base.url,
      hint: "use an https:// gateway URL, or unset CUBESTACK_GATEWAY_TOKEN",
    });
    throw new Error(
      `refusing to send CUBESTACK_GATEWAY_TOKEN to ${base.url}: CUBESTACK_GATEWAT_URL is not https`,
    );
  }
  warnIfTokenOverPlainHttp(base.url, token);
  const headers = { ...token, ...(init.headers as Record<string, string> | undefined) };
  const url = base.url + path;
  return base.via === "apiserver" ? apiServerFetch(url, { ...init, headers }) : fetch(url, { ...init, headers });
}
