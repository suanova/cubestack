import { getCoreClient } from "@/lib/kubernetes";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

/**
 * GET /api/namespaces
 *
 * Lists all namespaces in the cluster and returns a lightweight projection
 * of each one.
 */
export async function GET() {
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
}
