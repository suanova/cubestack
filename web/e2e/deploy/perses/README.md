# Perses server for the web portal dashboards

Deploys the [Perses](https://perses.dev) dashboarding server that backs the
web portal's `/dashboards` pages. It seeds, at startup, a project and a
Prometheus global datasource (from `provisioning/`) that the dashboards query.
The GPU dashboards themselves are parked at the repo-root `deploy/perses/
provisioning/` while we decide whether to keep them.

```
portal browser ──/api/perses/*──▶ Next.js proxy ──▶ perses:8080 ──/proxy/globaldatasources/...──▶ Prometheus/Thanos
```

## Deploy

```bash
kubectl apply -k web/e2e/deploy/perses/
```

This uses kustomize (`configMapGenerator`) to build the config and provisioning
ConfigMaps from the files in this directory — no separate ConfigMap manifests
to keep in sync.

## Single configuration knob: the Prometheus URL

The dashboards read from a global datasource named `prometheus-datasource`
(`provisioning/global-datasource.yaml`). Its URL is the only thing you must set
per cluster — the browser never sees it; Perses proxies Prometheus queries to
it.

Point it at the in-cluster Prometheus or Thanos service before applying:

```yaml
# provisioning/global-datasource.yaml
        spec:
          url: http://prometheus-k8s.openshift-monitoring.svc:9090
```

or, for Thanos, e.g. `http://thanos-querier.openshift-monitoring.svc:9091`.

> Changes to `global-datasource.yaml` require re-applying, since kustomize
> embeds it into a ConfigMap.

## Wiring the portal

The portal's proxy route (`web/app/api/perses/[...path]/route.ts`) forwards
`/api/perses/*` to the Perses server, configured by the
`PERSES_SERVER_URL` environment variable. In-cluster, point it at this
Service:

```
PERSES_SERVER_URL=http://perses.<namespace>.svc:8080
```

The dashboards live in project `perses-dev` (see
`provisioning/project.yaml`). The portal's `NEXT_PUBLIC_PERSES_PROJECT` env
(defaults to `perses-dev`) must match.

## Image version

`persesdev/perses:v0.54.0` stays close to the portal's `@perses-dev/*` client
packages (all `0.54.0`) so the plugin/API surfaces stay compatible. Bump both
together.

> The perses 0.54 plugin bundles (served by this server) require React 18.2.0.
> The portal pins `react`/`react-dom` to `18.2.0` and runs Next.js 14.2.x, the
> last major whose App Router compiles a React 18 runtime (`18.3.0-canary`) with
> the internal (`ReactCurrentOwner`) the perses plugin bundles read. Next.js
> 15/16 force React 19, which removed that internal — those majors cannot host
> these dashboards.

## Local development

Run the same Perses server locally with these provisioning files, so `npm run
dev` in `web/` (default `PERSES_SERVER_URL=http://localhost:8080`) has something
to proxy to.

### Without Docker (recommended for the dev box)

`local/run-preview.sh` starts the whole preview stack: a mock Prometheus on
:9090 (synthetic metrics, so panels render data without a real cluster), the
Perses server on :8081 (proxied by the portal), and the Next.js dev server on
:3000:

```bash
web/e2e/deploy/perses/local/run-preview.sh
```

On first run it downloads the perses release binary (which ships the remote
plugin bundles) into `~/.cache/perses-preview`. If GitHub is unreachable, set
the local proxy first, e.g.
`https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 ./run-preview.sh`.

### With Docker

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/web/e2e/deploy/perses/config.yaml:/etc/perses/config.yaml:ro" \
  -v "$PWD/web/e2e/deploy/perses/provisioning:/etc/perses/provisioning:ro" \
  persesdev/perses:v0.54.0
```

For dashboards to show data, the datasource URL in
`provisioning/global-datasource.yaml` must point at a Prometheus the container
can reach (e.g. `http://host.docker.internal:9090` for a Prometheus running on
the host, or a port-forwarded in-cluster Prometheus).

## Layout

- `config.yaml` — server config (file DB in `/perses`, provisioning folders).
- `provisioning/` — resources seeded at startup: the project and the global
  Prometheus datasource (all the CI e2e needs). The GPU dashboards
  (`resource-overview-dashboard`, `inference-service-dashboard`,
  `dev-environment-dashboard`) are parked at `deploy/perses/provisioning/`
  (repo root) pending a decision; re-add them here and to `kustomization.yaml`
  if we keep them.
- `deployment.yaml` / `service.yaml` — the Deployment and ClusterIP Service.
- `kustomization.yaml` — wires the above together.
