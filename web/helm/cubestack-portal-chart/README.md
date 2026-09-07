# CubeStack Portal Chart Helm Chart

This Helm chart deploys the CubeStack Portal (UI) application to a Kubernetes cluster.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.2.0+

## Installation

### Using default values

```bash
helm install my-portal ./helm/cubestack-portal-chart
```

### Using custom values

```bash
helm install my-portal -f values.custom.yaml ./helm/cubestack-portal-chart
```

### Using OCI registry

```bash
helm install my-portal oci://<registry>/cubestack-portal-chart --version <version>
```

## Configuration

The following table lists the configurable parameters of the Portal chart and their default values.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `image.registry` | UI image registry | `harbor.isuanova.com` |
| `image.repository` | UI image repository | `suanova/cubestack-ui` |
| `image.tag` | UI image tag | `latest` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `replicaCount` | Number of replicas | `1` |
| `service.type` | Kubernetes Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `service.targetPort` | Target port | `3000` |
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
| `serviceAccount.name` | ServiceAccount name | `""` (auto-generated) |
| `serviceAccount.annotations` | ServiceAccount annotations | `{}` |

### Environment Variables

The chart supports passing environment variables to the UI container via the `env` parameter in `values.yaml`:

```yaml
env:
  VARIABLE_NAME: "value"
  ANOTHER_VAR: "another_value"
```

## Authentication

The portal requires authentication configuration for login:

### htpasswd (Hardcoded)

The `templates/portal/htpasswd.yaml` file contains demo credentials `admin / admin`. Replace the base64-encoded htpasswd content with your own bcrypt hashes before production use:

```bash
# Generate a new bcrypt hash
htpasswd -nbB <username> <password>

# Encode to base64 (Linux)
echo -n "<user:hash>" | base64

# Encode to base64 (macOS)
echo -n "<user:hash>" | base64 | tr -d '\n'
```

Then update `templates/portal/htpasswd.yaml` with the new encoded value.

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

The chart automatically creates a Role and RoleBinding with the following permissions:
- Read `cubestack-htpasswd` secret
- List namespaces
- Get/List/Watch operator CRDs: `inferenceservices`, `devenvironments`, `inferenceruntimeprofiles`, `modelversions`

## Uninstallation

```bash
helm uninstall my-portal
```

## Customization

You can customize the deployment by creating a `values.custom.yaml` file and passing it to the `helm install` command:

```yaml
replicaCount: 3

service:
  type: LoadBalancer

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
  PORT: "3000"
```
