# cubestack-operator

The CubeStack operator chart: installs the `ai.cubestack.io` CRDs
(ModelVersion, InferenceRuntimeProfile, InferenceService, DevEnvironment),
their L1 validating admission policies (VAPs) and bindings, and the controller
manager. It also ships the `leaderworkerset.x-k8s.io` / `disaggregatedset.x-k8s.io`
CRDs, because InferenceService workloads are LeaderWorkerSets.

## Prerequisites

- Kubernetes **>= 1.30** (ValidatingAdmissionPolicy support).
- **gateway-api CRDs** installed in the cluster. The manager watches
  Gateway/HTTPRoute/TCPRoute at startup and fails to boot without these CRDs.
  The chart does not install them. Example for a kind cluster:

  ```bash
  GW_VER="$(awk '$1=="sigs.k8s.io/gateway-api" {print $2}' operator/go.mod)"
  kubectl apply -f "$(go env GOMODCACHE)/sigs.k8s.io/gateway-api@${GW_VER}/config/crd/standard"
  ```

- The **upstream LeaderWorkerSet controller** running in the cluster. The chart
  installs the LWS CRDs but not the controller; without it LeaderWorkerSet
  workloads never materialize pods, so InferenceServices can never reach
  `Ready=True`. Install it from the pinned lws version in `operator/go.mod`,
  e.g. via the operator's `make -C operator helm-e2e-setup` (provisions a kind
  cluster) or the upstream lws release manifests:

  ```bash
  LWS_VER="$(awk '$1=="sigs.k8s.io/lws" {print $2}' operator/go.mod)"
  kubectl apply --server-side -f \
    "$(go env GOMODCACHE)/sigs.k8s.io/lws@${LWS_VER}/config/default"
  ```

  No cert-manager is required: LWS v0.10.0 manages its own webhook
  certificates.

## Install

```bash
helm install cubestack ./helm/cubestack-operator -n cubestack-system --create-namespace
```

### Image overrides

The default image is `harbor.isuanova.com/suanova/cubestack-operator:latest`
(the team's registry). Override repository and tag with `--set`:

```bash
helm install cubestack ./helm/cubestack-operator -n cubestack-system \
  --create-namespace \
  --set image.repository=myregistry.example.com/cubestack \
  --set image.tag=v1.2.3
```

The Deployment template bakes `imagePullPolicy: IfNotPresent` into the
manager container (fixed in the template — it is not a values knob). Local
kind testing therefore works with the `:latest` default: the built image is
kind-loaded into the cluster, and `IfNotPresent` makes the loaded image win
over the registry instead of the kubelet's `Always` default for `latest`
tags triggering a remote pull.

## Uninstall

```bash
helm uninstall cubestack -n cubestack-system
```

Helm uninstall removes the release's objects (Deployment, RBAC, VAPs, ...) but
**not the CRDs** — CRDs are cluster-scoped and intentionally left in place so
custom resources survive a reinstall. Delete them explicitly if you want them
gone (all custom resources must be removed first):

```bash
kubectl delete crd modelversions.ai.cubestack.io inferenceruntimeprofiles.ai.cubestack.io \
  inferenceservices.ai.cubestack.io devenvironments.ai.cubestack.io \
  leaderworkersets.leaderworkerset.x-k8s.io \
  disaggregatedsets.disaggregatedset.x-k8s.io \
  disaggregatedsetrolescalers.disaggregatedset.x-k8s.io
```

## Generated content — do not hand-edit

Everything under `templates/` and `crds/` is generated from the kustomize
sources in `operator/config/` and the pinned lws go module by
`operator/hack/update-helm-resources.sh`:

- CRDs: `operator/config/crd/bases` + `sigs.k8s.io/lws@<go.mod version>/config/crd/bases`
- VAPs: `operator/config/vap/*.yaml` (concatenated with `---` separators)
- RBAC / Deployment / Service / Role: `kustomize build operator/config/default`
  with namespace and image rewritten to Helm values

To change chart content, edit the sources under `operator/config/` and run
`make -C operator helm-resources-update`, then commit the regenerated chart.
CI (`make -C operator helm-resources-check`) fails when the committed chart is
out of sync with the sources.
