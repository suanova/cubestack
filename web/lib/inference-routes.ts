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
