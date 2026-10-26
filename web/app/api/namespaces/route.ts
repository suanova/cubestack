import { getCoreClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

/**
 * The name a Namespace may carry: a DNS-1123 label, which is also what
 * `kubectl create namespace` enforces. Checked here as well as in the wizards
 * because the API is the only place every caller meets the same rule.
 */
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * Whether a client call failed because the object is already there.
 *
 * A namespace the platform already has is not an error for a create wizard: the
 * select offers `default` plus "create a new one", and a user who types the name
 * of a tenant namespace that already exists means to deploy into it, which they
 * may. Reading both shapes the client has carried keeps that true across a
 * client upgrade (see `isNotFound` in lib/kubernetes.ts).
 */
function isConflict(err: unknown): boolean {
  const e = err as { code?: number | string; statusCode?: number } | null;
  return e?.code === 409 || e?.statusCode === 409;
}

/**
 * Create the namespace a create wizard names.
 *
 * The wizards offer only `default` and this "create a new namespace" path, so
 * whatever the user types arrives here before the DevEnvironment or
 * InferenceService that lives in it. Answering 200 for a namespace that already
 * exists and is a tenant namespace lets the same field reuse it, and keeps a
 * double-clicked submit from reporting a failure that did not happen.
 */
export const POST = withAuth(async (req) => {
  try {
    const body: unknown = await req.json().catch(() => ({}));
    const name = typeof body === "object" && body !== null && "name" in body && typeof body.name === "string"
      ? body.name.trim()
      : "";
    if (!DNS_LABEL_RE.test(name)) {
      return Response.json({ error: "namespaceNameInvalid" }, { status: 400 });
    }

    try {
      await getCoreClient().createNamespace({ body: { metadata: { name } } });
      return Response.json({ name });
    } catch (err) {
      if (isConflict(err)) {
        // Use the existing list permission to inspect authoritative metadata.
        const namespaces = await getCoreClient().listNamespace({ fieldSelector: `metadata.name=${name}` });
        const metadata = namespaces.items.find((ns) => ns.metadata?.name === name)?.metadata;
        if (!metadata) throw new Error(`Namespace metadata unavailable: ${name}`);
        if (
          name.startsWith("kube-") ||
          metadata.labels?.["app.kubernetes.io/managed-by"] ||
          metadata.labels?.["ai.cubestack.io/managed-by"] ||
          metadata.annotations?.["meta.helm.sh/release-name"] ||
          metadata.annotations?.["meta.helm.sh/release-namespace"] ||
          metadata.ownerReferences?.length
        ) {
          return Response.json({ error: "namespaceManaged", params: { name } }, { status: 409 });
        }
        return Response.json({ name });
      }
      throw err;
    }
  } catch (err) {
    console.error("Failed to create namespace:", err);
    return Response.json(
      { error: "namespaceCreateFailed", params: { error: err instanceof Error ? err.message : String(err) } },
      { status: 500 },
    );
  }
});
