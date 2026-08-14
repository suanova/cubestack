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
  const api = getCoreClient();

  try {
    const namespaces = await api.listNamespace();

    return Response.json(
      namespaces.items.map((ns) => ({
        name: ns.metadata?.name,
        phase: ns.status?.phase,
        createdAt: ns.metadata?.creationTimestamp,
      })),
    );
  } catch (err) {
    return Response.json(
      { error: `Failed to list namespaces: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
