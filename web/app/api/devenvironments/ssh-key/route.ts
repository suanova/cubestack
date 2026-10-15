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

// The key the operator writes the generated client keypair's private half under
// (operator/internal/controller: the client key Secret's entry).
const CLIENT_KEY = "id_ed25519";

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
 * GET /api/devenvironments/ssh-key?namespace=<ns>&name=<env>
 *
 * The private half of the keypair the controller minted for one environment, so
 * the connection card can hand it to the user as a file to log in with —
 * `ssh -i id_ed25519 user@host -p port`.
 *
 * Like the Jupyter token route, the Secret is *derived*, never named by the
 * caller: the request identifies a DevEnvironment, and the key comes from the
 * Secret that environment's own status points at (status.sshClientKeySecret).
 * An environment can therefore only ever yield the credential the operator
 * published for it, and this route is not a way to read an arbitrary Secret by
 * name. Environments whose spec names the user's own key Secret publish no
 * client key and answer keyMissing: nothing was minted, and the user's private
 * half was never in the cluster to hand out.
 *
 * The read itself goes through the `list` verb the chart already grants
 * (field-selected to one name), as the token route's does: the portal's RBAC
 * grants no `get` on Secrets outside the htpasswd one.
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
      status?: { sshClientKeySecret?: { name?: string; namespace?: string } };
    };
    if (!env?.metadata) return refuse("nameMissing", 404, { name });
    const ref = env.status?.sshClientKeySecret;
    // Absent when the spec names the user's own key Secret (no key was minted)
    // or until the controller has minted one: either way, not "gone".
    if (!ref?.name) return refuse("keyMissing", 404);
    secretName = ref.name;
    secretNamespace = ref.namespace ?? env.metadata.namespace ?? namespace;
  } catch (err) {
    // The API server answers 404 for a name that is not there; anything else is
    // a read failure worth a 500 of its own.
    if (isNotFound(err)) return refuse("nameMissing", 404, { name });
    console.error("Failed to read the dev environment:", err);
    return refuse("keyUnreadable", 500);
  }

  try {
    const core = getCoreClient();
    const res = await core.listNamespacedSecret({
      namespace: secretNamespace,
      fieldSelector: `metadata.name=${secretName}`,
    });
    const data = res.items?.[0]?.data ?? {};
    const encoded = data[CLIENT_KEY];
    // The CR names a Secret that is not there, or that carries no key: an
    // operator-side inconsistency the user cannot fix from this card, and not
    // the same message as "no key yet".
    if (!encoded) return refuse("keyGone", 404, { name: secretName });
    return new Response(Buffer.from(encoded, "base64"), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${CLIENT_KEY}"`,
        ...NO_STORE,
      },
    });
  } catch (err) {
    if (isNotFound(err)) return refuse("keyGone", 404, { name: secretName });
    console.error("Failed to read the ssh client key secret:", err);
    return refuse("keyUnreadable", 500);
  }
});
