import { getApiextensionsClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered at
// build time (Next 14 statically generates route handlers that don't use the
// request object; that would hang on the kubeconfig/cluster call).
export const dynamic = "force-dynamic";

/**
 * GET /api/crds
 *
 * Lists all CustomResourceDefinitions registered in the cluster and returns a
 * lightweight projection of each one.
 */
export const GET = withAuth(async () => {
  try {
    // Built lazily inside the try so a kubeconfig-load failure surfaces as a
    // 500 JSON response instead of an unhandled throw.
    const api = getApiextensionsClient();
    const crds = await api.listCustomResourceDefinition();

    return Response.json(
      crds.items.map((crd) => ({
        name: crd.metadata?.name,
        group: crd.spec.group,
        kind: crd.spec.names.kind,
        plural: crd.spec.names.plural,
        versions: crd.spec.versions.map((v) => v.name),
      })),
    );
  } catch (err) {
    // Log the full error server-side; keep the client response free of internals.
    console.error("Failed to list CRDs:", err);
    return Response.json({ error: "Failed to list CRDs" }, { status: 500 });
  }
});
