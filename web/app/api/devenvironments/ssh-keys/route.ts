import { getCoreClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// The label the operator requires on a Secret before it will mount it as a
// workload's authorized_keys. Only Secrets that name themselves for this use
// are offered here, so the wizard never surfaces a key Secret the operator
// would refuse (operator/api/v1alpha1/devenvironment_types.go, SSHSpec).
const DELEGATED_LABEL = "ai.cubestack.io/ssh-keys-delegated=true";

/** One labelled key Secret, with the data entries it offers as authorized_keys. */
export interface SshKeySecretOption {
  name: string;
  /** The Secret's data keys — the only part the picker needs to fill
   * spec.ssh.authorizedKeysSecret.key. The values are never returned. */
  keys: string[];
}

/** The labelled key Secrets in one namespace, for the wizard's SSH picker. */
export interface SshKeySecretsResponse {
  namespace: string;
  secrets: SshKeySecretOption[];
}

/**
 * GET /api/devenvironments/ssh-keys?namespace=<ns>
 *
 * Lists the Secrets in one namespace that carry the operator's delegation
 * label, so the wizard's SSH picker can offer only the key Secrets the
 * controller will actually mount. A Secret's data values are never returned —
 * only its name and the keys it holds, which is all the picker needs to fill
 * spec.ssh.authorizedKeysSecret.
 */
export const GET = withAuth(async (req) => {
  try {
    const namespace = new URL(req.url).searchParams.get("namespace");
    if (!namespace) {
      return Response.json({ error: "namespace is required" }, { status: 400 });
    }
    const core = getCoreClient();
    const res = await core.listNamespacedSecret({ namespace, labelSelector: DELEGATED_LABEL });
    // A labelled Secret with no data entries cannot serve as authorized_keys
    // (there is no key to mount), so it is excluded rather than offered as a
    // dead-end choice.
    const secrets: SshKeySecretOption[] = (res.items ?? [])
      .map((s) => ({ name: s.metadata?.name ?? "", keys: Object.keys(s.data ?? {}) }))
      .filter((s) => s.name && s.keys.length > 0);
    return Response.json({ namespace, secrets } satisfies SshKeySecretsResponse);
  } catch (err) {
    console.error("Failed to list ssh key secrets:", err);
    return Response.json({ error: "Failed to list ssh key secrets" }, { status: 500 });
  }
});
