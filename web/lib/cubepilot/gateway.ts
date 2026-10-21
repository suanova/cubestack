// AI Gateway client — reaches the Envoy AI Gateway from the portal's
// server-side route handlers. The base URL is resolved as:
//   1. CUBESTACK_GATEWAT_URL when set (e.g. http://<node>:30880 for a
//      NodePort, or an in-cluster DNS name);
//   2. the dataplane Services of the platform Gateways, discovered in
//      envoy-gateway-system by the label Envoy Gateway stamps on them. The
//      platform installs one Gateway per model catalog — the public
//      `<GATEWAY_NAME>` (cubestack-gateway) and the private
//      `<GATEWAY_NAME>-private` (cubestack-gateway-private) — so discovery
//      returns a list, and the model list is the union of their /v1/models
//      answers. (The catalog *routes* are the differently named
//      cubestack-ai-gateway / cubestack-ai-gateway-private.)
//      - inside the cluster: plain in-cluster DNS (http://<svc>.<ns>.svc:<port>);
//      - local dev: the API-server service proxy, which works off-cluster and
//        is authenticated with the kubeconfig credentials (client certs/token).
//      The Service's generated name ends in a random suffix, so it is found by
//      label rather than guessed from a name. CUBESTACK_GATEWAY_NAMES (comma
//      separated) pins an exact list; CUBESTACK_GATEWAY_NAME (or the default,
//      cubestack-gateway) is the public Gateway and also admits its
//      `<name>-<suffix>` siblings.
// CUBESTACK_GATEWAY_TOKEN, when set, is sent as a bearer header on every
// gateway request.

import { request as httpRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import { getCoreClient, getKubeConfig } from "@/lib/kubernetes";
import { logger } from "@/lib/log";
import { isChatModel } from "./llm";
import { PLATFORM_MODEL_NAME, type GatewayModel } from "./types";

/** Namespace the AI Gateway Services live in
 *  (CUBESTACK_GATEWAY_NAMESPACE overrides the default). */
export const GATEWAY_NAMESPACE = (process.env.CUBESTACK_GATEWAY_NAMESPACE ?? "").trim() || "envoy-gateway-system";

/** The public Gateway's name older platform installs use and the chart's
 *  default (CUBESTACK_GATEWAY_NAME overrides the default). Every platform
 *  Gateway name is this, or starts with `<name>-`. */
export const GATEWAY_NAME = (process.env.CUBESTACK_GATEWAY_NAME ?? "").trim() || "cubestack-gateway";

/** Whether a Gateway belongs to the platform's model catalogs: the public
 *  Gateway itself or one of its `<name>-<suffix>` siblings (the private
 *  catalog's Gateway is `cubestack-gateway-private`). A Gateway someone else
 *  installed in the namespace is not part of the platform's catalog. */
function isPlatformGatewayName(name: string): boolean {
  const gateway = name.trim().toLowerCase();
  const base = GATEWAY_NAME.toLowerCase();
  return gateway === base || gateway.startsWith(`${base}-`);
}

/** The names to discover. CUBESTACK_GATEWAY_NAMES (comma separated) pins an
 *  exact list; otherwise the platform's own Gateways are discovered (see
 *  isPlatformGatewayName). */
function pinnedGatewayNames(): string[] | null {
  const names = (process.env.CUBESTACK_GATEWAY_NAMES ?? "").trim();
  if (!names) return null;
  return names.split(",").map((n) => n.trim()).filter(Boolean);
}

/** Public Gateway first: it is the endpoint shown to users and the one the
 *  original "cubestack" provider entry points at. The rest keep a stable
 *  order regardless of the order the API server lists the Services in. */
function byGatewayOrder(a: string, b: string): number {
  const base = GATEWAY_NAME.toLowerCase();
  const aPublic = a.toLowerCase() === base;
  const bPublic = b.toLowerCase() === base;
  if (aPublic !== bPublic) return aPublic ? -1 : 1;
  return a.localeCompare(b);
}

/** The label Envoy Gateway puts on the dataplane Service it generates for a
 *  Gateway. The Service's name is `envoy-<namespace>-<gateway>-<random>`, so
 *  this label — not the name — is what identifies the one we want. */
const GATEWAY_DATAPLANE_NAME_LABEL = "gateway.envoyproxy.io/owning-gateway-name";

/** A resolved gateway base plus how to reach it. */
export interface GatewayBase {
  /** The Gateway resource the base belongs to; absent for an explicit URL. */
  name?: string;
  url: string;
  /** direct: plain URL (env override / in-cluster DNS). apiserver: service proxy. */
  via: "direct" | "apiserver";
  /** Set when CUBESTACK_GATEWAT_URL supplied the URL rather than discovery. */
  configured?: boolean;
  /** The dataplane Service the URL was resolved from; absent for an explicit
   *  URL. Its in-cluster DNS name and port are what a pod inside the cluster
   *  dials, however the portal itself reaches the gateway (off-cluster it goes
   *  through the API-server service proxy). */
  service?: { name: string; namespace: string; port: number };
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
 * Discover the dataplane Services of the platform Gateways in
 * GATEWAY_NAMESPACE and map each to a reachable base: an in-cluster DNS URL
 * when running in the cluster, or an API-server service-proxy URL off-cluster.
 * Empty when nothing is found or the cluster cannot be listed.
 *
 * The public and private catalog Gateways are separate (cubestack-gateway and
 * cubestack-gateway-private on the platform's install), so each is queried for
 * its own model list; the public one is listed first as the displayed base.
 *
 * The answer is memoized (see BASE_TTL_MS): discovery is a Service LIST, and
 * every gateway call used to pay for one.
 */
async function discoverGatewayBases(): Promise<GatewayBase[]> {
  try {
    const core = getCoreClient();
    const res = await core.listNamespacedService({ namespace: GATEWAY_NAMESPACE });
    const services = (res.items ?? []).filter(
      (s) => typeof s.metadata?.labels?.[GATEWAY_DATAPLANE_NAME_LABEL] === "string",
    );
    const byGateway = new Map<string, (typeof services)[number]>();
    for (const svc of services) {
      const name = svc.metadata?.labels?.[GATEWAY_DATAPLANE_NAME_LABEL] as string;
      if (!byGateway.has(name)) byGateway.set(name, svc);
    }
    // An explicit list wins; otherwise every platform Gateway in the
    // namespace, public first. Discovery is by label, so the private catalog's
    // Gateway is found under whatever name its install gave it, as long as it
    // follows the platform's `<GATEWAY_NAME>-<suffix>` convention.
    const pinned = pinnedGatewayNames();
    const names = pinned ?? [...byGateway.keys()].filter(isPlatformGatewayName).sort(byGatewayOrder);

    const cluster = inCluster() ? null : getKubeConfig().getCurrentCluster();
    if (!inCluster() && !cluster?.server) return [];
    const bases: GatewayBase[] = [];
    for (const name of names) {
      const svc = byGateway.get(name);
      if (!svc) continue;
      const serviceName = svc.metadata?.name ?? "";
      const port = svc.spec?.ports?.[0]?.port ?? 8080;
      const service = { name: serviceName, namespace: GATEWAY_NAMESPACE, port };
      if (inCluster()) {
        bases.push({ name, url: `http://${serviceName}.${GATEWAY_NAMESPACE}.svc:${port}`, via: "direct", service });
      } else {
        bases.push({
          name,
          url: `${cluster!.server!.replace(/\/+$/, "")}/api/v1/namespaces/${GATEWAY_NAMESPACE}/services/${serviceName}:${port}/proxy`,
          via: "apiserver",
          service,
        });
      }
    }
    return bases;
  } catch {
    return [];
  }
}

/** How long resolved bases are reused. Short enough that a gateway installed
 *  after the portal is picked up without a restart. */
const BASE_TTL_MS = 30_000;
let basesCache: { bases: GatewayBase[]; loadedAt: number } | null = null;
/** The discovery in flight: a cold portal answers several requests at once, and
 *  each used to run its own LIST. */
let basesInflight: Promise<GatewayBase[]> | null = null;

/** How long a gateway's model catalog is reused. A catalog answer is stable
 *  for far longer than this, and every read of it used to be a live call that
 *  a slow gateway could hold for the whole timeout. */
const CATALOG_TTL_MS = 30_000;
/** A failed catalog call is remembered only briefly: enough to stop a burst of
 *  reads from hammering a gateway that is down, short enough to notice it
 *  coming back. */
const CATALOG_ERROR_TTL_MS = 5_000;
interface CatalogCacheEntry {
  models: GatewayModel[] | null;
  loadedAt: number;
  ttlMs: number;
}
/** Per gateway base URL: each Gateway answers its own /v1/models, and the
 *  union is what the chat surfaces show. */
const catalogCache = new Map<string, CatalogCacheEntry>();
/** The catalog calls in flight, keyed like the cache, so concurrent readers
 *  share one call per gateway instead of each waiting it out. */
const catalogInflight = new Map<string, Promise<GatewayModel[] | null>>();

/** Clear the memoized bases and catalogs (tests; a gateway that moved). */
export function clearGatewayCaches(): void {
  basesCache = null;
  basesInflight = null;
  catalogCache.clear();
  catalogInflight.clear();
}

/**
 * Resolve the gateway bases. CUBESTACK_GATEWAT_URL wins and yields one base;
 * otherwise the platform Gateways' dataplane Services are discovered (see
 * discoverGatewayBases); empty when there is nothing to discover and no URL
 * was configured.
 */
export async function resolveGatewayBases(): Promise<GatewayBase[]> {
  const explicit = (process.env.CUBESTACK_GATEWAT_URL ?? "").trim();
  if (explicit) {
    logger("gateway").debug("base from CUBESTACK_GATEWAT_URL", { url: explicit });
    return [{ url: explicit.replace(/\/+$/, ""), via: "direct", configured: true }];
  }
  const cached = basesCache;
  if (cached && Date.now() - cached.loadedAt < BASE_TTL_MS) return cached.bases;
  if (basesInflight) return basesInflight;
  const flight = (async (): Promise<GatewayBase[]> => {
    const discovered = await discoverGatewayBases();
    if (discovered.length > 0) {
      logger("gateway").debug("bases discovered from the Services", {
        gateways: discovered.map((b) => b.name),
      });
      basesCache = { bases: discovered, loadedAt: Date.now() };
      return discovered;
    }
    logger("gateway").warn("no gateway base resolved — system model list and playground chat are unavailable", {
      namespace: GATEWAY_NAMESPACE,
      gateways: pinnedGatewayNames() ?? `${GATEWAY_NAME} or ${GATEWAY_NAME}-*`,
      hint: "set CUBESTACK_GATEWAT_URL, or point CUBESTACK_GATEWAY_NAMES / CUBESTACK_GATEWAY_NAMESPACE at the platform Gateways",
    });
    basesCache = { bases: [], loadedAt: Date.now() };
    return [];
  })();
  basesInflight = flight;
  try {
    return await flight;
  } finally {
    if (basesInflight === flight) basesInflight = null;
  }
}

/** The primary (public) gateway base, or null when none resolves. */
export async function resolveGatewayBase(): Promise<GatewayBase | null> {
  return (await resolveGatewayBases())[0] ?? null;
}

/**
 * The private catalog Gateway's in-cluster Service address — the endpoint a
 * caller inside the cluster reaches the private route on — or null when
 * discovery finds no private Gateway. The dataplane Service name ends in a
 * generated suffix, so it is taken from discovery rather than composed from the
 * Gateway name. The public gateway's own base is deliberately not used: off
 * cluster it is an API-server proxy URL, which no in-cluster caller can dial.
 */
export async function privateGatewayClusterEndpoint(): Promise<string | null> {
  const base = (await resolveGatewayBases()).find((b) => b.name === `${GATEWAY_NAME}-private`);
  if (!base?.service) return null;
  return `http://${base.service.name}.${base.service.namespace}.svc:${base.service.port}`;
}

/**
 * One Gateway's chat model catalogue, memoized per base so neither a slow
 * gateway nor a burst of reads pays for the same call repeatedly. Models
 * served for another modality are dropped: every caller (the chat tab, the
 * assistant's model picker, the platform provider a save writes) speaks chat
 * completions. Null when this gateway could not be reached or did not answer a
 * list.
 */
async function gatewayCatalogAt(base: GatewayBase, timeoutMs: number): Promise<GatewayModel[] | null> {
  const key = base.url;
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.loadedAt < cached.ttlMs) return cached.models;
  const inflight = catalogInflight.get(key);
  if (inflight) return inflight;
  const flight = (async (): Promise<GatewayModel[] | null> => {
    let models: GatewayModel[] | null = null;
    try {
      const res = await fetchAtBase(base, "/v1/models", { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
        if (Array.isArray(body.data)) {
          models = body.data
            .filter((m): m is { id: string; owned_by?: unknown } => typeof m?.id === "string" && m.id.length > 0)
            .map((m) => ({ id: m.id, ownedBy: typeof m.owned_by === "string" ? m.owned_by : "" }))
            // The catalogue mixes modalities (the gateway serves image and
            // embedding models beside chat ones), and every caller of this
            // function is a chat surface: the chat tab, the assistant's model
            // picker, and the platform provider the save writes.
            .filter((m) => isChatModel(m.id));
        }
      } else {
        logger("gateway").warn("model catalog unavailable: the gateway answered an error", {
          gateway: base.name ?? "-",
          status: res.status,
        });
      }
    } catch (e) {
      // Worth saying out loud: this call sits on the config read's path, and a
      // silent empty list used to hide a gateway that was down for days.
      logger("gateway").warn("model catalog unavailable", {
        gateway: base.name ?? "-",
        url: base.url,
        error: String(e),
      });
    }
    catalogCache.set(key, {
      models,
      loadedAt: Date.now(),
      ttlMs: models === null ? CATALOG_ERROR_TTL_MS : CATALOG_TTL_MS,
    });
    return models;
  })();
  catalogInflight.set(key, flight);
  try {
    return await flight;
  } finally {
    if (catalogInflight.get(key) === flight) catalogInflight.delete(key);
  }
}

/**
 * The union of the platform Gateways' chat catalogues (public first), merged
 * by model id so a model published to both appears once. This is what the
 * chat surfaces list: the public and private Gateways serve disjoint model
 * sets, and neither answer alone is the platform's catalogue.
 * Null only when every Gateway failed to answer — the caller decides what
 * that means (the chat tab reads it as "no platform models", the playground
 * answers 502).
 */
export async function gatewayCatalog(timeoutMs = 2500): Promise<GatewayModel[] | null> {
  const bases = await resolveGatewayBases();
  if (bases.length === 0) return null;
  const catalogs = await Promise.all(bases.map((base) => gatewayCatalogAt(base, timeoutMs)));
  if (catalogs.every((models) => models === null)) return null;
  const merged: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const models of catalogs) {
    for (const model of models ?? []) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
  }
  return merged;
}

/**
 * Each resolved Gateway with its own chat catalogue, public first. A Gateway
 * that could not be read contributes an empty list, so a caller pairing a model
 * with the endpoint that serves it sees exactly the ids that endpoint answers
 * for. Empty when no base resolves.
 */
export async function gatewayCatalogs(
  timeoutMs = 2500,
): Promise<Array<{ base: GatewayBase; models: GatewayModel[] }>> {
  const bases = await resolveGatewayBases();
  const catalogs = await Promise.all(bases.map((base) => gatewayCatalogAt(base, timeoutMs)));
  return bases.map((base, i) => ({ base, models: catalogs[i] ?? [] }));
}

/**
 * The Gateway that serves `model`, public first, or null when no catalogue
 * lists it (including when the catalogues could not be read). The chat proxy
 * uses this to send a private model to the private Gateway.
 */
export async function gatewayBaseForModel(model: string, timeoutMs = 2500): Promise<GatewayBase | null> {
  const bases = await resolveGatewayBases();
  if (bases.length === 0) return null;
  const catalogs = await Promise.all(bases.map((base) => gatewayCatalogAt(base, timeoutMs)));
  const index = catalogs.findIndex((models) => models?.some((m) => m.id === model));
  return index < 0 ? null : bases[index];
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
    // The caller's signal has to reach this path too: it is the slowest way to
    // the gateway (through the API server), and a stalled response would hold the
    // caller — and its stream — open past the timeout it asked for. Both halves
    // are covered: the request before the headers, the body after them.
    const signal = init.signal ?? null;
    let response: (Readable & { destroy: (error?: Error) => void }) | null = null;
    const onAbort = () => {
      const error = new Error("gateway request aborted");
      if (response) response.destroy(error);
      else req.destroy(error);
      reject(error);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.on("response", (res) => {
      response = res as Readable & { destroy: (error?: Error) => void };
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
 * fetch() against one resolved gateway. `path` is appended to the base
 * (service-proxy bases end in /proxy, so /v1/models lands after the marker).
 */
async function fetchAtBase(base: GatewayBase, path: string, init: RequestInit = {}): Promise<Response> {
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

/**
 * The OpenAI-compatible base of a resolved gateway (the endpoint the agent
 * runtime must call): its URL with `/v1` appended — a full request URL or an
 * existing `/v1` is normalised, never doubled.
 */
export function gatewayOpenAiBaseOf(base: GatewayBase): string {
  let url = base.url.trim().replace(/\/+$/, "");
  const suffix = "/chat/completions";
  if (url.toLowerCase().endsWith(suffix)) url = url.slice(0, -suffix.length).replace(/\/+$/, "");
  return url.toLowerCase().endsWith("/v1") ? url : `${url}/v1`;
}

/**
 * The AgentTemplate provider name a Gateway's catalogue is written under. The
 * public Gateway keeps the original "cubestack" (refs stored before the private
 * catalogue existed name it), and any other Gateway gets a stable
 * "cubestack-<suffix>" derived from its own name — the private Gateway,
 * "cubestack-gateway-private", becomes "cubestack-private". Derived from the
 * name rather than from discovery order, so one Gateway missing from discovery
 * never renames another one's entry.
 */
export function platformProviderNameOf(base: GatewayBase): string {
  const gateway = (base.name ?? "").trim().toLowerCase();
  const publicName = GATEWAY_NAME.toLowerCase();
  // The public Gateway, the older route-named Gateway and an explicitly
  // configured URL all keep the original name.
  if (!gateway || gateway === publicName || gateway === "cubestack-ai-gateway" || gateway === PLATFORM_MODEL_NAME) {
    return PLATFORM_MODEL_NAME;
  }
  // Strip the platform's own prefix: `<public>-private` is "private", and an
  // install that names its Gateways after the catalog routes keeps working.
  const prefix = `${publicName}-`;
  const stripped = gateway.startsWith(prefix)
    ? gateway.slice(prefix.length)
    : gateway.replace(/^cubestack-(?:ai-gateway-)?/, "");
  const suffix = stripped.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return suffix ? `${PLATFORM_MODEL_NAME}-${suffix}` : PLATFORM_MODEL_NAME;
}

function noGatewayError(): Error {
  return new Error(
    `AI gateway not found: no dataplane Service for the Gateways in ${GATEWAY_NAMESPACE} — set CUBESTACK_GATEWAT_URL, or CUBESTACK_GATEWAY_NAMES / CUBESTACK_GATEWAY_NAMESPACE`,
  );
}

/** fetch() against the primary (public) gateway. */
export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await resolveGatewayBase();
  if (!base) throw noGatewayError();
  return fetchAtBase(base, path, init);
}

/**
 * fetch() against the gateway that lists `model`. A model the catalogues do
 * not list (or a catalogue that could not be read) falls back to the primary
 * gateway, preserving the pre-two-gateway behaviour for that request.
 */
export async function gatewayFetchForModel(
  model: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = (await gatewayBaseForModel(model)) ?? (await resolveGatewayBase());
  if (!base) throw noGatewayError();
  return fetchAtBase(base, path, init);
}
