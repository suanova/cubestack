import { getCoreClient } from "@/lib/kubernetes";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// The development image catalog offered by the create wizard. There is no
// ComputeProfile CR in the operator (the DevEnvironment carries compute inline
// via spec.resources) — the image list is the platform's known base images,
// matching the prototype (public/devenv.html). Each entry pairs a tag with a
// short description shown in the select.
const IMAGES: Array<{ tag: string; label: string }> = [
  { tag: "base-cuda-12.4:v1.6", label: "base-cuda-12.4:v1.6 · CUDA 12.4 / PyTorch 2.5" },
  { tag: "base-cuda-12.1:v1.6", label: "base-cuda-12.1:v1.6 · CUDA 12.1 / PyTorch 2.4" },
  { tag: "base-maca-2.28:v1.3", label: "base-maca-2.28:v1.3 · MACA 2.28 (沐曦)" },
];

/** Catalog the create wizard needs, read from the live cluster. */
export interface DevEnvOptionsResponse {
  namespaces: Array<{ name: string }>;
  images: Array<{ tag: string; label: string }>;
}

/**
 * GET /api/devenvironments/options
 *
 * Namespaces come from the live cluster; the image catalog is static. The
 * wizard uses these to populate its namespace select and image select.
 */
export async function GET() {
  try {
    const core = getCoreClient();
    const nsRes = await core.listNamespace();

    const response: DevEnvOptionsResponse = {
      namespaces: (nsRes.items ?? [])
        .map((ns) => ns.metadata?.name)
        .filter((n): n is string => Boolean(n))
        .sort()
        .map((name) => ({ name })),
      images: IMAGES,
    };

    return Response.json(response);
  } catch (err) {
    console.error("Failed to load dev-environment create options:", err);
    return Response.json({ error: "Failed to load create options" }, { status: 500 });
  }
}