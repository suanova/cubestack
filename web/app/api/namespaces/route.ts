import { getCoreClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered at
// build time (Next 14 statically generates route handlers that don't use the
// request object; that would hang on the kubeconfig/cluster call).
export const dynamic = "force-dynamic";

/**
 * GET /api/namespaces
 *
 * Lists all namespaces in the cluster and returns a lightweight projection
 * of each one.
 */
export const GET = withAuth(async () => {
  try {
    // Built lazily inside the try so a kubeconfig-load failure surfaces as a
    // 500 JSON response instead of an unhandled throw.
    const api = getCoreClient();
    const namespaces = await api.listNamespace();

    return Response.json(
      namespaces.items.map((ns) => ({
        name: ns.metadata?.name,
        phase: ns.status?.phase,
        createdAt: ns.metadata?.creationTimestamp,
      })),
    );
  } catch (err) {
    // Log the full error server-side; keep the client response free of internals.
    console.error("Failed to list namespaces:", err);
    return Response.json({ error: "Failed to list namespaces" }, { status: 500 });
  }
});
