# CubeStack Operator

The CubeStack operator manages the `ai.cubestack.io` resources: `ModelVersion`,
`InferenceRuntimeProfile`, `InferenceService` and `DevEnvironment`. It ships as a
Helm chart (see [helm/cubestack-operator](helm/cubestack-operator/README.md));
the `make helm-e2e-*` targets below are the quickest way to install it locally
and verify it end-to-end on a dedicated kind cluster.

## Prerequisites

- [docker](https://docs.docker.com/engine/install/) (daemon running)
- [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)
- [helm](https://helm.sh/docs/intro/install/) v3
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [go](https://go.dev/dl/) (for `make` targets that download tools / build images)

## Install and verify on kind (make)

```bash
# From the repository root (or `make -C operator ...` inside operator/)

make helm-e2e-install    # create the kind cluster (if absent), build and load the
                         # manager + echo images, helm-install the operator, wait for rollout
make helm-e2e-crd-check  # assert CRDs / VAPs / RBAC are installed and schema validation rejects
                         # invalid resources
make helm-e2e-verify     # apply the dummy assets (test/e2e/assets) and assert the full
                         # gpu-less happy path: InferenceService reaches Ready=True with all
                         # conditions True, rendered overrides appear in the pod logs, the
                         # HostPath volume is mounted and the endpoint has ready backends
```

Everything runs on a dedicated kind cluster named `cubestack-helm-e2e`
(independent from the scaffold `test-e2e` cluster `cubestack-test-e2e`).
The targets are idempotent and safe to re-run; `helm-e2e-verify` re-applies the
dummy assets and re-asserts them.

The manager image defaults to `harbor.isuanova.com/suanova/cubestack-operator:latest`
and is deployed with `imagePullPolicy: IfNotPresent` (baked into the chart
template), so the image loaded into kind wins over the registry even for a
`:latest` tag. Override the image with `make helm-e2e-install IMG=<registry>/<repo>:<tag>`.

### What the install provisions

The kind cluster setup (`helm-e2e-setup`) also installs the platform
prerequisites the operator needs to run and reconcile:

- the Gateway API CRDs (the manager registers a Gateway/HTTPRoute watch at
  startup and will not boot without them), and
- the upstream [LeaderWorkerSet](https://github.com/kubernetes-sigs/lws)
  controller at the version pinned in `go.mod` (LWS workloads do not
  materialize pods without it).

In a non-kind cluster you must provide both before installing the chart.

## Uninstall and cleanup

```bash
make helm-e2e-uninstall  # helm uninstall cubestack -n cubestack-system
make helm-e2e-cleanup    # delete the kind cluster (cubestack-helm-e2e)
```

`helm uninstall` removes the operator (Deployment, RBAC, VAPs, metrics Service)
but intentionally keeps the CRDs — deleting a CRD would orphan its resources.
Use `kubectl delete crd <name>` explicitly if you want them gone.

## Installing via Helm (production-like)

See [helm/cubestack-operator/README.md](helm/cubestack-operator/README.md) for
chart values, CRD lifecycle semantics and the prerequisite install commands.
