// /api/cubepilot/playground/services — the models served by the AI Gateway,
// from its OpenAI-compatible GET /v1/models endpoint. The gateway base URL
// comes from CUBESTACK_GATEWAT_URL or service discovery in
// envoy-gateway-system (see lib/cubepilot/gateway.ts). `endpoint` is the
// user-visible base URL (null when the gateway is reached through the
// API-server proxy, which is not usable outside the cluster).

import { gatewayCatalog, resolveGatewayBase } from "@/lib/cubepilot/gateway";
import { logger } from "@/lib/log";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The body of an unreadable catalog. Deliberately a fixed phrase: the reason a
 *  catalog is missing (no gateway installed, name not resolvable, upstream down)
 *  is an internal detail the reader can neither act on nor be shown, and the
 *  page treats an empty catalog as "no platform models here" either way. The
 *  cause goes to the log. */
const NO_CATALOG = "model catalog unavailable";

export const GET = withAuth(async () => {
  const base = await resolveGatewayBase();
  if (!base) {
    logger("gateway").warn("model catalog unavailable: no gateway base resolved", {
      hint: "set CUBESTACK_GATEWAT_URL, or install the gateway in the configured namespace",
    });
    return Response.json({ models: [], endpoint: null, error: NO_CATALOG }, { status: 503 });
  }
  // Memoized and bounded by the gateway module: one wait per window instead of
  // one per read, and the failure is logged there with the URL it was aimed at.
  const models = await gatewayCatalog();
  if (!models) {
    return Response.json({ models: [], endpoint: null, error: NO_CATALOG }, { status: 502 });
  }
  return Response.json({ models, endpoint: base.via === "direct" ? base.url : null });
});
