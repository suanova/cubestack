import {
  ApiextensionsV1Api,
  CoreV1Api,
  KubeConfig,
} from "@kubernetes/client-node";

/**
 * Build a KubeConfig for wherever the portal is running.
 *
 * Prefers in-cluster credentials (the service account mounted into the pod),
 * and falls back to the default kubeconfig for local development.
 */
export function getKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT) {
    kc.loadFromCluster(); // running inside a k8s pod
  } else {
    kc.loadFromDefault(); // local dev (e.g. ~/.kube/config)
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
