// Shared model-catalog routes an InferenceService can publish to. The values
// are the CRD enum (spec.route.aigatewayRouter, ai.cubestack.io/v1alpha1) and
// name the platform's pre-installed AIGatewayRoutes.
export const AIGATEWAY_ROUTER_PUBLIC = "cubestack-ai-gateway" as const;
export const AIGATEWAY_ROUTER_PRIVATE = "cubestack-ai-gateway-private" as const;

export const AIGATEWAY_ROUTERS = [AIGATEWAY_ROUTER_PUBLIC, AIGATEWAY_ROUTER_PRIVATE] as const;

export type AIGatewayRouter = (typeof AIGATEWAY_ROUTERS)[number];

export function isAIGatewayRouter(value: unknown): value is AIGatewayRouter {
  return value === AIGATEWAY_ROUTER_PUBLIC || value === AIGATEWAY_ROUTER_PRIVATE;
}

// Client paths a published service exposes on the catalog. The values are the
// CRD enum (spec.route.paths): /v1/messages is served by the Agent Router, the
// other three by the platform's plain HTTPRoute.
export const CATALOG_PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/images"] as const;

export type CatalogPath = (typeof CATALOG_PATHS)[number];

export function isCatalogPath(value: unknown): value is CatalogPath {
  return typeof value === "string" && (CATALOG_PATHS as readonly string[]).includes(value);
}
