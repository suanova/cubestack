import {
  ApiextensionsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";

import { currentLevel, logger } from "@/lib/log";

/**
 * Build a KubeConfig for wherever the portal is running.
 *
 * Prefers in-cluster credentials (the service account mounted into the pod),
 * and falls back to the default kubeconfig for local development.
 */
let loggedConfig = false;

export function getKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT);
  if (inCluster) {
    kc.loadFromCluster(); // running inside a k8s pod
  } else {
    kc.loadFromDefault(); // local dev (e.g. ~/.kube/config)
  }
  if (!loggedConfig) {
    loggedConfig = true;
    // The single most useful startup line: where the portal thinks the cluster
    // and the operator CRs are. CUBESTACK_TASKS_NAMESPACE drives every task and
    // agent CR; an empty page is usually this namespace not existing.
    const cluster = kc.getCurrentCluster();
    logger("k8s").debug("client configured", {
      mode: inCluster ? "in-cluster" : "kubeconfig",
      server: cluster?.server,
      operatorNamespace: process.env.CUBESTACK_TASKS_NAMESPACE ?? "cubestack-system(default)",
      gatewayNamespace: process.env.CUBESTACK_GATEWAY_NAMESPACE ?? "envoy-gateway-system(default)",
      htpasswdNamespace: process.env.HTPASSWD_SECRET_NAMESPACE ?? "cubestack-system(default)",
      logLevel: currentLevel(),
    });
  }
  return kc;
}

/**
 * Client for the apiextensions.k8s.io/v1 API group.
 *
 * Other API clients follow the same pattern:
 *   getKubeConfig().makeApiClient(AppsV1Api)
 */
export function getApiextensionsClient(): ApiextensionsV1Api {
  return getKubeConfig().makeApiClient(ApiextensionsV1Api);
}

/**
 * Client for the core v1 API group.
 */
export function getCoreClient(): CoreV1Api {
  return getKubeConfig().makeApiClient(CoreV1Api);
}

/**
 * Client for reading cluster-scoped custom resources (the operator's
 * ai.cubestack.io CRDs). Methods are object-param style and resolve to the
 * deserialized list body, e.g. listClusterCustomObject({ group, version,
 * plural }) -> { items: [...] }.
 */
export function getCustomObjectsClient(): CustomObjectsApi {
  return getKubeConfig().makeApiClient(CustomObjectsApi);
}
