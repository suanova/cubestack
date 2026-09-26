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
  Gateway/HTTPRoute/TCPRoute/UDPRoute at startup and fails to boot without these
  CRDs.
  The chart does not install them. Example for a kind cluster:

  ```bash
  GW_VER="$(awk '$1=="sigs.k8s.io/gateway-api" {print $2}' operator/go.mod)"
  kubectl apply -f "$(go env GOMODCACHE)/sigs.k8s.io/gateway-api@${GW_VER}/config/crd/standard"
  ```

- **Envoy Gateway >= v1.9.1**, which provides the `EnvoyProxy` CRD *and* the
  controller that programs the Gateway, so the CRDs must be in place before the
  chart can be installed. v1.9.1 is the version ListenerSet reconciliation is
  verified on — an older one accepts the Gateway but never programs the
  ListenerSets, so no L4 listener ever appears. The Gateway you create below
  names the `eg` GatewayClass that this install creates:

  ```bash
  helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.1 \
    -n envoy-gateway-system --create-namespace
  ```

- **A GatewayClass that carries an `EnvoyProxy`.** The dataplane behind the
  Gateway — its Service type and the proxy image — is whatever the `EnvoyProxy`
  referenced by that class's `spec.parametersRef` says. A class with no
  `parametersRef` gets Envoy Gateway's built-in defaults: a `LoadBalancer`
  Service, which never gets an address on a cluster with no load-balancer
  controller (nothing is published at all), and the proxy image pulled from
  `docker.io` (unreachable on a cluster with no egress to Docker Hub, so the
  proxy pods go `ImagePullBackOff`). Point the `eg` class at one before you
  create the Gateway, and set **both** settings in it:

  ```yaml
  apiVersion: gateway.envoyproxy.io/v1alpha1
  kind: EnvoyProxy
  metadata:
    name: cubestack-dataplane
    namespace: envoy-gateway-system
  spec:
    provider:
      type: Kubernetes
      kubernetes:
        envoyDeployment:
          container:
            # Must be an image your nodes can pull, at the tag matching the
            # Envoy Gateway version above.
            image: registry.cubestack.io:5000/envoyproxy/envoy:distroless-v1.39.1
        envoyService:
          # NodePort is what makes a cluster with no load-balancer controller
          # work (see the L4 port pool section).
          type: NodePort
  ---
  apiVersion: gateway.networking.k8s.io/v1
  kind: GatewayClass
  metadata:
    name: eg
  spec:
    controllerName: gateway.envoyproxy.io/gatewayclass-controller
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: cubestack-dataplane
      namespace: envoy-gateway-system
  ```

  The image has to be restated here rather than left to Envoy Gateway's global
  `envoy-gateway-config` provider block: an `EnvoyProxy` is a provider config in
  its own right, so an image mirrored globally is not guaranteed to reach a
  class that has one. Spelling it out works either way.

- **A Gateway, and the `ClientTrafficPolicy` that goes with it.** The chart
  creates neither. The manager boots without them (it only needs the gateway-api
  CRDs) and reports `RouteReady=False, reason=GatewayNotFound` for every
  `spec.route.publish: true` service until the Gateway exists, but nothing the
  operator publishes or exposes carries traffic without one. Create both before
  or after installing the chart — the operator picks them up either way:

  ```yaml
  apiVersion: gateway.networking.k8s.io/v1
  kind: Gateway
  metadata:
    name: cubestack-gateway        # must match gateway.name
    namespace: envoy-gateway-system  # must match gateway.namespace
  spec:
    gatewayClassName: eg           # the class established above
    # ListenerSets contributed by tenant namespaces (one per DevEnvironment) are
    # rejected unless the Gateway opts in: the API default is "None", which
    # refuses every one of them.
    allowedListeners:
      namespaces:
        from: All
    listeners:
      - name: http
        port: 80
        protocol: HTTP
        # Routes from every namespace may attach; allowedRoutes.kinds is left
        # unset so the API derives them from the protocol (HTTPRoute, GRPCRoute).
        allowedRoutes:
          namespaces:
            from: All
  ---
  apiVersion: gateway.envoyproxy.io/v1alpha1
  kind: ClientTrafficPolicy
  metadata:
    name: cubestack-gateway-ai
    namespace: envoy-gateway-system
  spec:
    targetRefs:
      - group: gateway.networking.k8s.io
        kind: Gateway
        name: cubestack-gateway     # must match gateway.name
    connection:
      bufferLimit: 50Mi
    http2:
      initialStreamWindowSize: 16Mi
      initialConnectionWindowSize: 24Mi
  ```

  The `ClientTrafficPolicy` is a prerequisite of the Agent Router path, not a
  tuning extra: a published request's body is buffered whole so the model name
  can be read out of it, which the API's 32KiB `bufferLimit` default is too
  small for, and the HTTP/2 flow-control windows are raised above the CRD
  defaults. Without it large requests fail at the Gateway.

  `allowedListeners` is what admits the per-environment ListenerSets (see the
  L4 port pool section); `from: All` also means who may contribute a listener
  is decided by RBAC alone — anyone who can create a `ListenerSet` in their own
  namespace can publish a listener on this Gateway. If the cluster's tenants are
  not mutually trusted, select the namespaces explicitly instead.

  The names and namespace above are the defaults the chart expects, so a Gateway
  created this way needs no `--set` at all. Create it elsewhere and point the
  chart at it with `gateway.name` / `gateway.namespace`. `operator/test/e2e/assets/gateway.yaml`
  is the same pair, applied by the operator's own end-to-end setup.

- The **Agent Router** (`ai-gateway-controller` v1.1.0, namespace
  `ai-gateway-system`) running in the cluster, which provides the
  `AIGatewayRoute` / `AIServiceBackend` CRDs a published model catalog entry is
  written into. The manager degrades without it instead of failing: a service
  with `spec.route.publish: true` reports `RouteReady=False,
  reason=AgentRouterUnavailable` and no catalog entry is created.

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

### Upgrading from a chart that created the Gateway

**Upgrading a release installed from a chart that still shipped the Gateway
deletes it**, along with its `ClientTrafficPolicy` and, from an even earlier
release, the `EnvoyProxy` it tracked. Helm removes the resources a release owns
that have dropped out of its manifest, and this chart now carries neither
object. The flag the manager receives changes too: `--gateway-namespace` used to
follow the release namespace, and now follows `gateway.namespace` —
`envoy-gateway-system` by default.

Every published InferenceService route and every DevEnvironment ListenerSet goes
`GatewayNotFound` the moment the old release's objects are pruned, and nothing
recovers until a Gateway matching `gateway.name` / `gateway.namespace` exists.

So create the platform Gateway and its `ClientTrafficPolicy` (Prerequisites)
**before** upgrading. The `allowedListeners` and `allowedRoutes` opt-ins in that
YAML are what the deleted Gateway carried — leave them out and the listeners
come up but every ListenerSet is rejected. If you intend to keep the namespace
the old Gateway was in rather than move to `envoy-gateway-system`, create it
there and pass `--set gateway.namespace=<ns>`; the *name* needs no `--set`, since
the old chart's default was already `cubestack-gateway`.

Diff before upgrading, to see the Gateway and policy drop out of the manifest
along with any other change:

```bash
helm template cubestack ./helm/cubestack-controller-manager-chart -n cubestack-system \
  | kubectl diff -f -
```

Export the objects first if you want them back afterwards: the deleted Gateway
is not recoverable from the release, and `helm rollback` restores a manifest that
recreates it only because the old chart still contains it.

**An earlier release of this chart tracked an `EnvoyProxy` of its own
(`cubestack-gateway-proxy`), and upgrades delete it**, since the chart no longer
carries one. The dataplane does not fall back to that object's settings but
to Envoy Gateway's defaults — `LoadBalancer`, and the proxy image from
`docker.io`. Before upgrading a release that owned one, create the class-level
`EnvoyProxy` under Prerequisites (the `eg` class's `parametersRef`) and confirm
the Gateway is served by it, or the cluster's environments lose their published
addresses on a cluster with no load-balancer controller and the proxy pods go
`ImagePullBackOff` on one that cannot reach Docker Hub. Check with:

```bash
kubectl get gatewayclass eg -o jsonpath='{.spec.parametersRef}{"\n"}'
kubectl -n envoy-gateway-system get envoyproxy
```

### Gateway configuration (publishing)

`spec.route.publish: true` on an InferenceService publishes it into the Agent
Router model catalog: the catalog objects of the service attach to the platform
Gateway, which serves the shared catalog hostname. **The chart does not create
that Gateway** — the platform does (Prerequisites), and this section is about
pointing the operator at it. One HTTP listener on :80 that routes from any
namespace may attach to, plus the `allowedListeners` opt-in the per-environment
ListenerSets need (see the L4 section), is what the Gateway has to carry for the
operator's objects to work.

The proxy fleet behind it — its Service type, its image, its scaling — belongs
to the `EnvoyProxy` the Gateway's GatewayClass references (Prerequisites), which
the platform owns and every Gateway of that class shares. That is deliberate:
two Gateways of one class must not disagree about how their shared dataplane is
exposed.

The `ClientTrafficPolicy` that carries the connection buffer and HTTP/2
flow-control windows the Agent Router's request translation needs — it buffers
a whole request body to read the model name out of it, which the API's 32KiB
default is too small for — is the platform's as well, and travels with the
Gateway (the YAML under Prerequisites includes it). Only the cluster's Envoy
Gateway controller reads it, so on a cluster without one it is inert.

`gateway.name` and `gateway.namespace` are the pair several readers have to
agree on: they are the `--gateway-name` / `--gateway-namespace` the manager
receives, and they are how the DevEnvironment controller finds the Gateway its
ListenerSets attach to. Both must match the Gateway the platform created — a
mismatch is not an error the chart can report, only `RouteReady=False,
reason=GatewayNotFound` on every published service, and ListenerSets that never
attach.

Every value in the block below is a manager flag. Nothing here is written into a
Gateway API object, because the chart writes none:

- **The one flag that always renders** — `namespace`. A Gateway is identified by
  name *and* namespace, but the two do not behave alike when empty: an omitted
  `--gateway-namespace` falls back inside the manager to `cubestack-system`, a
  namespace neither install path configured, so the chart always renders it and
  defaults it to `envoy-gateway-system`.
- **Flags an empty value omits** — `name`, `catalogHostname`,
  `dataplaneNamespace`. Omitting `catalogHostname` just leaves publishing off;
  omitting `name` is not a switch either (see the table) — leave `name` set.

| Key | Manager flag | Default | Notes |
|---|---|---|---|
| `gateway.name` | `--gateway-name` | `cubestack-gateway` | Names the platform's Gateway — the object the operator publishes through and attaches ListenerSets to. Leave it set. Empty = flag omitted, and the two controllers then disagree: publishing is off (`RouteReady=False`, `GatewayNotConfigured`), while the DevEnvironment controller falls back to the manager's own built-in default — `cubestack-gateway` in `cubestack-system`, whatever `gateway.namespace` says. |
| `gateway.namespace` | `--gateway-namespace` | `envoy-gateway-system` | Namespace of that Gateway object — **not** where its dataplane pods run (`dataplaneNamespace`). Always rendered. Must match where the platform created the Gateway; `envoy-gateway-system` is where Envoy Gateway and the `eg` class live, so it is the conventional home unless the Gateway was put elsewhere. |
| `gateway.catalogHostname` | `--gateway-catalog-hostname` | `""` | Empty = flag omitted. **Set this to enable publishing**: the shared hostname the model catalog answers on. Every published service is one model of that single catalog entry, addressed by the model name in the request body. |
| `gateway.dataplaneNamespace` | `--gateway-dataplane-namespace` | `envoy-gateway-system` | Names the namespace the Gateway's dataplane pods run in. **Not** a publishing switch. Two things read it: environment pods admit ingress from that Gateway, and the controller looks up the dataplane Service there to learn which port each listener is reachable on. Empty = flag omitted: environments stay default-deny inbound, and endpoint addresses fall back to assuming the listener port is the reachable one — true of a LoadBalancer or ClusterIP dataplane, not of a NodePort one. |

`dataplaneNamespace` is the key here the **DevEnvironment** controller is
affected by most: the namespace is where its NetworkPolicy allowance points and
where it finds the dataplane Service. That dataplane namespace is not the
Gateway's own namespace — Envoy Gateway runs the proxy pods separately from the
one holding the `Gateway` object, though both are `envoy-gateway-system` in the
platform convention. Whether the port
published for a listener is the listener's own port or the nodePort it was
renumbered onto is decided by that class's `EnvoyProxy`, not by anything here.
`name` and `namespace` reach that controller too, as the Gateway its ListenerSets
attach to; `catalogHostname` configures the
InferenceService publishing path only.

The defaults are the platform convention — `cubestack-gateway` in
`envoy-gateway-system` — so an install against a platform that followed the
Prerequisites only needs the catalog hostname:

```bash
helm install cubestack ./helm/cubestack-controller-manager-chart -n cubestack-system \
  --create-namespace --set gateway.catalogHostname=ai.example.com
```

Pass `--set` again on `helm upgrade` (or use a `--values` file) — the flags
are rendered by the chart, so an upgrade never resets them. When upgrading a
release that was created by an older chart, drop `--reuse-values` (or pass
the `gateway.*` keys explicitly): reused values are the release's stored
values and do not pick up these new chart defaults.

Renaming the Gateway here — `--set gateway.name=...`, or `gateway.namespace` —
does not move or create anything: the chart owns neither object, so the change
only points the operator at a different Gateway. If nothing is there under the
new name, every environment loses its published address until one is. Change the
value and the object together, or create the Gateway under the new name before
upgrading.

The kustomize deployment (`make deploy`) sets the same `--gateway-name` /
`--gateway-namespace` args in `operator/config/manager/manager.yaml`, as
literals rather than values: `cubestack-gateway` in `envoy-gateway-system`;
`--gateway-catalog-hostname` and `--gateway-dataplane-namespace` are left to
your overlay there, so a kustomize install keeps environment pods default-deny
inbound and publishing off until a hostname is added. Like the chart, it creates
no Gateway and no `ClientTrafficPolicy`: both are the platform's, and the
reference shape is `operator/test/e2e/assets/gateway.yaml`.

### L4 port pool (DevEnvironment exposure)

Each DevEnvironment that exposes `ssh` or a `spec.ports[]` entry of type `tcp`
or `udp` takes one port from a cluster-wide pool. The manager learns the range
through two flags, fed by the `l4PortRange.*` values — these always render:

| Key | Manager flag | Default |
|---|---|---|
| `l4PortRange.start` | `--l4-port-range-start` | `20000` |
| `l4PortRange.end` | `--l4-port-range-end` | `20999` |

A port is allocated to the lowest free number in the range and stays with the
environment across restarts. `tcp` and `udp` draw on the same numbering — one
number is held by one protocol, so a udp port never shares a number with a tcp
one. Each allocated port becomes a listener the
environment's own `ListenerSet` declares on the platform Gateway. **Nothing has
to pre-publish the range**: Envoy Gateway adds the port of every accepted
listener to the proxy Service it manages for the Gateway, and where that
Service is a `NodePort` — a property of the class's `EnvoyProxy`, see
Prerequisites — it also assigns the nodePort. The controller reads the
dataplane Service back (see `gateway.dataplaneNamespace`) and publishes the port
it is actually reachable on in `status.endpoints[].address`, keeping the pool
port in `listenerPort`. Widen the range as the number of environments grows —
the pool, not the Service, is what runs out.

Two things have to be in place for a listener to take effect, once per cluster:

- The Gateway must admit the ListenerSets. **The one under Prerequisites does**:
  `spec.allowedListeners` is set to `from: All`, because the API default
  (`from: None`) denies every ListenerSet, which comes back `Accepted=False` /
  `NotAllowed` — surfaced on the environment as `RouteReady=False` /
  `ListenerNotAccepted`, which names the reason rather than hanging. Who may
  publish is settled by RBAC, not by that selector — anyone able to create a
  ListenerSet in their own namespace can contribute a listener — so a Gateway
  with a namespace selector instead is an equally valid setup.
- The `ListenerSet` CRD (`gateway.networking.k8s.io/v1`) must be installed, and
  the Envoy Gateway version must reconcile ListenerSets (v1.9.1 or newer — see
  the prerequisites). The controller probes for each Gateway API kind and only
  watches the ones the cluster serves, so a cluster without it still runs and
  still publishes HTTP; its L4 environments report `RouteReady=False` /
  `GatewayAPINotInstalled`. An Envoy Gateway that is too old leaves the object
  accepted by the API server but unprogrammed, so no listener appears and the
  environment never reaches `RouteReady=True`.

```bash
helm install cubestack ./helm/cubestack-controller-manager-chart -n cubestack-system \
  --create-namespace --set l4PortRange.start=20000 --set l4PortRange.end=29999
```

The kustomize deployment (`make deploy`) carries the same two args in
`operator/config/manager/manager.yaml`.

### RDMA (DevEnvironment accelerator fabric)

A DevEnvironment asks for RDMA with `spec.network`. The manager learns which
extended resources to request from two flags, fed by the `rdma.*` values —
these always render:

| Key | Manager flag | Default |
|---|---|---|
| `rdma.ibResource` | `--rdma-ib-resource` | `rdma/ib_shared_devices` |
| `rdma.roceResource` | `--rdma-roce-resource` | `rdma/roce_shared_devices` |

The `rdma/` prefix is the device plugin's own default — its `resourcePrefix`,
which is literally `rdma` when unset — so a ConfigMap that leaves it alone needs
no change. The rest of each name is this platform's: no convention exists for
naming an RDMA resource after its fabric, and the plugin's own several-pools
example distinguishes them by instance instead (`hca_shared_devices_a` and
`_b`). The pair here is deliberately symmetric, because the fabric is what the
user selects (via `spec.network.rdmaType`), and two fabrics are two pools.

The names still have to match what the cluster advertises: the plugin learns
them from its own ConfigMap, which is a prerequisite and not part of this chart.
A shared-device plugin instance carries one `resourceName` and one `ifNames`
selector, so a cluster serving both fabrics runs two instances, and the plugin
has to be configured with an `rdmaHcaMax` large enough to hand the same HCA to
every RDMA environment at once: each environment requests one device.

`spec.network.rdmaType` names the fabric. What the platform does to attach an
environment to it differs by fabric, and is worth planning for before offering
RDMA to tenants:

- An `infiniband` environment is confined by the `NetworkPolicy` the manager
  gives every environment.
- A `roce` environment is not. The manager writes the policy for it too, but it
  cannot apply to the way a RoCE environment is attached, so traffic reaches and
  leaves it as the node's own: a user who can create a RoCE environment can
  reach whatever the node can. Its ports are counted against the node rather
  than the environment, so two RoCE environments claiming the same one are not
  placed together.

Either kind runs with an `IPC_LOCK` capability the manager adds for it, which
is what pins the memory RDMA registration needs. That is outside both the
Baseline and the Restricted Pod Security Standard, so the namespace must
enforce `privileged` for these pods to be admitted.

That split belongs to this build rather than to the API: a later release could
attach RoCE environments another way — Multus with SR-IOV virtual functions,
say — without `spec.network` or this chart's values changing. Read `rdmaType`
as the fabric a user asks for, and this section as what the current
implementation does about it.

```bash
helm install cubestack ./helm/cubestack-controller-manager-chart -n cubestack-system \
  --create-namespace --set rdma.ibResource=example.com/ib
```

The kustomize deployment (`make deploy`) carries the same two args in
`operator/config/manager/manager.yaml`.

## Uninstall

```bash
helm uninstall cubestack -n cubestack-system
```

Helm uninstall removes the release's objects (Deployment, RBAC, VAPs, ...) but
**not the CRDs** — CRDs are cluster-scoped
and intentionally left in place so custom resources survive a reinstall. Delete
the chart's `ai.cubestack.io` CRDs explicitly if you want them gone (all custom
resources must be removed first):

```bash
kubectl delete crd modelversions.ai.cubestack.io inferenceruntimeprofiles.ai.cubestack.io \
  inferenceservices.ai.cubestack.io devenvironments.ai.cubestack.io
```

Uninstalling does **not** take the platform Gateway down: the chart never owned
it, so its lifecycle is unaffected. What stops is the operator — published
catalog entries and per-environment ListenerSets are no longer reconciled, and
the gateway objects the manager created for them stay until the custom resources
that own them are deleted.

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

No Gateway API objects are generated: the platform supplies those
(Prerequisites), and the chart only renders the manager flags that point at them.

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
