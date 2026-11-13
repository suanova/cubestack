import { withAuth } from "@/lib/auth/guard";
import { readJupyterCredential } from "@/lib/jupyter";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler reads the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

/** The environment's own Jupyter token. */
export interface JupyterTokenResponse {
  /** The decoded token, as the Jupyter server expects it in `?token=`. */
  token: string;
  /** The Secret it was read from, for the user who has to rotate it. */
  secret: { name: string; namespace: string };
}

// The body is a credential: nothing in the path — browser, proxy, disk — gets to
// keep a copy of it.
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * A refusal the console renders from its dictionaries (see lib/api-error.ts).
 * `params` travels with the code because the sentences interpolate: a refusal
 * that carries no name renders as "环境 '' 不存在" in front of the user.
 */
const refuse = (code: string, status: number, params?: Record<string, string>) =>
  Response.json(params ? { error: code, params } : { error: code }, { status, headers: NO_STORE });


/**
 * GET /api/devenvironments/token?namespace=<ns>&name=<env>
 *
 * The Jupyter token for one environment, so the connection card can show it
 * behind a reveal toggle instead of handing the user a `kubectl` command to run
 * themselves — the console has cluster access and the user does not.
 *
 * The credential is derived from the environment (see lib/jupyter.ts), never
 * named by the caller.
 */
export const GET = withAuth(async (req) => {
  const params = new URL(req.url).searchParams;
  const namespace = (params.get("namespace") ?? "").trim();
  const name = (params.get("name") ?? "").trim();
  if (!namespace || !name) return refuse("requestInvalid", 400);

  const credential = await readJupyterCredential(namespace, name);
  if (!credential.ok) return refuse(credential.error, credential.status, credential.params);

  return Response.json(
    {
      token: credential.token,
      secret: credential.secret,
    } satisfies JupyterTokenResponse,
    { headers: NO_STORE },
  );
});
