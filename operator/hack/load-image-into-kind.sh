#!/usr/bin/env bash
# Loads docker images into a kind cluster one platform at a time.
#
# `kind load docker-image` runs `docker save` on whatever the tag resolves to.
# With the containerd image store that is a multi-arch index whose other
# platforms were never fetched — a plain pull keeps the index, and even
# `docker pull --platform` does not prune it. The node then runs
# `ctr import --all-platforms` over the export and fails with
# "content digest ...: not found". Saving just the node's platform (kind nodes
# run the host architecture) into an archive first gives the import exactly the
# manifests the export references.
#
# Falls back to kind's own loader when docker cannot export a platform
# (pre-28 docker, podman, or an image that really is single-platform only).
set -euo pipefail

CLUSTER="${1:?usage: load-image-into-kind.sh <cluster> <image>...}"
shift
[ "$#" -gt 0 ] || { echo "load-image-into-kind: no images given" >&2; exit 1; }

KIND_BIN="${KIND:-kind}"
DOCKER="${DOCKER:-docker}"
PLATFORM="linux/$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')"

for image in "$@"; do
  archive="$(mktemp "${TMPDIR:-/tmp}/kind-image.XXXXXX")"
  trap 'rm -f "${archive}"' EXIT
  if "${DOCKER}" save --platform "${PLATFORM}" -o "${archive}" "${image}" 2>/dev/null; then
    "${KIND_BIN}" load image-archive "${archive}" --name "${CLUSTER}"
  else
    "${KIND_BIN}" load docker-image "${image}" --name "${CLUSTER}"
  fi
  rm -f "${archive}"
done
