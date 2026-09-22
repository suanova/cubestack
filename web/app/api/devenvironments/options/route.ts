import { getCoreClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";
import { DEV_IMAGES } from "@/lib/devenvironments/images";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// The catalog lives in lib/devenvironments/images.ts because the create route
// derives the environment's runtime identity from the same list; the wizard
// is sent only what it displays.
const IMAGES: Array<{ tag: string; label: string }> = DEV_IMAGES.map(({ tag, label }) => ({
  tag,
  label,
}));

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
export const GET = withAuth(async () => {
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
});