import { getCoreClient } from "@/lib/kubernetes";
import { withAuth } from "@/lib/auth/guard";
import { DEV_IMAGES } from "@/lib/devenvironments/images";
// The configured/default/first rule, shared with the inference wizard: filtering
// above has already confined "first" to a namespace that is not the platform's.
import { defaultNamespaceOf } from "@/lib/namespaces";

// @kubernetes/client-node needs Node APIs (TLS, fs), not the Edge runtime.
export const runtime = "nodejs";

// This handler talks to the live cluster, so it must not be prerendered.
export const dynamic = "force-dynamic";

// The catalog lives in lib/devenvironments/images.ts because the create route
// falls back to the same list; the wizard is sent only what it displays — which
// now includes each image's runtime identity, since the wizard shows it and
// pre-fills the editable account / uid / gid fields from it.
const IMAGES: DevEnvImageOption[] = DEV_IMAGES.map(({ tag, label, user, runAsGroup, interface: iface, vendor }) => ({
  tag,
  label,
  user,
  runAsGroup,
  interface: iface,
  vendor,
}));

/** One selectable image, with the identity the wizard pre-fills from it. */
export interface DevEnvImageOption {
  tag: string;
  label: string;
  /** spec.runtime.user the image's own sshd serves. */
  user: string;
  /** spec.runtime.securityContext.runAsGroup, when 1000 is wrong for this image. */
  runAsGroup?: number;
  /** The interface the image was built for; the wizard offers only the images
   * that serve the environment type the user picked. */
  interface: "jupyter" | "ssh";
  /** The accelerator stack it carries; the wizard keeps it across a type change. */
  vendor: "cpu" | "nvidia" | "metax";
}

/**
 * Namespaces the wizard must not offer as a home for a development environment.
 *
 * The console cannot know every cluster's intent, but it can leave out what
 * Kubernetes reserves and what the platform itself installs into. Measured on a
 * live CubeStack install, the unfiltered list began "ai-gateway-system" — the
 * platform's own control-plane namespace — and the wizard preselected it, so an
 * untouched wizard would put a user's StatefulSet, PVC and Routes beside the
 * gateway. A platform installed elsewhere can name its namespace here.
 */
const PLATFORM_NAMESPACES = new Set([
  "ai-gateway-system", // Agent Router / AI Gateway control plane
  "cubestack-system", // the operator, the portal and the task CRs
  "envoy-gateway-system", // the Gateway API data plane
  "lws-system", // LeaderWorkerSet, for multi-node inference
  "metallb-system", // LoadBalancer address assignment
  "metax-operator", // the Metax device stack
  "rook-ceph", // the cluster's own storage
]);

/** Whether a namespace may be offered as a home for a development environment. */
function offered(name: string): boolean {
  return !name.startsWith("kube-") && !PLATFORM_NAMESPACES.has(name);
}

/** Catalog the create wizard needs, read from the live cluster. */
export interface DevEnvOptionsResponse {
  namespaces: Array<{ name: string }>;
  /** The namespace the wizard opens on — never silently a platform namespace. */
  defaultNamespace: string | null;
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

    const names = (nsRes.items ?? [])
      .map((ns) => ns.metadata?.name)
      .filter((n): n is string => Boolean(n))
      .filter(offered)
      .sort();

    const response: DevEnvOptionsResponse = {
      namespaces: names.map((name) => ({ name })),
      defaultNamespace: defaultNamespaceOf(names),
      images: IMAGES,
    };

    return Response.json(response);
  } catch (err) {
    console.error("Failed to load dev-environment create options:", err);
    return Response.json({ error: "Failed to load create options" }, { status: 500 });
  }
});