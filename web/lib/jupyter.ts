import { getCoreClient, getCustomObjectsClient, isNotFound } from "@/lib/kubernetes";

// Operator CRD group/version/plural (see app/api/devenvironments/route.ts).
const GROUP = "ai.cubestack.io";
const VERSION = "v1alpha1";
const PLURAL_DEVENV = "devenvironments";

// The key the operator writes the Jupyter server token under
// (operator/internal/controller: the token Secret's single entry).
const TOKEN_KEY = "token";

/** A reason the credential could not be read, as a route answers it. */
export interface JupyterRefusal {
  ok: false;
  /** The HTTP status the route answers with. */
  status: number;
  /** The code the console renders as a sentence (see lib/api-error.ts). */
  error: string;
  params?: Record<string, string>;
}

/** An environment's Jupyter credential, plus the state a session route needs. */
export interface JupyterCredential {
  ok: true;
  /** The decoded token, as the Jupyter server expects it in `?token=`. */
  token: string;
  /** The Secret it was read from, for the user who has to rotate it. */
  secret: { name: string; namespace: string };
  /**
   * The environment's published endpoints, carried so a route that also needs
   * one does not read the environment a second time.
   */
  endpoints: Array<{ name: string; address: string }>;
}

/**
 * The Jupyter token of one DevEnvironment, read from the Secret that
 * environment's own status points at.
 *
 * The Secret is *derived*, never named by the caller: the request identifies a
 * DevEnvironment, and the token comes from the Secret that environment's own
 * status points at. An environment can therefore only ever yield the credential
 * the operator published for it, and a route built on this is not a way to read
 * an arbitrary Secret by name. The read itself goes through the `list` verb the
 * chart already grants (field-selected to one name), because the portal's RBAC
 * grants no `get` on Secrets outside the htpasswd one — widening that to
 * cluster-wide `get` to serve these cards would hand the portal more than they
 * need.
 */
export async function readJupyterCredential(namespace: string, name: string): Promise<JupyterCredential | JupyterRefusal> {
  let secretName: string;
  let secretNamespace: string;
  let endpoints: Array<{ name: string; address: string }>;
  try {
    const co = getCustomObjectsClient();
    const env = (await co.getNamespacedCustomObject({ group: GROUP, version: VERSION, plural: PLURAL_DEVENV, namespace, name })) as {
      metadata?: { namespace?: string };
      status?: {
        jupyterTokenSecret?: { name?: string; namespace?: string };
        endpoints?: Array<{ name?: string; address?: string }>;
      };
    };
    if (!env?.metadata) return { ok: false, status: 404, error: "nameMissing", params: { name } };
    const ref = env.status?.jupyterTokenSecret;
    // Absent until the controller has published a token: a non-Jupyter type
    // never gets one, and a Jupyter environment has none until it is created.
    if (!ref?.name) return { ok: false, status: 404, error: "tokenMissing" };
    secretName = ref.name;
    secretNamespace = ref.namespace ?? env.metadata.namespace ?? namespace;
    endpoints = (env.status?.endpoints ?? []).flatMap((e) =>
      e.name && e.address ? [{ name: e.name, address: e.address }] : [],
    );
  } catch (err) {
    // The API server answers 404 for a name that is not there; anything else is
    // a read failure worth a 500 of its own.
    if (isNotFound(err)) return { ok: false, status: 404, error: "nameMissing", params: { name } };
    console.error("Failed to read the dev environment:", err);
    return { ok: false, status: 500, error: "tokenUnreadable" };
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
    // operator-side inconsistency the user cannot fix from the card, and not
    // the same message as "no token yet".
    if (!encoded) return { ok: false, status: 404, error: "tokenGone", params: { name: secretName } };
    return {
      ok: true,
      token: Buffer.from(encoded, "base64").toString("utf8"),
      secret: { name: secretName, namespace: secretNamespace },
      endpoints,
    };
  } catch (err) {
    if (isNotFound(err)) return { ok: false, status: 404, error: "tokenGone", params: { name: secretName } };
    console.error("Failed to read the jupyter token secret:", err);
    return { ok: false, status: 500, error: "tokenUnreadable" };
  }
}
