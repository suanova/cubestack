import { getApiextensionsClient } from "@/lib/kubernetes";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

/**
 * GET /api/crds
 *
 * Lists all CustomResourceDefinitions registered in the cluster and returns a
 * lightweight projection of each one.
 */
export async function GET() {
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
}
