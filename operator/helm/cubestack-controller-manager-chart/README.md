# cubestack-controller-manager-chart

The CubeStack operator chart: installs the `ai.cubestack.io` CRDs
(ModelVersion, InferenceRuntimeProfile, InferenceService, DevEnvironment),
their L1 validating admission policies (VAPs) and bindings, and the controller
manager. InferenceService workloads are LeaderWorkerSets, but the chart
installs only the `ai.cubestack.io` CRDs — the `leaderworkerset.x-k8s.io` /
`disaggregatedset.x-k8s.io` CRDs come with the upstream LeaderWorkerSet
controller prerequisite below.

## Prerequisites

- Kubernetes **>= 1.30** (ValidatingAdmissionPolicy support).
- **gateway-api CRDs** installed in the cluster. The manager watches
  Gateway/HTTPRoute/TCPRoute at startup and fails to boot without these CRDs.
  The chart does not install them. Example for a kind cluster:

  ```bash
  GW_VER="$(awk '$1=="sigs.k8s.io/gateway-api" {print $2}' operator/go.mod)"
  kubectl apply -f "$(go env GOMODCACHE)/sigs.k8s.io/gateway-api@${GW_VER}/config/crd/standard"
  ```

- The **upstream LeaderWorkerSet controller** running in the cluster, which
  provides the `leaderworkerset.x-k8s.io` / `disaggregatedset.x-k8s.io` CRDs
  as well as the controller: the manifest below is the pinned lws module's
  `config/default` and includes its CRDs. Without the controller,
  LeaderWorkerSet workloads never materialize pods, so InferenceServices can
  never reach `Ready=True`. Install it from the pinned lws version in
  `operator/go.mod`, e.g. via the operator's `make -C operator helm-e2e-setup`
  (provisions a kind cluster) or the upstream lws release manifests:

  ```bash
  LWS_VER="$(awk '$1=="sigs.k8s.io/lws" {print $2}' operator/go.mod)"
  kubectl apply --server-side -f \
    "$(go env GOMODCACHE)/sigs.k8s.io/lws@${LWS_VER}/config/default"
  ```

  No cert-manager is required: LWS v0.10.0 manages its own webhook
  certificates.

## Install

From a fresh checkout, run `make -C operator helm-crds-sync` first: the chart
directory's `crds/` is not committed — it is populated from
`operator/config/crd/bases` at package/install time (`helm-crds-sync` is a
prereq of `helm-package` and `helm-e2e-install`, so packaged charts and the
`helm-e2e-*` flow already contain the CRDs).

```bash
helm install cubestack ./helm/cubestack-controller-manager-chart -n cubestack-system --create-namespace
```

### Install from the OCI registry

The chart is published to the team's Harbor registry as an OCI artifact. The
prerequisites above still apply — gateway-api CRDs and the upstream
LeaderWorkerSet controller must already be installed (the chart installs the
`ai.cubestack.io` CRDs only):

```bash
helm install cubestack oci://harbor.isuanova.com/suanova/cubestack-controller-manager-chart \
  --version 0.1.0 -n cubestack-system --create-namespace
```

### Image overrides

The default image is `harbor.isuanova.com/suanova/cubestack-controller-manager:latest`
(the team's registry). Override repository and tag with `--set`:

```bash
helm install cubestack ./helm/cubestack-controller-manager-chart -n cubestack-system \
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

### Gateway configuration (route publishing)

`spec.route.publish: true` on an InferenceService publishes its HTTPRoute to
the platform Gateway. The manager learns the Gateway through three flags, fed
by the `gateway.*` values below — one flag per key, and **an empty value
omits the flag entirely** (keeping the manager's own default):

| Key | Manager flag | Default | Notes |
|---|---|---|---|
| `gateway.name` | `--gateway-name` | `cubestack-gateway` | Empty = flag omitted; publishing is disabled (`RouteReady=False`, `GatewayNotConfigured`). |
| `gateway.namespace` | `--gateway-namespace` | `cubestack-system` | Empty = flag omitted (the manager flag default is `cubestack-system` anyway). |
| `gateway.domain` | `--gateway-domain` | `""` | Empty = flag omitted. **Set this to enable publishing** — the public hostname of a published service is `<modelName>.<domain>`. |

The `name`/`namespace` defaults follow the platform convention (the same
`cubestack-gateway` in `cubestack-system` the DevEnvironment controller uses),
so a standard install only needs the domain:

```bash
helm install cubestack ./helm/cubestack-controller-manager-chart -n cubestack-system \
  --create-namespace --set gateway.domain=example.com
```

Pass `--set` again on `helm upgrade` (or use a `--values` file) — the flags
are rendered by the chart, so an upgrade never resets them. When upgrading a
release that was created by an older chart, drop `--reuse-values` (or pass
the `gateway.*` keys explicitly): reused values are the release's stored
values and do not pick up these new chart defaults.

The kustomize deployment (`make deploy`) carries the same `--gateway-name` /
`--gateway-namespace` args in `operator/config/manager/manager.yaml`;
`--gateway-domain` is left to your overlay there.

## Uninstall

```bash
helm uninstall cubestack -n cubestack-system
```

Helm uninstall removes the release's objects (Deployment, RBAC, VAPs, ...) but
**not the CRDs** — CRDs are cluster-scoped and intentionally left in place so
custom resources survive a reinstall. Delete the chart's `ai.cubestack.io`
CRDs explicitly if you want them gone (all custom resources must be removed
first):

```bash
kubectl delete crd modelversions.ai.cubestack.io inferenceruntimeprofiles.ai.cubestack.io \
  inferenceservices.ai.cubestack.io devenvironments.ai.cubestack.io
```

The `leaderworkerset.x-k8s.io` / `disaggregatedset.x-k8s.io` CRDs belong to the
LeaderWorkerSet controller prerequisite (see above) rather than the chart;
delete them only when removing that prerequisite too:

```bash
kubectl delete crd leaderworkersets.leaderworkerset.x-k8s.io \
  disaggregatedsets.disaggregatedset.x-k8s.io \
  disaggregatedsetrolescalers.disaggregatedset.x-k8s.io
```

## Publishing to Harbor (maintainers)

CI (`.github/workflows/ci-operator-chart.yml`) pushes the chart to
`oci://harbor.isuanova.com/suanova` automatically on `main` when chart-relevant
paths change. To publish manually, from `operator/`:

```bash
make helm-package   # regenerates chart resources from config/, then packages
helm registry login harbor.isuanova.com -u <CI_BOT_NAME> -p <CI_BOT_PASSWORD>
helm push helm/cubestack-controller-manager-chart/cubestack-controller-manager-chart-0.1.0.tgz oci://harbor.isuanova.com/suanova
```

The OCI version tag comes from the Chart.yaml `version` — CI derives the
pushed tgz name from it, so a bump needs no workflow edit. Bump chart versions
in one commit: update the Chart.yaml `version` **and** the version literals in
this README (the OCI install `--version` above and the manual push path in
this section). Re-pushing the same version overwrites the existing tag.

## Generated content — do not hand-edit

`templates/` and `vap.yaml` are generated from the kustomize sources in
`operator/config/` by `operator/hack/update-helm-resources.sh`:

- VAPs: `operator/config/vap/*.yaml` (concatenated with `---` separators)
- RBAC / Deployment / Service / Role: `kustomize build operator/config/default`
  with namespace and image rewritten to Helm values

The `crds/` directory is NOT stored in the repo — it is populated at package
or install time by copying `operator/config/crd/bases` into the chart
(`make -C operator helm-crds-sync`, a prereq of `helm-package` and
`helm-e2e-install`), so it always matches `config/` by construction. The chart
installs only the `ai.cubestack.io` CRDs; the `leaderworkerset.x-k8s.io` /
`disaggregatedset.x-k8s.io` CRDs come with the LeaderWorkerSet controller
prerequisite — see above.

To change chart content, edit the sources under `operator/config/` and run
`make -C operator helm-resources-update`, then commit the regenerated chart.
CI (`make -C operator helm-resources-check`) fails when the committed chart is
out of sync with the sources.
