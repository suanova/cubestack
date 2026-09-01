#!/usr/bin/env bash
# Local, Docker-free preview of the Perses-backed dashboards.
#
# Starts three processes:
#   1. mock-prometheus (:9090)   synthetic metrics so panels render data
#   2. perses           (:8081)  serves the provisioned dashboards + plugins
#   3. Next.js portal   (:3000)  proxies /api/perses/* -> perses
#
# The perses release tarball ships the remote plugin bundles in
# plugins-archive/. The server only serves plugins it has extracted, so the
# script sets both plugin.archive_paths (the archives) and plugin.path (a
# scratch dir the server extracts into) — without plugin.path, /api/v1/plugins
# comes back empty and no panels render.
#
# Prereqs: node (mock server + Next), curl, tar. The perses binary is downloaded
# into ~/.cache/perses-preview on first run; if GitHub is unreachable, export
# the local proxy first (the cubestack dev box blocks raw.githubusercontent.com):
#
#   https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 ./run-preview.sh
#
# Stop with Ctrl-C; all three processes are killed on exit.
set -euo pipefail

VERSION="0.54.0" # must stay in lockstep with the web/@perses-dev packages (see README)
PERSES_PORT="${PERSES_PORT:-8081}"       # avoid 8080, which the dev box uses for other work
DATASOURCE_URL="${PROMETHEUS_URL:-http://127.0.0.1:9090}"

# This script lives at web/e2e/deploy/perses/local; the repo root is five levels up.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
WEB_DIR="${REPO_ROOT}/web"
PROVISIONING_SRC="${REPO_ROOT}/web/e2e/deploy/perses/provisioning"
CACHE_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/perses-preview"
PERSES_DIR="${CACHE_DIR}/perses-${VERSION}"

mkdir -p "${CACHE_DIR}"

# --- perses binary + plugin archives --------------------------------------
if [ ! -x "${PERSES_DIR}/perses" ]; then
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64) arch="amd64" ;;
    aarch64) arch="arm64" ;;
  esac
  tarball="perses_${VERSION}_${os}_${arch}.tar.gz"
  url="https://github.com/perses/perses/releases/download/v${VERSION}/${tarball}"
  echo "Downloading ${url} ..."
  curl -fL --retry 3 -o "${CACHE_DIR}/${tarball}" "${url}"
  mkdir -p "${PERSES_DIR}"
  tar -xzf "${CACHE_DIR}/${tarball}" -C "${PERSES_DIR}"
fi

# --- preview provisioning: repo copy, datasource pointed at the local mock --
PROV_DIR="${CACHE_DIR}/provisioning"
rm -rf "${PROV_DIR}"
cp -R "${PROVISIONING_SRC}" "${PROV_DIR}"
# The repo file carries the in-cluster placeholder; rewrite the URL for local.
sed -i.bak -E "s#url: http://prometheus-k8s[^ ]*#url: ${DATASOURCE_URL}#" \
  "${PROV_DIR}/global-datasource.yaml"
rm -f "${PROV_DIR}/global-datasource.yaml.bak"

# --- perses config ---------------------------------------------------------
cat > "${CACHE_DIR}/config.yaml" <<EOF
database:
  file:
    folder: ${CACHE_DIR}/data
    extension: json
security:
  readonly: false
plugin:
  archive_paths:
    - ${PERSES_DIR}/plugins-archive
  path: ${CACHE_DIR}/plugins
provisioning:
  folders:
    - ${PROV_DIR}
EOF

# --- start the three processes ---------------------------------------------
MOCK_PID=""
PERSES_PID=""
NEXT_PID=""
cleanup() {
  kill "${MOCK_PID}" "${PERSES_PID}" "${NEXT_PID}" 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting mock Prometheus on :9090 ..."
node "${REPO_ROOT}/web/e2e/deploy/perses/local/mock-prometheus.mjs" 9090 &
MOCK_PID=$!

echo "Starting perses on :${PERSES_PORT} ..."
"${PERSES_DIR}/perses" -config "${CACHE_DIR}/config.yaml" -web.listen-address=":${PERSES_PORT}" &
PERSES_PID=$!

echo "Waiting for perses to come up ..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PERSES_PORT}/api/v1/projects" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Starting Next.js portal on :3000 (proxying /api/perses to :${PERSES_PORT}) ..."
PERSES_SERVER_URL="http://127.0.0.1:${PERSES_PORT}" \
  npm --prefix "${WEB_DIR}" run dev &
NEXT_PID=$!

echo
echo "Open http://127.0.0.1:3000/dashboards"
echo "Stop with Ctrl-C."
wait
