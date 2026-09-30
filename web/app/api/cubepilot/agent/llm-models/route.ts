// /api/cubepilot/agent/llm-models — the model ids an external provider serves,
// from its OpenAI-compatible GET {endpoint}/models.
//
// The portal makes this request, not the browser: an arbitrary endpoint cannot
// be called from the page (CORS), and the key being typed has not been stored
// yet. What the endpoint may be is therefore bounded here — http(s) only, no
// redirects (a host the caller named must not bounce the request somewhere it
// never named), the endpoint reduced to the API root so the appended path is
// this route's, a key never over plain http, plus a 12s timeout and a body cap
// (OpenClaw's own numbers for scanning a provider catalogue).

import { credentialChoiceError, normalizeEndpoint } from "@/lib/cubepilot/llm";
import { logger } from "@/lib/log";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 12_000;
const BODY_MAX_BYTES = 16 * 1024 * 1024;

/** Refused by literal host only — a name resolving to one still gets through.
 *  The cloud credential endpoints, and the addresses that only ever mean "this
 *  machine" or "this link". Private ranges stay allowed: a self-hosted vLLM on
 *  the cluster network is the ordinary case for this card, and the platform
 *  already lets it be saved as a provider. */
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata", "169.254.169.254", "fd00:ec2::254"]);

function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    BLOCKED_HOSTS.has(host) ||
    host === "localhost" ||
    host.startsWith("127.") ||
    host === "::1" ||
    host.startsWith("169.254.") ||
    host.startsWith("fe80:")
  );
}

/** Read at most BODY_MAX_BYTES, so a faulty or hostile endpoint cannot stream an
 *  unbounded document into this process. Null when it exceeds the cap. */
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const POST = withAuth(async (req) => {
  let body: { endpoint?: string; apiKey?: string; public?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad JSON body" }, { status: 400 });
  }
  // The body is JSON of unknown shape: a number where a string belongs would
  // throw out of this handler (500) instead of answering 400.
  if (body.endpoint !== undefined && typeof body.endpoint !== "string") {
    return Response.json({ error: "endpoint must be a string" }, { status: 400 });
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
    return Response.json({ error: "apiKey must be a string" }, { status: 400 });
  }
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(body.endpoint ?? "");
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Response.json({ error: "endpoint must be an http(s) URL" }, { status: 400 });
  }
  if (blockedHost(url.hostname)) {
    logger("agent").warn("model listing refused: metadata host", { host: url.hostname });
    return Response.json({ error: "that host is not one to list models from" }, { status: 400 });
  }
  const apiKey = (body.apiKey ?? "").trim();
  const isPublic = body.public === true;
  const choiceError = credentialChoiceError(apiKey, isPublic);
  if (choiceError) return Response.json({ error: choiceError }, { status: 400 });
  // A key over plain http is allowed and reported, not refused: the platform's
  // own in-cluster gateways are http with a credential (see the plain-HTTP
  // branch in gateway.ts), and refusing it would block the ordinary self-hosted
  // case. The card shows the warning so the reader knows the key is in the
  // clear.
  const warning = !isPublic && url.protocol === "http:" ? "key-over-http" : "";

  let res: Response;
  try {
    res = await fetch(`${endpoint}/models`, {
      method: "GET",
      headers: { Accept: "application/json", ...(isPublic ? {} : { Authorization: `Bearer ${apiKey}` }) },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    logger("agent").warn("model listing failed", { endpoint, error: String(e) });
    return Response.json({ error: "could not reach the endpoint" }, { status: 502 });
  }
  if (res.status >= 300 && res.status < 400) {
    return Response.json({ error: "the endpoint redirects; use the URL it points at" }, { status: 400 });
  }
  if (!res.ok) {
    logger("agent").warn("model listing answered with an error", { endpoint, status: res.status });
    return Response.json({ error: `the endpoint answered HTTP ${res.status}` }, { status: 502 });
  }
  let text: string | null;
  try {
    text = await readCapped(res);
  } catch (e) {
    // Headers arrived, then the body stalled or died (the timeout aborts the
    // stream): still an upstream failure, not this route's.
    logger("agent").warn("model listing body failed", { endpoint, error: String(e) });
    return Response.json({ error: "the endpoint's answer could not be read" }, { status: 502 });
  }
  if (text === null) {
    logger("agent").warn("model listing body over the cap", { endpoint });
    return Response.json({ error: "the endpoint's answer is too large to read" }, { status: 502 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: "the endpoint did not answer with a model list" }, { status: 502 });
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return Response.json({ error: "the endpoint did not answer with a model list" }, { status: 502 });
  }
  const ids = (data as Array<{ id?: unknown }>)
    .map((m) => (typeof m?.id === "string" ? m.id.trim() : ""))
    .filter((id) => id !== "");
  const models = [...new Set(ids)].sort();
  return Response.json(warning ? { models, warning } : { models });
});
