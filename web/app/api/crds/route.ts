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
  const api = getApiextensionsClient();

  try {
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
    return Response.json(
      { error: `Failed to list CRDs: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
