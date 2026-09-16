# CubeStack Portal Helm Chart

This Helm chart deploys the CubeStack Portal (UI) application to a Kubernetes cluster.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.2.0+

## Installation

Paths below are relative to the repository root.

### Using default values

```bash
helm install cubestack-portal ./web/helm/cubestack-portal-chart \
  --namespace cubestack-system --create-namespace
```

### Using custom values

```bash
helm install cubestack-portal -f values.custom.yaml ./web/helm/cubestack-portal-chart \
  --namespace cubestack-system --create-namespace
```

### Using OCI registry

```bash
helm install cubestack-portal oci://<registry>/cubestack-portal-chart \
  --namespace cubestack-system --create-namespace --version <version>
```

## Configuration

The following table lists the configurable parameters of the Portal chart and their default values.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `image.registry` | UI image registry | `harbor.isuanova.com` |
| `image.repository` | UI image repository | `suanova/cubestack-ui` |
| `image.tag` | UI image tag | `latest` |
| `image.pullPolicy` | Image pull policy | `Always` |
| `replicaCount` | Number of replicas | `1` |
| `ingress.enabled` | Enable ingress | `false` |
| `ingress.className` | Ingress class name | `""` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.hosts` | Ingress hosts | `[{ host: ui.cubestack.local, path: / }]` |
| `ingress.tls` | Ingress TLS | `[]` |
| `resources.limits.cpu` | CPU limit | `500m` |
| `resources.limits.memory` | Memory limit | `512Mi` |
| `resources.requests.cpu` | CPU request | `100m` |
| `resources.requests.memory` | Memory request | `256Mi` |
| `namespace` | Target namespace (Role/Secrets/htpasswd live here) | `cubestack-system` |
| `operatorNamespace` | Namespace holding the operator CRs (AgentTemplate / AgentInstance / Skill / Task*); empty = `namespace` | `""` |
| `agentApiUrl` | CubePilot agent API base; empty = `http://cubepilot-api.<operatorNamespace>.svc:8080` | `""` |
| `gateway.url` | AI Gateway base; empty = discover the `ai-gateway` Service in `gateway.namespace`. Must be `https://` when a token is set | `""` |
| `gateway.namespace` | Namespace the gateway Service lives in | `""` (= `envoy-gateway-system`) |
| `gateway.token.existingSecret` / `.existingSecretKey` | Existing Secret holding the gateway bearer token (`CUBESTACK_GATEWAY_TOKEN`) | `""` / `token` |
| `logLevel` | Portal log verbosity: `error` \| `warn` \| `info` \| `debug` (`debug` logs every cluster/gateway call) | `info` |
| `secrets.htpasswd.content` | Pre-hashed htpasswd content (raw `user:bcrypt-hash` line, not base64) | `""` |
| `secrets.htpasswd.secretName` | Secret holding the htpasswd file (deployment `HTPASSWD_SECRET_NAME`; the Role grants `get` on exactly this name) | `cubestack-htpasswd` |
| `secrets.htpasswd.key` | Data key inside that Secret (deployment `HTPASSWD_SECRET_KEY`) | `htpasswd` |

### Environment Variables

The chart supports passing environment variables to the UI container via the `env` parameter in `values.yaml`:

```yaml
env:
  VARIABLE_NAME: "value"
  ANOTHER_VAR: "another_value"
```

## Authentication

The portal requires authentication configuration for login:

### htpasswd (operator-provided)

No credentials are bundled with the chart. Provide pre-hashed credentials at
install time, or manage the authentication Secret outside Helm.

#### Pre-hashed htpasswd content

Provide an htpasswd file (one `user:bcrypt-hash` line per entry) with `--set-file`:

```bash
# Generate a bcrypt hash for a user (prompts for the password, so it never
# appears in shell history or process listings)
htpasswd -nB <username> > /tmp/portal-htpasswd

# Install with the htpasswd file
helm install cubestack-portal ./web/helm/cubestack-portal-chart \
  --namespace cubestack-system --create-namespace \
  --set-file secrets.htpasswd.content=/tmp/portal-htpasswd
```

For a single entry, pass the line inline with `--set` instead. The value is the
raw `user:bcrypt-hash` text — the chart base64-encodes it when writing the
Secret, so do not pass an already-base64-encoded string:

```bash
helm install cubestack-portal ./web/helm/cubestack-portal-chart \
  --namespace cubestack-system --create-namespace \
  --set 'secrets.htpasswd.content=admin:$2a$10$9/nTwyvmfwMdwc.OSsoZFe9gTfGfoCVdKIcSwcQWb6Qll7TmygG26'
```

Single-quote the value: a bcrypt hash contains `$`, which an unquoted or
double-quoted shell would otherwise expand as a variable.

The chart creates a Secret named `secrets.htpasswd.secretName`
(`cubestack-htpasswd` by default) in the target namespace, holding the content
under `secrets.htpasswd.key` (`htpasswd` by default) — the same name, key and
namespace the deployment passes to the app and the Role grants `get` on, so no
extra configuration is required for login.

To manage credentials outside Helm, create the Secret yourself with that name
and data key and leave `secrets.htpasswd.content` empty. The chart will not
create or modify it (it only templates the Secret when content is set).
Overriding `secretName` (or `key`) keeps the deployment env, the Role's
`resourceNames` and the created Secret in sync — but an externally managed
Secret must use the same name. Without either source, the portal reports
"auth not configured" when login is attempted.

### Authorization model

Authentication is the only access control the portal implements. Every htpasswd
entry is a fully privileged portal user: a valid session can read cluster-wide
and create/update/delete inference services and dev environments in any existing
namespace the UI offers (profiles and model versions are read-only). Sessions
carry only the username (no roles, no namespace scoping), so there is no way to
grant a user write access to a subset of namespaces.

Treat the htpasswd credentials as platform-admin credentials and protect the
`cubestack-htpasswd` Secret accordingly. If you need per-namespace
authorization, it is not provided by this chart — do not deploy the portal
where untrusted users can reach it.

### Session Secret

The portal signs session cookies with `SESSION_SECRET`. By default, a random secret is generated. To customize it:

```yaml
secrets:
  sessionSecret:
    create: false
    existingSecret: my-session-secret
    existingSecretKey: session-secret
```

Create the secret manually:

```bash
# Generate a random secret
openssl rand -hex 32

# Create Kubernetes Secret
kubectl -n cubestack-system create secret generic my-session-secret \
  --from-literal=session-secret=<your-secret>
```

## Troubleshooting an empty page

The portal renders what the cluster returns, so an empty 配置 / 任务 page is
almost always a cluster-side problem. The page keeps the raw error (or, when the
builtin AgentTemplate is missing, an explicit "not found" notice) on screen
instead of a toast, and the pod logs carry the same detail — check these in
order:

Start from the values that decide *where* the portal looks:
`operatorNamespace` (`CUBESTACK_TASKS_NAMESPACE`), `agentApiUrl`
(`CUBESTACK_PILOT_URL`) and `gateway.*` — an empty 配置 page is almost always
`operatorNamespace` pointing away from the CRs.

```bash
# 1. Which namespace/CRDs is the portal actually using? (logged once at the
#    first request with logLevel=debug)
kubectl -n <release-ns> logs deploy/<release>-cubestack-portal | head -20
kubectl -n <release-ns> logs deploy/<release>-cubestack-portal -f          # live
kubectl -n <release-ns> set env deploy/<release>-cubestack-portal CUBESTACK_LOG_LEVEL=debug

# 2. Do the CRs the page reads exist in the operator namespace?
kubectl -n cubestack-system get agenttemplates,agentinstances,skills,tasks

# 3. Are the CRDs installed at all? (a 404 from the API server → HTTP 503)
kubectl get crd | grep ai.cubestack.io

# 4. Does the portal ServiceAccount have permission? (403 is logged verbatim)
kubectl auth can-i list agenttemplates.ai.cubestack.io \
  --as=system:serviceaccount:<release-ns>:<release>-cubestack-portal -n cubestack-system
```

Log levels (`logLevel` / `CUBESTACK_LOG_LEVEL`):

| Level | What it prints |
| --- | --- |
| `error` | cluster call failures, RBAC denials |
| `warn` | the above plus failed API requests (5xx) and unresolved gateway/agent API bases |
| `info` (default) | the above plus one line per API request (`[info] api: request method=GET path=/api/... user=admin status=200 ms=12`) |
| `debug` | the above plus every cluster call (`[debug] k8s: get plural=agenttemplates namespace=cubestack-system name=cubepilot`), gateway/agent API resolution and the startup line with the resolved namespaces |

Secrets are never logged: credential handling prints the Secret name and
namespace only.

## RBAC

The chart automatically creates namespaced and cluster-scoped RBAC:

- `Role` + `RoleBinding`: `get` on the htpasswd Secret (`secrets.htpasswd.secretName`, `cubestack-htpasswd` by default) in the target namespace
- `ClusterRole` + `ClusterRoleBinding`: `list` namespaces / nodes / services (the services rule is the AI Gateway discovery in `envoy-gateway-system`), plus exactly the operator-CR verbs the UI calls, cluster-wide (the UI aggregates and writes across namespaces):
  - `inferenceservices`: create, get, list, patch
  - `devenvironments`: create, delete, list, patch
  - `inferenceruntimeprofiles`, `modelversions`: list
  - `tasks`: create, delete, get, list, patch
  - `taskruns`, `tasktemplates`: get, list
  - `agentinstances`: create, get, patch
  - `agenttemplates`: get; `skills`: get, list

When `operatorNamespace` differs from `namespace`, a second Role/RoleBinding is
created **in the operator namespace** for the external-model credential Secrets
(`llm-<model>`), which are written next to the CRs; the portal namespace keeps
only the htpasswd read then.

No `watch` is granted (nothing in the portal watches), mutations are HTTP
PATCH (JSON-Patch) so `update` is not needed, and no status subresource is
written. Add the verbs back when a feature needs them.

Cluster-scoped object names include the release namespace as a suffix so
same-named releases in different namespaces do not collide.

## Uninstallation

```bash
helm uninstall cubestack-portal --namespace cubestack-system
```

## Customization

You can customize the deployment by creating a `values.custom.yaml` file and passing it to the `helm install` command:

```yaml
replicaCount: 3

ingress:
  enabled: true
  hosts:
    - host: ui.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: ui-tls
      hosts:
        - ui.example.com

resources:
  limits:
    cpu: 1000m
    memory: 1Gi
  requests:
    cpu: 500m
    memory: 512Mi

env:
  NODE_ENV: production
```

The Portal is always exposed through a `ClusterIP` Service on port `80`
(targeting the container's `3000`) with an auto-generated ServiceAccount;
neither is configurable, and the container port is pinned to `3000` (`PORT`).
