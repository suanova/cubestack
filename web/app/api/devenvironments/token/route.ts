import { getCoreClient, getCustomObjectsClient, isNotFound } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler reads the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// Operator CRD group/version/plural (see app/api/devenvironments/route.ts).
const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";
const PLURAL_DEVENV = "devenvironments";

// The key the operator writes the Jupyter server token under
// (operator/internal/controller: the token Secret's single entry).
const TOKEN_KEY = "token";

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
 * The Secret is *derived*, never named by the caller: the request identifies a
 * DevEnvironment, and the token comes from the Secret that environment's own
 * status points at. An environment can therefore only ever yield the credential
 * the operator published for it, and this route is not a way to read an
 * arbitrary Secret by name. The read itself goes through the `list` verb the
 * chart already grants (field-selected to one name), because the portal's RBAC
 * grants no `get` on Secrets outside the htpasswd one — widening that to
 * cluster-wide `get` to serve this card would hand the portal more than the card
 * needs.
 */
export const GET = withAuth(async (req) => {
  const params = new URL(req.url).searchParams;
  const namespace = (params.get("namespace") ?? "").trim();
  const name = (params.get("name") ?? "").trim();
  if (!namespace || !name) return refuse("requestInvalid", 400);

  let secretName: string;
  let secretNamespace: string;
  try {
    const co = getCustomObjectsClient();
    const env = (await co.getNamespacedCustomObject({ group: GROUP, version: VERSION, plural: PLURAL_DEVENV, namespace, name })) as {
      metadata?: { namespace?: string };
      status?: { jupyterTokenSecret?: { name?: string; namespace?: string } };
    };
    if (!env?.metadata) return refuse("nameMissing", 404, { name });
    const ref = env.status?.jupyterTokenSecret;
    // Absent until the controller has published a token: a non-Jupyter type
    // never gets one, and a Jupyter environment has none until it is created.
    if (!ref?.name) return refuse("tokenMissing", 404);
    secretName = ref.name;
    secretNamespace = ref.namespace ?? env.metadata.namespace ?? namespace;
  } catch (err) {
    // The API server answers 404 for a name that is not there; anything else is
    // a read failure worth a 500 of its own.
    if (isNotFound(err)) return refuse("nameMissing", 404, { name });
    console.error("Failed to read the dev environment:", err);
    return refuse("tokenUnreadable", 500);
  }

  try {
    const core = getCoreClient();
    const res = await core.listNamespacedSecret({
      namespace: secretNamespace,
      fieldSelector: `metadata.name=${secretName}`,
    });
    const data = res.items?.[0]?.data ?? {};
    const encoded = data[TOKEN_KEY];
    // The CR names a Secret that is not there, or that carries no token: an
    // operator-side inconsistency the user cannot fix from this card, and not
    // the same message as "no token yet".
    if (!encoded) return refuse("tokenGone", 404, { name: secretName });
    return Response.json(
      {
        token: Buffer.from(encoded, "base64").toString("utf8"),
        secret: { name: secretName, namespace: secretNamespace },
      } satisfies JupyterTokenResponse,
      { headers: NO_STORE },
    );
  } catch (err) {
    if (isNotFound(err)) return refuse("tokenGone", 404, { name: secretName });
    console.error("Failed to read the jupyter token secret:", err);
    return refuse("tokenUnreadable", 500);
  }
});
