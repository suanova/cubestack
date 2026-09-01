#!/usr/bin/env bash
#
# setup.sh — one-shot test-environment setup for the CubeStack web portal on a
# local KinD cluster.
#
# What it does:
#   1. Verifies kubectl can reach the KinD cluster (context `kind-<name>`).
#   2. Creates the namespaces the sample CRs live in (project-a, project-llm).
#   3. Installs the operator CRDs (operator/config/crd).
#   4. Applies the sample CRs (operator/config/samples): one InferenceService,
#      one DevEnvironment, one InferenceRuntimeProfile, one ModelVersion.
#   5. Prints what the overview should show against this cluster.
#   6. Starts the web dev server against the cluster (Ctrl-C to stop).
#
# Options:
#   --skip-dev        don't start the web dev server (cluster setup only)
#   --with-operator   also run the operator controller from the host (needs Go)
#
# Environment:
#   KIND_CLUSTER_NAME  KinD cluster name (default: cubestack)
#   KUBECONFIG         optional; defaults to the current kubeconfig context
#
# The dev server reads the cluster through @kubernetes/client-node's default
# kubeconfig loader, so it uses whatever context is current — same as kubectl.
# Run `kubectl config use-context kind-cubestack` (or export KUBECONFIG) if the
# current context is a different cluster.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This script lives at web/e2e/deploy/test-env; the repo root is four levels up.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../" && pwd)"
OPERATOR_DIR="${REPO_ROOT}/operator"
WEB_DIR="${REPO_ROOT}/web"

CLUSTER_NAME="${KIND_CLUSTER_NAME:-cubestack}"
CONTEXT="kind-${CLUSTER_NAME}"

info() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# --- flags ------------------------------------------------------------------
START_DEV=1
WITH_OPERATOR=0
for arg in "$@"; do
  case "${arg}" in
    --skip-dev)      START_DEV=0 ;;
    --with-operator) WITH_OPERATOR=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown option: ${arg} (see --help)" ;;
  esac
done

# --- preflight --------------------------------------------------------------
command -v kubectl >/dev/null || die "kubectl is not on PATH"
[ -d "${OPERATOR_DIR}" ] || die "operator/ not found under ${REPO_ROOT}"
[ -d "${WEB_DIR}" ] || die "web/ not found under ${REPO_ROOT}"

CURRENT="$(kubectl config current-context 2>/dev/null || true)"
if [ "${CURRENT}" != "${CONTEXT}" ]; then
  die "current kubeconfig context is '${CURRENT}', not '${CONTEXT}'. Run: kubectl config use-context ${CONTEXT}"
fi
if ! kubectl cluster-info --request-timeout=5s >/dev/null 2>&1; then
  die "cluster '${CONTEXT}' is not reachable (kubectl cluster-info failed). Is the KinD cluster running?"
fi
info "Cluster ready: ${CONTEXT} ($(kubectl version 2>/dev/null | sed -n 's/^Server Version: //p'))"

# --- namespaces -------------------------------------------------------------
info "Ensuring namespaces: project-a, project-llm"
for ns in project-a project-llm; do
  kubectl create namespace "${ns}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
done

# --- CRDs then samples ------------------------------------------------------
info "Installing operator CRDs (kubectl apply -k operator/config/crd)"
kubectl apply -k "${OPERATOR_DIR}/config/crd"

info "Waiting for CRDs to be established"
kubectl wait --for=condition=Established \
  crd/inferenceservices.ai.cubestack.io \
  crd/devenvironments.ai.cubestack.io \
  crd/inferenceruntimeprofiles.ai.cubestack.io \
  crd/modelversions.ai.cubestack.io \
  --timeout=60s

info "Applying sample CRs (kubectl apply -k operator/config/samples)"
kubectl apply -k "${OPERATOR_DIR}/config/samples"

info "Installed operator resources:"
kubectl get inferenceservices.ai.cubestack.io -A
kubectl get devenvironments.ai.cubestack.io -A

# --- expected overview ------------------------------------------------------
cat <<EOF

$(info "What the overview should show against this KinD cluster")

  活跃节点          total 1 (this control-plane node)
  GPU 卡总数        0 — KinD nodes expose no GPU extended resources, so the
                    GPU card/vendor KPIs are 0 here. On a real GPU cluster the
                    node extended resources drive these.
  推理服务          total 1 (dsv4-flash-pd) · ready 0 · scaling 0
  开发环境          total 1 (dev-llm-alice) · running 0 · stopped 0
  GPU 分配          计算池 1 (reads spec.resources.gpuCount directly) ·
                    推理池 0 · 已分配 1 · 空闲 0

  Caveats (honest empty states, not bugs):
   - inference ready/scaling and devenv running/stopped stay 0 because the
     operator's current reconcile stage only writes Rendered/Provisioned
     conditions; status.roles and devenv status.phase are not populated yet
     (there is no DevEnvironment controller). --with-operator runs the
     controller so the isvc reconciles, but these fields still don't fill.
   - the utilization trend stays empty unless a Prometheus with GPU exporters
     is reachable via PERSES_SERVER_URL (default http://localhost:8080, through
     the perses datasource proxy). See web/e2e/deploy/perses/local/run-preview.sh
     for the Docker-free local preview, and web/e2e/deploy/perses/README.md for
     the in-cluster option.

EOF

# --- optional operator ------------------------------------------------------
OPERATOR_PID=""
cleanup() {
  [ -n "${OPERATOR_PID}" ] && kill "${OPERATOR_PID}" 2>/dev/null || true
}
trap cleanup EXIT

if [ "${WITH_OPERATOR}" = "1" ]; then
  command -v go >/dev/null || die "--with-operator requires the Go toolchain"
  mkdir -p "${REPO_ROOT}/.test"
  info "Starting operator controller from host (go run ./cmd/main.go)"
  info "  logs → ${REPO_ROOT}/.test/operator.log"
  ( cd "${OPERATOR_DIR}" && go run ./cmd/main.go >"${REPO_ROOT}/.test/operator.log" 2>&1 ) &
  OPERATOR_PID=$!
fi

# --- web dev server ---------------------------------------------------------
if [ "${START_DEV}" = "1" ]; then
  info "Starting web dev server → http://localhost:3000 (Ctrl-C to stop)"
  ( cd "${WEB_DIR}" && npm run dev ) || die "web dev server exited with an error"
else
  info "Skipping dev server (--skip-dev). Start it yourself with:"
  info "  (cd ${WEB_DIR} && npm run dev)  — context must be ${CONTEXT}"
fi
