#!/usr/bin/env bash
#
# Bring up the CubePilot integration test environment on a local KinD cluster:
# the real cubepilot stack (operator + api + agent CRDs, from the published
# rolling chart) plus this portal built from the working tree, both in ONE
# namespace so the chart's default wiring (CUBESTACK_TASKS_NAMESPACE,
# CUBESTACK_PILOT_URL, the llm-<model> Secret Role) applies unchanged.
#
# Idempotent: re-running replaces both Helm releases.
#
# Env:
#   E2E_MARKER            marker seeded into a CR and asserted by the specs
#                         (default: dev-<epoch>)
#   CUBEPILOT_LLM_APIKEY  real provider key; the placeholder runs L1 only
#   CUBEPILOT_LLM_ENDPOINT / CUBEPILOT_LLM_MODEL
#   CUBEPILOT_CHART_VERSION  chart version (default: the newest published chart)
#   KIND_CLUSTER_NAME     KinD cluster name (default: cubestack-e2e)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../" && pwd)"

NS=cubestack-system
CLUSTER="${KIND_CLUSTER_NAME:-cubestack-e2e}"
CHART="oci://harbor.isuanova.com/suanova/cubepilot-chart"
CHART_VERSION="${CUBEPILOT_CHART_VERSION:-}"
MARKER="${E2E_MARKER:-dev-$(date +%s)}"
LLM_KEY="${CUBEPILOT_LLM_APIKEY:-sk-placeholder}"
LLM_ENDPOINT="${CUBEPILOT_LLM_ENDPOINT:-https://api.deepseek.com}"
LLM_MODEL="${CUBEPILOT_LLM_MODEL:-deepseek-v4-flash}"
PORTAL_IMAGE="cubestack-ui:e2e"

info() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

for c in docker kind kubectl helm; do
  command -v "$c" >/dev/null || die "$c is not on PATH"
done

info "KinD cluster '${CLUSTER}'"
if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  kind create cluster --name "${CLUSTER}" --wait 120s
fi
# Never switch the caller's context silently: everything below acts on whatever
# context is current (the same rule as e2e/deploy/test-env/setup.sh).
CTX="$(kubectl config current-context 2>/dev/null || true)"
[ "${CTX}" = "kind-${CLUSTER}" ] \
  || die "kubectl context is '${CTX}', not 'kind-${CLUSTER}'. kind create switches it for you; a pre-existing cluster does not. Run: kubectl config use-context kind-${CLUSTER}"

info "namespace ${NS}"
kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# The builtin AgentTemplate references this Secret (key apiKey); a placeholder
# key still makes the operator render the template's provider entry, which is
# what the config page's model picker reads.
info "secret cubepilot-llm"
kubectl -n "${NS}" create secret generic cubepilot-llm \
  --from-literal=apiKey="${LLM_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

info "cubepilot stack (operator + api + agent CRDs; web.enabled=false)"
# helm installs the chart's crds/ directory on a first install, which is what
# this is; a re-run is an upgrade and leaves the CRDs alone (they are stable).
# --devel: the rolling chart is tagged 1.0.0-latest, and Helm skips prerelease
# tags unless asked — without it the install silently lands on the older 0.1.0.
# Harbor drops an occasional blob mid-pull (a CI "TLS handshake timeout"), so
# retry the install a few times.
for attempt in 1 2 3; do
  if helm upgrade --install cubepilot "${CHART}" --devel ${CHART_VERSION:+--version "${CHART_VERSION}"} \
    -n "${NS}" \
    --set web.enabled=false \
    --set agents.llmEndpoint="${LLM_ENDPOINT}" \
    --set agents.llmModel="${LLM_MODEL}" \
    --wait --timeout 300s; then
    break
  fi
  [ "${attempt}" -lt 3 ] || die "cubepilot install failed after ${attempt} attempts"
  info "cubepilot install attempt ${attempt} failed; retrying in $((attempt * 10))s"
  sleep $((attempt * 10))
done

# The agent CRDs come from the cubepilot chart; the platform CRDs the portal's
# other pages read (model catalog, dev environments) come from this repo.
info "CubeStack CRDs (inferenceservices/devenvironments/…)"
kubectl apply -k "${REPO_ROOT}/operator/config/crd"
kubectl wait --for=condition=Established --timeout=60s \
  crd/inferenceservices.ai.cubestack.io \
  crd/devenvironments.ai.cubestack.io \
  crd/inferenceruntimeprofiles.ai.cubestack.io \
  crd/modelversions.ai.cubestack.io

# The operator bootstraps the builtin AgentTemplate on its first reconcile; the
# config page's PUT answers 503 until it exists.
info "waiting for the builtin AgentTemplate"
for _ in $(seq 1 60); do
  kubectl -n "${NS}" get agenttemplate cubepilot >/dev/null 2>&1 && break
  sleep 2
done
kubectl -n "${NS}" get agenttemplate cubepilot >/dev/null 2>&1 \
  || die "operator did not create AgentTemplate cubepilot within 120s"

info "portal image (${PORTAL_IMAGE}) from the working tree"
docker build -t "${PORTAL_IMAGE}" -f "${REPO_ROOT}/web/Dockerfile" "${REPO_ROOT}/web"
kind load docker-image "${PORTAL_IMAGE}" --name "${CLUSTER}"

# Fixed session secret: the specs mint cookies with e2e-session-secret
# (web/e2e/auth.ts), and the chart generates a random one otherwise. The chart
# always renders its own <fullname>-session-secret, so this one needs another
# name or Helm collides with it (and empties it) on install.
info "session secret portal-session"
kubectl -n "${NS}" create secret generic portal-session \
  --from-literal=session-secret=e2e-session-secret \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

info "portal (chart default wiring: agentApiUrl empty, operatorNamespace empty)"
helm upgrade --install portal "${REPO_ROOT}/web/helm/cubestack-portal-chart" \
  -n "${NS}" \
  --set fullnameOverride=portal \
  --set image.repository=cubestack-ui \
  --set image.tag=e2e \
  --set image.pullPolicy=IfNotPresent \
  --set secrets.sessionSecret.create=false \
  --set secrets.sessionSecret.existingSecret=portal-session \
  --wait --timeout 240s

info "seeding a Task CR (owner=admin, templateRef=daily-inspection)"
kubectl -n "${NS}" apply -f - >/dev/null <<YAML
apiVersion: ai.cubestack.io/v1alpha1
kind: Task
metadata:
  name: e2e-task
  annotations:
    cubepilot/display-name: 集成测试任务 ${MARKER}
spec:
  owner: admin
  templateRef: daily-inspection
  instruction: 报告集群状态,不要修改任何资源
  state: Enabled
YAML

# cubepilot-api provisions its builtin `admin` AgentInstance the first time its
# session surface is used and answers 503 while that settles — 20-84s, longer
# than a caller's own timeout. Warm it to a real 200 so "ready" means serving.
info "warming the agent API (first-use provisioning)"
warm_start="${SECONDS}"
warm_deadline=$(( SECONDS + 420 ))
warm_ok=""
while [ "${SECONDS}" -lt "${warm_deadline}" ]; do
  if kubectl -n "${NS}" exec deploy/portal -- env \
    WARM_URL="http://cubepilot-api.${NS}.svc:8080/api/v1/sessions" \
    node -e 'fetch(process.env.WARM_URL, { signal: AbortSignal.timeout(45000) })
      .then((r) => { console.log("  agent API /sessions -> " + r.status); process.exit(r.status === 200 ? 0 : 1); })
      .catch((e) => { console.log("  agent API unreachable: " + String(e)); process.exit(1); });'; then
    warm_ok=yes
    break
  fi
  sleep 5
done
[ -n "${warm_ok}" ] || die "agent API did not serve a 200 within $((SECONDS - warm_start))s"
info "agent API serving (warmed in $((SECONDS - warm_start))s)"

cat <<EOF

==> Integration environment ready (marker: ${MARKER})
    portal:  kubectl -n ${NS} port-forward svc/portal 8080:80
             → http://localhost:8080/cubestack/cubepilot
    run:     cd web && E2E_MARKER=${MARKER} npm run test:e2e:integration
    CR check: kubectl -n ${NS} get agentinstance admin-cubepilot -o jsonpath='{.spec.userInstructions}'
EOF
