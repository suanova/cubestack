#!/usr/bin/env bash
# Asserts a real DevEnvironment comes up on the helm-e2e kind cluster and is
# reachable through the platform Gateway — over HTTP (JupyterLab) and SSH.
#
# This is the piece envtest cannot cover and the chart's own checks cannot
# either: it exercises the operator, the chart, Envoy Gateway and the dataplane
# together, on the one thing a user actually asks for — that the address in
# status.endpoints works. A spec that reconciles cleanly but publishes an
# address nothing answers is exactly the failure this catches, and it is why
# every assertion below goes through the Gateway's address rather than into the
# cluster.
#
# The assertions mirror images/hack/smoke.sh — the same contract, a different
# substrate: that script asserts the image alone over throwaway containers on
# 127.0.0.1, this one asserts the same image as the platform actually runs it.
#
# Requires the cluster `make helm-e2e-setup` + `helm-e2e-install` produced,
# including MetalLB (the Gateway's address) and the workspace StorageClass.
#
# On macOS the Gateway's address lives inside the Docker VM and is not
# reachable from the host shell; run this on CI, or from a pod on the cluster.
#
# Environment: KIND_CLUSTER_HELM, KUBECTL, DEV_ENV_IMAGE, DEV_ENV_NAMESPACE,
# DEV_ENV_NAME (all defaulted, see below).
set -euo pipefail

cd "$(dirname "$0")/.." # operator/

KIND_CLUSTER="${KIND_CLUSTER_HELM:-cubestack-helm-e2e}"
CTX="kind-${KIND_CLUSTER}"
KUBECTL="${KUBECTL:-kubectl}"
NS="${DEV_ENV_NAMESPACE:-demo}"
ENV_NAME="${DEV_ENV_NAME:-e2e-devenv}"
MANIFEST="test/e2e/assets/devenvironment.yaml"

kubectl_e2e() { "${KUBECTL}" --context "${CTX}" "$@"; }
devenv() { kubectl_e2e get devenvironment "${ENV_NAME}" -n "${NS}" "$@"; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cubestack-devenv.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

pass=0
fail=0
ok() { echo "  PASS  $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }

# check_contains <haystack> <needle> <label>
check_contains() {
  case "$1" in
    *"$2"*) ok "$3" ;;
    *) bad "$3 (missing: $2)" ;;
  esac
}

# url_port <url> — the port in the URL's authority: 80 from
# http://1.2.3.4:80/dev/ns/env/, 20000 from ssh://jovyan@1.2.3.4:20000.
url_port() {
  local a="${1#*://}" # scheme
  a="${a%%/*}"        # authority only
  a="${a##*@}"        # drop any userinfo
  printf '%s\n' "${a##*:}"
}

# http_code_until <url> <expected> — poll until the status matches, within a
# wall-clock budget. Published address and programmed dataplane are not the same
# instant: the controller treats a LoadBalancer dataplane as an identity mapping
# without reading the Service back (externalPorts), so status.endpoints can name
# a port Envoy has not opened yet. A code that never settles is a real failure.
#
# The budget bounds the loop, not one request. Twenty attempts of `--max-time 20`
# three seconds apart is 460s, which is what an address that is being dropped
# rather than refused — the case this exists to fail on — actually costs. Each
# request and each sleep is capped at what is left, so a blackholed address gives
# up in ~60s while a merely slow one still gets its retries.
http_code_until() {
  local url=$1 want=$2 code="" deadline=$((SECONDS + 60)) remaining
  while :; do
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    code="$(curl -s --max-time $((remaining < 5 ? remaining : 5)) \
      -o /dev/null -w '%{http_code}' "${url}" || true)"
    [ "${code}" = "${want}" ] && break
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    sleep $((remaining < 3 ? remaining : 3))
  done
  printf '%s\n' "${code:-000}"
}

# Says what the environment is doing, for the case where it never comes up. The
# DevEnvironment's own status is the first thing to read and the pod the second:
# a pod stuck Pending and a route stuck RouteReady=False look identical from the
# address.
dump() {
  echo "  --- DevEnvironment ---"
  devenv -o yaml 2>&1 | tail -n 40
  echo "  --- pods ---"
  kubectl_e2e get pods -n "${NS}" -o wide 2>&1
  echo "  --- workspace claim ---"
  kubectl_e2e get pvc -n "${NS}" 2>&1
  echo "  --- recent events ---"
  kubectl_e2e get events -n "${NS}" --sort-by=.lastTimestamp 2>&1 | tail -n 20
}

echo "== DevEnvironment e2e: ${NS}/${ENV_NAME} on ${CTX} =="

# The namespace has to sit at Pod Security Baseline, not Restricted: a
# namespace that declares spec.storage gets a root init container that takes
# ownership of the workspace claim, and Restricted rejects root outright. That
# is a property of hosting any DevEnvironment, not of this test — no environment
# is admitted under Restricted, with spec.storage or without (README).
kubectl_e2e create ns "${NS}" --dry-run=client -o yaml | kubectl_e2e apply -f - >/dev/null
kubectl_e2e label ns "${NS}" pod-security.kubernetes.io/enforce=baseline --overwrite >/dev/null

# The manifest's identity is substituted too, not just its image: the three knobs above
# name the resource everywhere else in this script — the namespace is created and labelled
# under ${NS}, and every read is for ${ENV_NAME} — so a manifest left naming its own pair
# would apply to a resource this script never looks at again.
echo "  applying ${MANIFEST} (image ${DEV_ENV_IMAGE}, as ${NS}/${ENV_NAME})"
sed -e "s#__DEV_ENV_IMAGE__#${DEV_ENV_IMAGE}#" \
    -e "s#__DEV_ENV_NAME__#${ENV_NAME}#" \
    -e "s#__DEV_ENV_NAMESPACE__#${NS}#" "${MANIFEST}" | kubectl_e2e apply -f - >/dev/null

# Poll rather than `kubectl wait`: a spec that never comes up is the interesting
# case, and its diagnostics are worth more than a timeout message.
#
# All three of phase, Ready and RouteReady, because they answer different
# questions and only the last one says the environment is reachable. Ready is
# derived from the pod alone (setPhaseAndReady) — an environment whose Gateway
# never accepted its routes is Ready=True. RouteReady is what the controller
# gates status.endpoints on, so waiting for it is what makes an empty endpoints
# list a failure rather than a race.
#
# The budget is dominated by the pod's own image pull, which helm-e2e-images
# leaves to the registry on purpose — it loads the busybox init container's image
# and not this one. 572 MB measured at ~1 MB/s on a CI runner is ~11m, which a
# 10m budget spent before the container had started, so a healthy environment
# failed on a slow day while every assertion below it would have passed. Past the
# pull it covers scheduling, volume binding and startup; the operator's own share
# is seconds, so a longer budget does not hide a controller that fails to
# converge, it only delays the dump. The loop and the message both read this
# number, so they cannot come to disagree about how long the wait was.
UP_TIMEOUT_MINUTES=15
UP_POLL_SECONDS=6
echo -n "  waiting for phase Running, Ready and RouteReady"
up=0
for _ in $(seq 1 $((UP_TIMEOUT_MINUTES * 60 / UP_POLL_SECONDS))); do
  phase="$(devenv -o jsonpath='{.status.phase.name}' 2>/dev/null || true)"
  ready="$(devenv -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  route="$(devenv -o jsonpath='{.status.conditions[?(@.type=="RouteReady")].status}' 2>/dev/null || true)"
  if [ "${phase}" = "Running" ] && [ "${ready}" = "True" ] && [ "${route}" = "True" ]; then
    up=1
    break
  fi
  echo -n "."
  sleep "${UP_POLL_SECONDS}"
done
echo
if [ "${up}" = 1 ]; then
  ok "environment reached Running with Ready=True and RouteReady=True"
else
  bad "environment did not come up within ${UP_TIMEOUT_MINUTES}m (phase '${phase:-?}', Ready '${ready:-?}', RouteReady '${route:-?}')"
  dump
fi

devenv -o jsonpath='  conditions: {range .status.conditions[*]}{.type}={.status} {end}{"\n"}' || true

# --- the addresses the operator published ---
# Read from status rather than constructed: the point is that what the platform
# tells a user to connect to is what answers.
endpoints="$(devenv -o jsonpath='{range .status.endpoints[*]}{.name}={.address}{" "}{.listenerPort}{"\n"}{end}')"
echo "  endpoints (name=address listenerPort):"
printf '%s\n' "${endpoints}" | sed 's/^/    /'
jupyter_url="$(printf '%s\n' "${endpoints}" | sed -n 's/^jupyter=\([^ ]*\).*/\1/p')"
jupyter_lp="$(printf '%s\n' "${endpoints}" | sed -n 's/^jupyter=[^ ]* //p')"
ssh_url="$(printf '%s\n' "${endpoints}" | sed -n 's/^ssh=\([^ ]*\).*/\1/p')"
ssh_lp="$(printf '%s\n' "${endpoints}" | sed -n 's/^ssh=[^ ]* //p')"
[ -n "${jupyter_url}" ] || bad "status.endpoints has no 'jupyter' entry"
[ -n "${ssh_url}" ] || bad "status.endpoints has no 'ssh' entry"

# If either is missing there is nothing to assert against, and every check below
# would report a second, misleading failure for the same cause.
if [ -z "${jupyter_url}" ] || [ -z "${ssh_url}" ]; then
  dump
  echo
  echo "devenv summary: ${pass} passed, ${fail} failed"
  exit 1
fi

# The address carries the port the endpoint is reachable on; listenerPort is the
# one the controller allocated. They agree exactly when the dataplane does not
# renumber — a LoadBalancer, which is why the e2e configures one. Under a
# NodePort dataplane this is the assertion that would fail, and it should: the
# address would then have to name the nodePort instead.
for pair in "jupyter:${jupyter_url}:${jupyter_lp}" "ssh:${ssh_url}:${ssh_lp}"; do
  name="${pair%%:*}"
  rest="${pair#*:}"
  url="${rest%:*}"
  lp="${rest##*:}"
  addr_port="$(url_port "${url}")"
  if [ "${addr_port}" = "${lp}" ]; then
    ok "${name} address port ${addr_port} matches its listenerPort (identity mapping)"
  else
    bad "${name} address port ${addr_port} != listenerPort ${lp} — a dataplane is renumbering the listener"
  fi
done

# --- Jupyter over the Gateway ---
token="$(kubectl_e2e get secret "$(devenv -o jsonpath='{.status.jupyterTokenSecret.name}')" -n "${NS}" \
  -o go-template='{{.data.token | base64decode}}')"
[ -n "${token}" ] || bad "the Jupyter token Secret recorded in status holds no token"

# The origin the Gateway is reached at, with the environment's own path prefix
# stripped back off — used below to ask for a path the environment does not own.
origin="${jupyter_url%%/dev/*}"

code="$(http_code_until "${jupyter_url}api/status?token=${token}" 200)"
if [ "${code}" = 200 ]; then
  ok "jupyter /api/status with the platform token -> 200"
else
  bad "jupyter /api/status with the platform token expected 200, got ${code}"
fi

code="$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' "${jupyter_url}api/status" || true)"
case "${code}" in
  401 | 403) ok "jupyter rejects the request without a token (HTTP ${code})" ;;
  *) bad "no-token request expected 401/403, got ${code}" ;;
esac

# The environment's web route is path-scoped to /dev/<ns>/<env>/, so a path
# outside it is not routed to the environment at all.
code="$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' "${origin}/api/status?token=${token}" || true)"
if [ "${code}" = 404 ]; then
  ok "a path outside the environment's prefix is not served (404 at the Gateway)"
else
  bad "expected 404 outside /dev/${NS}/${ENV_NAME}/, got ${code}"
fi

html=""
for _ in $(seq 1 10); do
  html="$(curl -fsSL --max-time 30 "${jupyter_url}?token=${token}" 2>/dev/null || true)"
  case "${html}" in *jupyter-config-data*) break ;; esac
  sleep 3
done
check_contains "${html}" "jupyter-config-data" "lab HTML served through the Gateway"

# --- SSH over the Gateway ---
# The endpoint address carries the port the Service publishes, which is the whole
# reason the address is read from status rather than assembled.
ssh_user="${ssh_url#ssh://}"
ssh_user="${ssh_user%%@*}"
ssh_hostport="${ssh_url##*@}"
ssh_host="${ssh_hostport%%:*}"
ssh_port="${ssh_hostport##*:}"

key_secret="$(devenv -o jsonpath='{.status.sshClientKeySecret.name}' 2>/dev/null || true)"
if [ -n "${key_secret}" ]; then
  kubectl_e2e get secret "${key_secret}" -n "${NS}" \
    -o go-template='{{.data.id_ed25519 | base64decode}}' >"${tmp}/id_ed25519"
  chmod 600 "${tmp}/id_ed25519"
  out=""
  for _ in $(seq 1 10); do
    out="$(ssh -i "${tmp}/id_ed25519" -p "${ssh_port}" \
      -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o IdentitiesOnly=yes -o ConnectTimeout=15 \
      "${ssh_user}@${ssh_host}" \
      'printf "uid=%s home=%s pwd=%s\n" "$(id -u)" "$HOME" "$PWD"' 2>&1 || true)"
    case "${out}" in *uid=1000*) break ;; esac
    sleep 5
  done
  check_contains "${out}" "uid=1000" "ssh key-auth login over the Gateway as uid 1000"
  check_contains "${out}" "home=/home/jovyan" "ssh login HOME=/home/jovyan"
else
  bad "status.sshClientKeySecret is empty — no login key to authenticate with"
fi

if [ "${fail}" -gt 0 ]; then
  dump
fi

echo
echo "devenv summary: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
