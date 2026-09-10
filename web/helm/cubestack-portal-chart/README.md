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
| `namespace` | Target namespace | `cubestack-system` |
| `secrets.htpasswd.content` | Pre-hashed htpasswd content (raw `user:bcrypt-hash` line, not base64) | `""` |

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

The chart creates a Secret named `cubestack-htpasswd` in the target namespace,
which matches the portal's built-in lookup default — no environment variables
or additional configuration are required for login.

To manage credentials outside Helm, create a Secret named
`cubestack-htpasswd` with the pre-hashed file stored under the `htpasswd` data
key and leave `secrets.htpasswd.content` empty. The chart will not create or
modify that Secret. Without either source, the portal reports "auth not
configured" when login is attempted.

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

## RBAC

The chart automatically creates namespaced and cluster-scoped RBAC:

- `Role` + `RoleBinding`: read the htpasswd Secret (`cubestack-htpasswd` by default), get/list/watch the operator CRs (`inferenceservices`, `devenvironments`, `inferenceruntimeprofiles`, `modelversions`)
- `ClusterRole` + `ClusterRoleBinding`: list namespaces and nodes, and get/list/watch/create/update/delete the operator CRs cluster-wide (the UI aggregates them across namespaces)

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
