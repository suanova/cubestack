# CubeStack Operator

The CubeStack operator manages the `ai.cubestack.io` resources: `ModelVersion`,
`InferenceRuntimeProfile`, `InferenceService` and `DevEnvironment`. It ships as a
Helm chart (see [helm/cubestack-controller-manager-chart](helm/cubestack-controller-manager-chart/README.md));
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

The manager image defaults to `harbor.isuanova.com/suanova/cubestack-controller-manager:latest`
and is deployed with `imagePullPolicy: IfNotPresent` (baked into the chart
template), so the image loaded into kind wins over the registry even for a
`:latest` tag. Override the image with `make helm-e2e-install IMG=<registry>/<repo>:<tag>`.

### What the install provisions

The kind cluster setup (`helm-e2e-setup`, a dependency of `helm-e2e-install`)
installs the platform prerequisites the operator needs to run and reconcile
before the chart is helm-installed:

- the Gateway API CRDs (the DevEnvironment controller watches Gateway,
  HTTPRoute, TCPRoute, UDPRoute and ListenerSet; the manager registers those
  watches at startup for the kinds the cluster serves),
- the platform Gateway and its `ClientTrafficPolicy`
  (`test/e2e/assets/gateway.yaml`, the shape the chart README documents as a
  prerequisite). The chart creates neither — the platform owns them — but
  everything the operator publishes or exposes attaches to that Gateway, and the
  DevEnvironment verification reaches each environment through its address, so
  the cluster needs one before the verify steps run, and
- the upstream [LeaderWorkerSet](https://github.com/kubernetes-sigs/lws)
  controller at the version pinned in `go.mod` (LWS workloads do not
  materialize pods without it). The controller install applies the pinned lws
  module's `config/default`, which provides its own
  `leaderworkerset.x-k8s.io` / `disaggregatedset.x-k8s.io` CRDs.

The chart installs the `ai.cubestack.io` CRDs (ModelVersion,
InferenceRuntimeProfile, InferenceService, DevEnvironment — synced from
`config/crd/bases` at build time) together with the VAPs, RBAC and Deployment
for the controller manager; it does not ship the lws CRDs, and creates no
Gateway API object.

In a non-kind cluster you must provide all of the above before installing the
chart: the Gateway API CRDs, the Envoy Gateway v1.9.1 CRDs and controller
(Gateway and `ClientTrafficPolicy` are that controller's resources), a
GatewayClass carrying an `EnvoyProxy`, and a Gateway matching the chart's
`gateway.name` / `gateway.namespace` — see the chart README's Prerequisites for
the exact shape.

## Requirements on the namespaces that host DevEnvironments

The operator neither creates nor labels namespaces: an environment lands in whatever
namespace its CR was created in. Pod Security Admission has no per-container exemption, so
the namespace's enforce level decides whether the workload can exist there at all.

A namespace hosting DevEnvironments has to be at **`baseline`**, and a namespace hosting an
environment with `spec.network.rdmaEnabled` has to be at **`privileged`**: `baseline`
disallows a declared `IPC_LOCK` whatever uid the container runs as, and disallows
`hostNetwork`, and an RDMA environment declares both. `privileged` there names the Pod
Security Standard level, not `securityContext.privileged` on the container — the operator
never sets that, and an RDMA environment's container is an ordinary non-root one.

`restricted` is not enough, for any spec. That level is a checklist of what each container
declares — a non-root user, a seccomp profile, `allowPrivilegeEscalation: false`, and a
`capabilities.drop` of `ALL` — and an absent field counts against it, because the level
judges what is declared rather than what the container could do. The platform declares the
first two of the four and neither of the others, so a DevEnvironment pod is refused admission
to a namespace enforcing `restricted` whatever the spec asks for, including one with no
`spec.storage` at all. Nothing here works around that; `baseline` is the requirement.

The DevEnvironment e2e labels its namespace `baseline` (`hack/verify-devenv.sh`), which suits
every environment but the RDMA one.

A refusal is quiet: the StatefulSet is created but its pod is refused at admission, so the
environment never reaches `Running` and the reason is only in the StatefulSet's events, not in
the DevEnvironment's status. A namespace with no enforce label inherits the API server's
cluster-wide default, which the operator cannot read — label the namespace explicitly rather
than rely on it.

## Uninstall and cleanup

```bash
make helm-e2e-uninstall  # helm uninstall cubestack -n cubestack-system
make helm-e2e-cleanup    # delete the kind cluster (cubestack-helm-e2e)
```

`helm uninstall` removes the operator (Deployment, RBAC, VAPs, metrics Service)
but intentionally keeps the CRDs — deleting a CRD would orphan its resources.
Use `kubectl delete crd <name>` explicitly if you want them gone.

## Installing via Helm (production-like)

See [helm/cubestack-controller-manager-chart/README.md](helm/cubestack-controller-manager-chart/README.md) for
chart values, CRD lifecycle semantics and the prerequisite install commands.
