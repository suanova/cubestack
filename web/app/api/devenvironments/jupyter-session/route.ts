import { withAuth } from "@/lib/auth/guard";
import { readJupyterCredential } from "@/lib/jupyter";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler reads the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// Long enough to outlast a gateway hiccup, short enough that a click which
// cannot reach the environment says so instead of hanging.
const UPSTREAM_TIMEOUT_MS = 10_000;

// The response is a session: nothing in the path — browser, proxy, disk — gets
// to keep a copy of it.
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * A refusal the console renders from its dictionaries (see lib/api-error.ts).
 */
const refuse = (code: string, status: number, params?: Record<string, string>) =>
  Response.json(params ? { error: code, params } : { error: code }, { status, headers: NO_STORE });

/**
 * Jupyter's identity cookie, named after the host and port it was minted on.
 * That is the only one relayed: the XSRF cookie is installed by the page load
 * that follows, with the attributes the server itself wants, so relaying it
 * would only be a second guess at them — and anything else the server (or
 * something in front of it) sets is not the portal's to store on its own origin.
 */
const isRelayedCookie = (name: string) => name.startsWith("username-");

/**
 * The environment's session cookies, re-issued for the portal's origin.
 *
 * Only the name and value are taken from the environment; the scope is the
 * environment's own path, so the cookie opens exactly the environment it was
 * minted for and nothing else. No expiry is carried either: the login lasts for
 * the browser session, and a click fetches a fresh one anyway.
 */
function relayedCookies(setCookie: string[], path: string, secure: boolean): string[] {
  const out: string[] = [];
  for (const raw of setCookie) {
    const pair = raw.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq <= 0 || !isRelayedCookie(pair.slice(0, eq))) continue;
    out.push(`${pair}; Path=${path}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  }
  return out;
}

/**
 * GET /api/devenvironments/jupyter-session?namespace=<ns>&name=<env>
 *
 * Opens one environment's JupyterLab without the user typing, copying, or ever
 * seeing its token. The portal authenticates against the environment's own
 * published endpoint with `Authorization: token <token>`, keeps the identity
 * cookie Jupyter answers with, and hands it to the browser scoped to the
 * environment's path; the console then navigates to the clean `<endpoint>lab`.
 *
 * Why the published endpoint and not the pod: Jupyter names its identity cookie
 * after the host and port it was asked on, and the browser sends it back under
 * that name — so the request that mints the cookie has to address the
 * environment the way the browser will. Why a cookie at all: the token never
 * enters a URL, so nothing in the path can record it — not the Gateway's access
 * log, not the browser's history, not a URL someone shares.
 *
 * The cookie is set on the console's own origin, so the console has to be
 * reached under the same host as the environment — which is how the platform
 * serves them (the console under the Gateway's own `/cubestack` path). A
 * deployment that splits the two onto different hosts cannot use this relay;
 * the browser would never send the cookie back.
 */
export const GET = withAuth(async (req) => {
  const params = new URL(req.url).searchParams;
  const namespace = (params.get("namespace") ?? "").trim();
  const name = (params.get("name") ?? "").trim();
  if (!namespace || !name) return refuse("requestInvalid", 400);

  // The token and the endpoints come from the environment the request names;
  // a caller cannot point this route at another address to hand its credential
  // to.
  const credential = await readJupyterCredential(namespace, name);
  if (!credential.ok) return refuse(credential.error, credential.status, credential.params);

  const endpoint = credential.endpoints.find((e) => e.name === "jupyter");
  if (!endpoint) return refuse("jupyterMissing", 404, { name });

  let lab: string;
  let path: string;
  let secure: boolean;
  try {
    const base = new URL(endpoint.address.endsWith("/") ? endpoint.address : `${endpoint.address}/`);
    lab = new URL("lab", base).toString();
    path = base.pathname;
    // Secure is about where the cookie may be *sent*, so it follows the
    // environment's scheme, not the console's: a console served over TLS that
    // hands the browser a plain-HTTP endpoint would otherwise mark a cookie the
    // browser then refuses to send.
    secure = base.protocol === "https:";
  } catch (err) {
    console.error("The jupyter endpoint is not a URL:", endpoint.address, err);
    return refuse("jupyterUnreachable", 502);
  }

  let upstream: Response;
  try {
    upstream = await fetch(lab, {
      // The token travels in a header, never in the URL.
      headers: { authorization: `token ${credential.token}` },
      // A login that answers with a redirect is a login that failed: following
      // it would hide where the request ended up.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("Failed to reach the jupyter endpoint:", lab, err);
    return refuse("jupyterUnreachable", 502);
  }

  // An authenticated page load answers 200 and installs the identity cookie.
  // The request carries none of the browser's cookies — the server mints a
  // fresh one for it — so an accepted token always answers with one, and an
  // answer without one means the token was not accepted (Jupyter renders its
  // login page instead). Anything but 200 is the same refusal, up front.
  await upstream.body?.cancel().catch(() => {});
  if (!upstream.ok) return refuse("jupyterLoginFailed", 502);

  const cookies = relayedCookies(upstream.headers.getSetCookie(), path, secure);
  if (cookies.length === 0) return refuse("jupyterLoginFailed", 502);

  const headers = new Headers(NO_STORE);
  headers.set("content-type", "application/json");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ url: lab }), { status: 200, headers });
});
