import { getCoreClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";
import { DEV_IMAGES } from "@/lib/devenvironments/images";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// The catalog lives in lib/devenvironments/images.ts because the create route
// falls back to the same list; the wizard is sent only what it displays — which
// now includes each image's runtime identity, since the wizard shows it and
// pre-fills the editable account / uid / gid fields from it.
const IMAGES: DevEnvImageOption[] = DEV_IMAGES.map(({ tag, label, user, runAsGroup }) => ({
  tag,
  label,
  user,
  runAsGroup,
}));

/** One selectable image, with the identity the wizard pre-fills from it. */
export interface DevEnvImageOption {
  tag: string;
  label: string;
  /** spec.runtime.user the image's own sshd serves. */
  user: string;
  /** spec.runtime.securityContext.runAsGroup, when 1000 is wrong for this image. */
  runAsGroup?: number;
}

/** Catalog the create wizard needs, read from the live cluster. */
export interface DevEnvOptionsResponse {
  namespaces: Array<{ name: string }>;
  images: DevEnvImageOption[];
}

/**
 * GET /api/devenvironments/options
 *
 * Namespaces come from the live cluster; the image catalog is static. The
 * wizard uses these to populate its namespace select and the image combobox,
 * and to pre-fill the runtime identity the user may then edit.
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