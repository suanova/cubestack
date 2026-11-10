#!/usr/bin/env bash
# Installs the upstream LeaderWorkerSet controller AND its
# leaderworkerset/disaggregatedset CRDs into the helm-e2e kind cluster from the
# pinned lws module's config/default (the chart ships only the ai.cubestack.io
# CRDs). Without the controller and its CRDs LeaderWorkerSets never materialize
# pods, so ISVC Ready is unreachable.
#
# The controller image reference in the manifests points at the upstream
# staging registry, which is unreachable from this network. Image fallback
# chain: (1) the platform registry's mirror of the release-tagged upstream
# image, (2) docker pull of the manifest image, (3) the same image via the
# docker.1ms.run mirror (retagged to the original ref), (4) a local build from
# the pinned lws go module (golang:1.26 + distroless bases are cached; the
# build uses the goproxy.cn mirror because proxy.golang.org is unreachable).
# The picked image is then loaded into kind so the kubelet runs it locally.
#
# CI stops at step 1 (GitHub Actions sets CI=true): everything past it is
# either the mutable `main` tag the note below rejects or a local build that
# costs a cold ~80s Go compile on every run to reproduce a byte-identical
# image. The mirror is pinned to the release tag for the same module version
# go.mod names, so it is the deterministic v0.10.0 build steps 2-4 were trying
# to approximate — and cheaper than all of them.
#
# Idempotent: exits early when lws-controller-manager is already Available.
set -euo pipefail

NS="lws-system"
DEPLOY="lws-controller-manager"

KIND_CLUSTER="${KIND_CLUSTER_HELM:-cubestack-helm-e2e}"
CTX="kind-${KIND_CLUSTER}"
KUBECTL="${KUBECTL:-kubectl}"
DOCKER="${DOCKER:-docker}"
KIND_BIN="${KIND:-kind}"
# kind's node runs the host architecture. A plain pull of a multi-arch tag
# stores the index plus only this platform's blobs, and `kind load docker-image`
# re-exports the whole index, so the node's `ctr import --all-platforms` fails
# on the manifests the pull never fetched ("content digest ...: not found").
# Pulling for the node's platform up front — the same rule the Makefile's
# busybox pull follows — leaves nothing for the load to miss.
LWS_PLATFORM="linux/$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')"

cd "$(dirname "$0")/.." # operator/

if [ "$("${KUBECTL}" --context "${CTX}" get deployment -n "${NS}" "${DEPLOY}" \
  -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || true)" = "True" ]; then
  echo "lws-controller-manager already Available in ${NS} on ${CTX} — skipping"
  exit 0
fi

# --- locate the pinned lws go module (version source of truth: go.mod) ---
LWS_VER="$(awk '$1=="sigs.k8s.io/lws" {print $2}' go.mod)"
[ -n "${LWS_VER}" ] || { echo "sigs.k8s.io/lws not found in go.mod" >&2; exit 1; }
go mod download sigs.k8s.io/lws
LWS_MOD="$(go env GOMODCACHE)/sigs.k8s.io/lws@${LWS_VER}"
[ -f "${LWS_MOD}/config/default/kustomization.yaml" ] || { echo "lws module config missing: ${LWS_MOD}" >&2; exit 1; }

# The mirrored release image. Tagging it with the module version rather than
# the upstream one (v0.10.0 here, 0.10.0 there) is deliberate: a bump to the
# pin in go.mod then names a tag nobody has published, which fails the pull
# below loudly instead of quietly running the previous controller against a
# newer CRD set. Re-publish with hack/mirror-e2e-images.sh.
LWS_IMAGE_REPO="${LWS_IMAGE_REPO:-harbor.isuanova.com/mirrors/registry.k8s.io/lws/lws}"
LWS_IMAGE="${LWS_IMAGE_REPO}:${LWS_VER}"

KUSTOMIZE="${KUSTOMIZE:-$(pwd)/bin/kustomize}"
if [ ! -x "${KUSTOMIZE}" ]; then
  make -s kustomize
fi

# --- image ref baked into the module manifests (config/manager images) ---
MANIFEST_REF="$("${KUSTOMIZE}" build "${LWS_MOD}/config/manager" 2>/dev/null | awk '/^[[:space:]]*image: /{print $2; exit}')"
MANIFEST_REF="${MANIFEST_REF:-us-central1-docker.pkg.dev/k8s-staging-images/lws/lws:main}"

# NOTE: the pinned v0.10.0 module's own config/manager kustomization sets
# newTag: main, so a successful pull of MANIFEST_REF runs a mutable `main`
# controller against v0.10.0 CRDs (nondeterministic, and staging GCs
# non-release tags so the pull can silently start failing later). The mirror is
# built from the release tag for the same version, which is why it is tried
# first everywhere, not just in CI. Steps 2-4 below are the fallbacks for a
# network that cannot reach the platform registry.
REF=""
if "${DOCKER}" pull --platform "${LWS_PLATFORM}" "${LWS_IMAGE}" >/dev/null 2>&1; then
  REF="${LWS_IMAGE}"
  echo "pulled the pinned lws controller image ${REF}"
elif [ -n "${CI:-}" ]; then
  # Deliberately not falling through to the local build. A CI run that quietly
  # spends ~80s rebuilding what the mirror should have supplied is how a
  # missing mirror goes unnoticed for months.
  echo "cannot pull ${LWS_IMAGE} from the platform registry. If it is missing" >&2
  echo "rather than unreachable, publish it with hack/mirror-e2e-images.sh —" >&2
  echo "it mirrors registry.k8s.io/lws/lws:${LWS_VER#v}." >&2
  exit 1
elif "${DOCKER}" pull --platform "${LWS_PLATFORM}" "${MANIFEST_REF}" >/dev/null 2>&1; then
  REF="${MANIFEST_REF}"
  echo "pulled upstream manifest image ${REF}"
elif "${DOCKER}" pull --platform "${LWS_PLATFORM}" "docker.1ms.run/${MANIFEST_REF}" >/dev/null 2>&1; then
  "${DOCKER}" tag "docker.1ms.run/${MANIFEST_REF}" "${MANIFEST_REF}"
  REF="${MANIFEST_REF}"
  echo "pulled docker.1ms.run/${MANIFEST_REF} via mirror, retagged to ${REF}"
else
  REF="example.com/lws/lws:${LWS_VER}"
  echo "registry pulls unavailable — building the lws manager locally from the pinned go module as ${REF}"
  "${DOCKER}" build -t "${REF}" -f - "${LWS_MOD}" <<'DOCKERFILE'
FROM golang:1.26 AS builder
# proxy.golang.org is unreachable from this network; mirror the operator
# image build (operator/Dockerfile) and use the goproxy.cn module proxy.
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Plain go build of cmd/main.go: the module's `make build` would also run
# controller-gen (manifests) which needs extra downloads.
RUN CGO_ENABLED=0 GOOS=linux go build -o manager ./cmd
FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /workspace/manager .
USER 65532:65532
ENTRYPOINT ["/manager"]
DOCKERFILE
fi

echo "loading ${REF} into kind cluster ${KIND_CLUSTER}"
# kind's docker-image path re-exports the whole index, and a containerd-backed
# docker keeps the multi-arch index on the tag even after a platform pull, so
# the node's `ctr import --all-platforms` fails on manifests that were never
# fetched. Export only the node's platform and hand the archive to kind; the
# archive then carries exactly the manifests the import walks.
LWS_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/lws-image.XXXXXX")"
trap 'rm -f "${LWS_ARCHIVE}"' EXIT
if "${DOCKER}" save --platform "${LWS_PLATFORM}" -o "${LWS_ARCHIVE}" "${REF}" 2>/dev/null; then
  "${KIND_BIN}" load image-archive "${LWS_ARCHIVE}" --name "${KIND_CLUSTER}"
else
  # docker without `save --platform` (pre-28) or a single-platform image.
  "${KIND_BIN}" load docker-image "${REF}" --name "${KIND_CLUSTER}"
fi

# --- render + apply the full upstream default, CRDs included ---
# The leaderworkerset/disaggregatedset CRDs are part of this install: the
# chart ships only the ai.cubestack.io CRDs. Server-side apply (below) is
# required because client-side apply stamps a last-applied-configuration
# annotation that exceeds the per-object annotation limit on these large CRDs.
OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT
"${KUSTOMIZE}" build "${LWS_MOD}/config/default" > "${OUT}"
# replace(..., 1) assumes the image ref occurs exactly once in the bundle (true
# for v0.10.0: one manager Deployment). A future lws bump that duplicates the
# ref would leave the second occurrence at MANIFEST_REF — an image that cannot
# be pulled here — which fails loudly at rollout instead of confusingly.
if [ "${REF}" != "${MANIFEST_REF}" ]; then
  python3 - "${OUT}" "${MANIFEST_REF}" "${REF}" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read().replace("image: " + old, "image: " + new, 1)
open(path, "w").write(s)
PY
fi

echo "applying LWS controller manifests (incl. CRDs) to ${CTX}"
"${KUBECTL}" --context "${CTX}" apply --server-side -f "${OUT}"

echo "waiting for ${DEPLOY} in ${NS} to be ready..."
"${KUBECTL}" --context "${CTX}" rollout status deployment/"${DEPLOY}" -n "${NS}" --timeout=300s
