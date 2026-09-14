// /api/cubepilot/playground/services — the models served by the AI Gateway,
// from its OpenAI-compatible GET /v1/models endpoint. The gateway base URL
// comes from CUBESTACK_GATEWAT_URL or service discovery in
// envoy-gateway-system (see lib/cubepilot/gateway.ts). `endpoint` is the
// user-visible base URL (null when the gateway is reached through the
// API-server proxy, which is not usable outside the cluster).

import { resolveGatewayBase, gatewayFetch } from "@/lib/cubepilot/gateway";
import type { GatewayModel } from "@/lib/cubepilot/types";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  const base = await resolveGatewayBase();
  if (!base) {
    return Response.json(
      { models: [], endpoint: null, error: "AI gateway not found in this cluster (set CUBESTACK_GATEWAT_URL)" },
      { status: 503 },
    );
  }
  let body: { data?: Array<{ id?: string; owned_by?: string }> };
  try {
    const res = await gatewayFetch("/v1/models");
    if (!res.ok) throw new Error(`gateway /v1/models returned HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (e) {
    return Response.json({ models: [], endpoint: null, error: String(e) }, { status: 502 });
  }
  const models: GatewayModel[] = (body.data ?? [])
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({ id: m.id as string, ownedBy: m.owned_by ?? "" }));
  return Response.json({ models, endpoint: base.via === "direct" ? base.url : null });
});
