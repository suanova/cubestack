#!/usr/bin/env bash
# Local Docker smoke for the Cubestack DevEnvironment base images.
#
# No cluster required: runs throwaway containers on 127.0.0.1 with ephemeral
# ports and fake ssh Secrets, then asserts the operator contract. There is one
# image per accelerator family, and each serves BOTH modes — CUBSTACK_TYPE, which
# the controller injects from spec.type, decides what the container is:
#
#   cpu-pytorch      the CPU family, built on plain ubuntu:22.04 with python3, the CPU
#                 build of torch and JupyterLab; account 'ubuntu' uid/gid 1000,
#                 home /home/ubuntu
#   maca-pytorch     the Metax MACA family, the same platform layer on the vendor base,
#                 whose default python3 (and torch) must be the vendor's own
#   cuda-pytorch     the NVIDIA NGC PyTorch family, the same layer on NVIDIA's base,
#                 whose account python3 imports the vendor torch
#
# Each family is run five ways, because the mode is no longer something the image
# bakes:
#
#   jupyter + ssh   CUBSTACK_TYPE=jupyter with the ssh Secret mounted: JupyterLab
#                   behind JUPYTER_TOKEN + NOTEBOOK_ARGS base_url on 8888, and sshd
#                   on 2222 in the same container
#   jupyter only    the same run with no ssh Secret: JupyterLab serves and nothing
#                   listens on 2222 — sshd starts only when the host key is there
#   ssh only        CUBSTACK_TYPE=ssh: sshd alone on 2222, nothing listening on 8888
#                   and no notebook process
#   jupyter as root uid 0 (spec.runtime.securityContext.runAsUser 0) with
#                   NOTEBOOK_ARGS=--allow-root: the login works, and jupyter serves
#                   the home the platform derives (/root) or one the spec declares
#   ssh as root     the same uid 0 with CUBSTACK_TYPE=ssh: sshd alone as root, the
#                   one case where an AllowUsers root entry exists
#
# ssh mode with no host key must fail rather than come up in another mode, and every
# family asserts that too. The non-root runs additionally assert that root support is
# not a widening: the entrypoint admits root only when sshd is root, so a uid-1000
# sshd refuses a root login at authentication.
#
# Every ssh run has its session environment compared against the image's own, which is
# what keeps the shared sshd drop-in's build-time substitution honest (see
# check_session_env below).
#
# Every family also asserts the elevation contract (check_sudo): the image ships sudo,
# sudo grants nothing by itself, and the rule the controller writes for spec.runtime.sudo
# elevates the account.
#
# sshd listens on the unprivileged :2222 (so no NET_BIND_SERVICE is needed); the
# platform's Service publishes it as 22. The smoke talks to 2222 directly.
#
# The operator mounts the host key with subPath and the authorized keys as a
# whole-Secret directory whose items rename the selected entry to authorized_keys.
# Docker has no subPath, so the smoke uses bind mounts and reproduces both shapes:
#   ssh_host_ed25519_key -> /etc/ssh/ssh_host_ed25519_key  (per-file)
#   keys/                -> /run/ssh                       (whole directory holding
#                                                          authorized_keys)
# /run/ssh is absolute: outside $HOME, which a workspace claim may cover and make
# unwritable.
#
# Reads IMG_CPU_PYTORCH / IMG_MACA / IMG_CUDA from the environment (the Makefile sets them).
# Usage: hack/smoke.sh [--cpu-pytorch|--maca-pytorch|--cuda-pytorch]   (default: all)
set -euo pipefail

# Resolved before the cd: --help prints this file, and $0 is relative to wherever the
# caller stood, not to the workspace root the rest of the script runs from.
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$self")/.." # images/ workspace root

# Fallback tags mirror the Makefile default: TAG is the short commit SHA, and every image
# prefixes it with the axes its published tag carries (CPU_TAG / MACA_TAG / CUDA_TAG in the
# Makefile — keep them in step). Only a direct call reaches these: the Makefile passes
# every ref it built with.
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
IMG_CPU_PYTORCH="${IMG_CPU_PYTORCH:-harbor.isuanova.com/suanova/cpu-pytorch:py310-torch2.4-$TAG}"
IMG_MACA="${IMG_MACA:-harbor.isuanova.com/suanova/maca-pytorch:3.9.0.12-py310-torch2.4-$TAG}"
# One axis, not three: the NGC release pins python, torch and CUDA together, so CUDA_TAG is that
# release and nothing else.
IMG_CUDA="${IMG_CUDA:-harbor.isuanova.com/suanova/cuda-pytorch:26.08-$TAG}"
CONTAINER_TOOL="${CONTAINER_TOOL:-docker}"

run_cpu_pytorch=1
run_maca_pytorch=1
run_cuda_pytorch=1
case "${1:-}" in
  --cpu-pytorch) run_maca_pytorch=0; run_cuda_pytorch=0 ;;
  --maca-pytorch) run_cpu_pytorch=0; run_cuda_pytorch=0 ;;
  --cuda-pytorch) run_cpu_pytorch=0; run_maca_pytorch=0 ;;
  -h | --help) awk 'NR > 1 && /^set -euo pipefail$/ { exit } NR > 1' "$self"; exit 0 ;;
  "") ;;
  *) echo "cubestack smoke: unknown option '$1'" >&2; exit 1 ;;
esac

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cubestack-smoke.XXXXXX")"
# Every container an assertion starts, so the EXIT trap owns them all however the run
# ends. Entries removed early stay in the list; `rm -f` is idempotent.
live_containers=()
home_seq=0
cleanup() {
  local code=$? c
  for c in ${live_containers[@]+"${live_containers[@]}"}; do
    [ -n "$c" ] && "$CONTAINER_TOOL" rm -f "$c" >/dev/null 2>&1 || true
  done
  rm -rf "$tmp"
  exit $code
}
trap cleanup EXIT

pass=0
fail=0
ok()  { echo "  PASS  $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }

# check_contains <haystack> <needle> <label>
check_contains() {
  case "$1" in
    *"$2"*) ok "$3" ;;
    *) bad "$3 (missing: $2)" ;;
  esac
}

# start <name> <run args...> — run detached and remember the container for the EXIT trap.
start() {
  local name=$1
  shift
  "$CONTAINER_TOOL" run -d --name "$name" "$@" >/dev/null
  live_containers+=("$name")
}

# port_of <container> <container-port> — the host port the engine published. It fails on a
# container that is not running; `|| true` keeps that from aborting the run before the
# assertions below can report it (pipefail is on).
port_of() {
  "$CONTAINER_TOOL" port "$1" "$2" 2>/dev/null | head -n1 | sed 's/^.*://' || true
}

# port_listening <container> <port> — whether a socket inside the container listens on that
# TCP port. Read from /proc/net/tcp{,6} because the ubuntu base ships neither ss nor netstat,
# and the property has to be checkable on every family. A listening socket is state 0A.
port_listening() {
  local name=$1 hex
  hex="$(printf '%04X' "$2")"
  "$CONTAINER_TOOL" exec "$name" sh -c \
    "grep -qiE ':$hex +[0-9A-F]+:0{8} +0A' /proc/net/tcp /proc/net/tcp6" >/dev/null 2>&1
}

# notebook_running <container> — the /proc entries of processes whose command line names
# jupyter, or empty. Asked of /proc because ps is not guaranteed either.
notebook_running() {
  # A "notebook" is a process that *runs* JupyterLab, not one whose argv merely names it:
  # tini's argv carries the image CMD (/usr/local/bin/start-jupyter.sh), and this probe's own
  # argv carries this script, so a bare match on "jupyter" reports both. The bracket keeps
  # the pattern itself from matching the probe's cmdline, and the numeric glob drops
  # /proc/self and /proc/thread-self.
  "$CONTAINER_TOOL" exec "$1" sh -c '
    for d in /proc/[0-9]*; do
      pid=${d#/proc/}
      [ "$pid" = "$$" ] && continue
      [ "$pid" = "$PPID" ] && continue
      cmd=$(tr "\0" " " < "$d/cmdline" 2>/dev/null) || continue
      case "$cmd" in
        *jupyter[-]lab* | *jupyter[-]notebook* | *jupyter[-]server*) echo "$pid: $cmd" ;;
      esac
    done' 2>/dev/null || true
}

# ssh_login <port> <client key> <user> — a non-interactive session that reports the identity
# and the environment, one variable per line with an envv: prefix (the form
# check_session_env reads).
ssh_login() {
  ssh -i "$2" \
    -p "$1" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    "$3@127.0.0.1" \
    'printf "uid=%s gid=%s home=%s pwd=%s\n" "$(id -u)" "$(id -gn)" "$HOME" "$PWD"; env | sed "s/^/envv:/"' \
    2>&1 || true
}

# dump_failure <container> — the two things a failed login is usually about.
dump_failure() {
  local cont=$1
  echo "  container logs:"
  "$CONTAINER_TOOL" logs "$cont" 2>&1 | tail -n 20
  echo "  mounted files as the container sees them:"
  "$CONTAINER_TOOL" exec --user 0 "$cont" ls -ln \
    /etc/ssh/ssh_host_ed25519_key /run/ssh/authorized_keys 2>&1 || true
}

# check_identity <ssh-output> <label> — the account every family image ships: uid 1000,
# primary group 'ubuntu', home /home/ubuntu, and a login that starts there.
check_identity() {
  check_contains "$1" "uid=1000" "$2: ssh key-auth login as uid 1000"
  check_contains "$1" "gid=ubuntu" "$2: ssh login primary group 'ubuntu'"
  check_contains "$1" "home=/home/ubuntu" "$2: ssh login HOME=/home/ubuntu"
  check_contains "$1" "pwd=/home/ubuntu" "$2: ssh login cwd=/home/ubuntu"
}

# make_secret <parent> — generate a throwaway host keypair + authorized_keys that
# emulates an operator Secret.
#
# authorized_keys is world-readable because nothing checks it: the images set
# `StrictModes no` (the workspace PVC may not carry the modes sshd demands), so it
# only has to be readable by the container uid. The host key is the one file whose
# mode matters, and ensure_mount_readable below settles it against the engine. The
# client key stays 0600 — the ssh binary reading it runs as the invoking user, the
# case OpenSSH's private-key check is for.
make_secret() {
  local base=$1
  mkdir -p "$base/client" "$base/host" "$base/keys"
  ssh-keygen -q -t ed25519 -N "" -f "$base/client/id_ed25519"
  ssh-keygen -q -t ed25519 -N "" -f "$base/host/ssh_host_ed25519_key"
  # Only the public half is materialised, one entry renamed to authorized_keys —
  # the operator's items mapping, by which the login private key stays out.
  cp "$base/client/id_ed25519.pub" "$base/keys/authorized_keys"
  chmod 644 "$base/keys/authorized_keys"
  chmod 700 "$base/client"
  chmod 600 "$base/client/id_ed25519"
}

# container_can_read <image> <host file> — whether uid 1000 can read the file as the
# container sees it. Mounts the file alone, at the path sshd reads it from, so it is
# the mount sshd will get.
container_can_read() {
  "$CONTAINER_TOOL" run --rm --user 1000:1000 --entrypoint /usr/bin/test \
    -v "$2:/etc/ssh/ssh_host_ed25519_key:ro" "$1" \
    -r /etc/ssh/ssh_host_ed25519_key >/dev/null 2>&1
}

# ensure_mount_readable <image> <host key> — sshd has to be able to read the mounted
# host key, and the mode that lets it is the engine's choice, not the image's.
# OpenSSH ignores a private key that group or other can read, but only when the uid
# reading it owns the file — and which uid that is depends on the engine:
#   Docker Desktop  presents a bind-mounted *file* as owned by the container's user,
#                   so the check fires and the key has to stay 0600;
#   a rootful Linux daemon keeps the invoking user's uid, so a 0600 key belongs to
#                   nobody the container can read and it has to be 0644 — the check
#                   is then skipped, which is the case the platform relies on, since
#                   it projects the Secret 0644.
# Probing beats branching on the engine: neither behaviour is in a version string.
# ssh-keygen has already written the key 0600, so widen only if that is unreadable.
# Records the outcome rather than returning it, so a failure here reads as the
# mount's and the ssh assertions below still report their own.
ensure_mount_readable() {
  local img=$1 key=$2
  if ! container_can_read "$img" "$key"; then
    chmod 644 "$key"
  fi
  if container_can_read "$img" "$key"; then
    ok "container uid 1000 can read the mounted host key"
    return
  fi
  bad "container uid 1000 cannot read $key"
  echo "        the bind mount did not arrive readable by the container uid; check the"
  echo "        mount and the key's mode (0600 where the container owns it, else 0644)."
}

# served_key <port> — the ed25519 host key sshd serves, or empty if it is not
# serving yet. A bare TCP connect is not sufficient: docker's port proxy accepts
# the connection even when nothing listens inside the container. `|| true`: no
# answer means an empty result, not a failure to propagate (pipefail is on, and
# the callers decide what an empty key means).
served_key() {
  ssh-keyscan -t ed25519 -p "$1" 127.0.0.1 2>/dev/null | awk '!/^#/ && NF {print $NF; exit}' || true
}

# wait_ssh <port> <seconds> <container-name>
wait_ssh() {
  local port=$1 secs=$2 name=$3
  for _ in $(seq 1 "$secs"); do
    if [ -n "$(served_key "$port")" ]; then return 0; fi
    sleep 1
  done
  echo "  container $name did not serve an ssh host key on port $port within ${secs}s; last logs:"
  "$CONTAINER_TOOL" logs "$name" 2>&1 | tail -n 20
  return 1
}

# wait_jupyter <container> <port> <base-url> <seconds> <label> — Jupyter answering behind
# the token, at the base_url the controller passes through NOTEBOOK_ARGS (empty for the
# root path).
wait_jupyter() {
  local cont=$1 port=$2 base=$3 secs=$4 label=$5
  printf "  waiting for %s JupyterLab" "$label"
  for _ in $(seq 1 "$secs"); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port$base/api/status?token=testtoken" 2>/dev/null; then
      echo
      ok "$label jupyter /api/status with token -> 200"
      return 0
    fi
    printf "."
    sleep 1
  done
  echo
  bad "$label jupyter did not become reachable within ${secs}s"
  "$CONTAINER_TOOL" logs "$cont" 2>&1 | tail -n 30
  return 0
}

# check_jupyter_http <port> <base-url> <label> — the token and prefix contract.
check_jupyter_http() {
  local port=$1 base=$2 label=$3 code html
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$base/api/status")"
  case "$code" in
    401 | 403) ok "$label no token rejected (HTTP $code)" ;;
    *) bad "$label no-token request expected 401/403, got $code" ;;
  esac

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/status?token=testtoken")"
  if [ "$code" = 404 ]; then
    ok "$label base_url prefix enforced (root path -> 404)"
  else
    bad "$label root path without base_url expected 404, got $code"
  fi

  html="$(curl -fsSL "http://127.0.0.1:$port$base/?token=testtoken" 2>/dev/null || true)"
  check_contains "$html" "jupyter-config-data" "$label lab HTML served on base_url path"
}

# check_served_host_key <port> <secret-host-pub> <container> <label>
check_served_host_key() {
  local port=$1 pub=$2 name=$3 label=$4 served
  served="$(served_key "$port")"
  if [ -n "$served" ] && [ "$served" = "$(awk '{print $2}' "$pub")" ]; then
    ok "$label"
  else
    bad "$label"
    "$CONTAINER_TOOL" logs "$name" 2>&1 | tail -n 20
  fi
}

# check_jupyter_ssh <container> <port> <secret dir> <label> — the sshd that a jupyter-mode
# container starts when the operator mounted the ssh Secret. One image serves both, so this
# is the half of the merge that has to keep working next to a live notebook.
check_jupyter_ssh() {
  local cont=$1 port=$2 base=$3 label=$4 out
  wait_ssh "$port" 30 "$cont" ||
    bad "$label: sshd served no host key on port $port within 30s"

  out="$(ssh_login "$port" "$base/client/id_ed25519" ubuntu)"
  check_identity "$out" "$label"
  check_session_env "$cont" "$out" "$label"
  check_served_host_key "$port" "$base/host/ssh_host_ed25519_key.pub" \
    "$cont" "$label: served host key == mounted Secret public key"
  check_no_root_login "$port" "$base/client/id_ed25519" "$cont" \
    "$label: a non-root sshd refuses a root login"

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    dump_failure "$cont"
  fi
}

# check_ssh_mode <image> <container> <secret dir> <label> — the ssh arm of the contract:
# CUBSTACK_TYPE=ssh makes the entrypoint exec sshd and never reach the image CMD. Beyond the
# login itself this asserts the two absences that make the mode real, because the same image
# *can* run a notebook: nothing listens on 8888, and no notebook process is running.
#
# The container is left running for the family's own assertions (the vendor stack still has
# to be reachable from an ssh-type environment); the caller removes it.
check_ssh_mode() {
  local img=$1 cont=$2 base=$3 label=$4 port out nb
  make_secret "$base"
  ensure_mount_readable "$img" "$base/host/ssh_host_ed25519_key"

  start "$cont" \
    --user 1000:1000 \
    -p 127.0.0.1::2222 \
    -e CUBSTACK_TYPE=ssh \
    -v "$base/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$base/keys:/run/ssh:ro" \
    "$img"
  port="$(port_of "$cont" 2222)"

  wait_ssh "$port" 30 "$cont" ||
    bad "$label: sshd served no host key on port $port within 30s"

  out="$(ssh_login "$port" "$base/client/id_ed25519" ubuntu)"
  check_identity "$out" "$label"
  check_session_env "$cont" "$out" "$label"
  check_served_host_key "$port" "$base/host/ssh_host_ed25519_key.pub" \
    "$cont" "$label: served host key == mounted Secret public key"
  check_no_root_login "$port" "$base/client/id_ed25519" "$cont" \
    "$label: a non-root sshd refuses a root login"

  if port_listening "$cont" 8888; then
    bad "$label: something listens on 8888 in an ssh-type container"
  else
    ok "$label nothing listens on 8888"
  fi

  # The positive probe keeps the absence below from going vacuous: a container whose
  # process table cannot be read would otherwise report no notebook for the same reason a
  # working one reports none.
  if ! "$CONTAINER_TOOL" exec "$cont" sh -c 'cat /proc/1/cmdline' >/dev/null 2>&1; then
    bad "$label could not read the container's process table, so the no-notebook check proves nothing"
  else
    nb="$(notebook_running "$cont")"
    case "$nb" in
      "") ok "$label no notebook server running" ;;
      *) bad "$label a notebook process is running ($nb)" ;;
    esac
  fi

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    dump_failure "$cont"
  fi
}

# check_jupyter_only <image> <container> <label> — jupyter mode with NO ssh Secret. The
# entrypoint starts sshd only when the host key is mounted, so the notebook has to be
# reachable on its own and nothing may listen on 2222. Removes its container.
check_jupyter_only() {
  local img=$1 cont=$2 label=$3 port code
  start "$cont" \
    --user 1000:1000 \
    -p 127.0.0.1::8888 \
    -e JUPYTER_TOKEN=testtoken \
    "$img"
  port="$(port_of "$cont" 8888)"

  wait_jupyter "$cont" "$port" "" 120 "$label"

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/status")"
  case "$code" in
    401 | 403) ok "$label no token rejected (HTTP $code)" ;;
    *) bad "$label no-token request expected 401/403, got $code" ;;
  esac

  if port_listening "$cont" 2222; then
    bad "$label: sshd started without a mounted host key"
  else
    ok "$label nothing listens on 2222 without an ssh Secret"
  fi

  "$CONTAINER_TOOL" rm -f "$cont" >/dev/null 2>&1 || true
}

# check_ssh_requires_key <image> <label> — ssh mode is a promise that sshd serves *this*
# Secret; with no host key the entrypoint must refuse to start rather than come up in some
# other mode. A container that exits 0 here would be one the controller marks ready with no
# ssh endpoint.
check_ssh_requires_key() {
  local img=$1 label=$2 cont running code out
  cont="cs-smoke-nokey-$$"
  "$CONTAINER_TOOL" run -d --name "$cont" \
    --user 1000:1000 \
    -e CUBSTACK_TYPE=ssh \
    "$img" >/dev/null
  live_containers+=("$cont")

  for _ in $(seq 1 30); do
    running="$("$CONTAINER_TOOL" inspect -f '{{.State.Running}}' "$cont" 2>/dev/null || true)"
    [ "$running" = false ] && break
    sleep 1
  done
  code="$("$CONTAINER_TOOL" inspect -f '{{.State.ExitCode}}' "$cont" 2>/dev/null || true)"
  out="$("$CONTAINER_TOOL" logs "$cont" 2>&1 || true)"

  # `running` is checked where it says what the exit code means: a container still up after
  # the wait has no exit to report, and State.ExitCode would read 0.
  if [ "$running" = false ] && [ -n "$code" ] && [ "$code" != 0 ]; then
    ok "$label: ssh mode without a host key exits non-zero ($code)"
  else
    bad "$label: ssh mode without a host key should exit non-zero (got '$code')"
    "$CONTAINER_TOOL" logs "$cont" 2>&1 | tail -n 20
  fi
  check_contains "$out" "no host key" "$label: the failure names the missing host key"

  "$CONTAINER_TOOL" rm -f "$cont" >/dev/null 2>&1 || true
}

# check_root_ssh <image> <secret dir> <container name> <label> [extra run args...]
#
# The root half of the contract: an environment runs its image as root when the spec asks
# for it (spec.runtime.securityContext.runAsUser 0), and ssh has to work there too. Two
# things are different from the non-root runs, and both are invisible from them:
#
#   - the host key is mounted 0600. The reader and the owner are the same uid here,
#     so OpenSSH's private-key check fires and a wider mode is refused outright
#     ("Permissions 0644 ... are too open") — the mode the non-root path *needs* is
#     the mode the root path must not have.
#   - sshd runs as root, so it wants its privilege separation directory (which the
#     image ships) and admits root at all - the entrypoint adds that AllowUsers
#     entry from the uid sshd runs as, so it is here and nowhere else.
#
# The login account is the container's, not the image's: root is served whatever
# account the image was built around. Extra args are what the mode needs to *stay up*
# as root — jupyter-server refuses to run as root without --allow-root, which the
# controller injects for a root DevEnvironment (::withRootLauncherEnv) and a bare
# container has to be given by hand — or CUBSTACK_TYPE=ssh for the ssh arm.
check_root_ssh() {
  local img=$1 base=$2 cont=$3 label=$4 port out
  shift 4
  make_secret "$base"
  # ssh-keygen already wrote the host key 0600, which is what root mode needs. No
  # probing here, unlike the non-root runs: the container owns the key by
  # construction, so the mode the owner tolerates is a fixed answer.
  "$CONTAINER_TOOL" run -d --name "$cont" \
    --user 0:0 \
    -p 127.0.0.1::2222 \
    -v "$base/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$base/keys:/run/ssh:ro" \
    "$@" \
    "$img" >/dev/null
  live_containers+=("$cont")
  port="$(port_of "$cont" 2222)"
  wait_ssh "$port" 30 "$cont" ||
    bad "$label: sshd served no host key on port $port within 30s"

  out="$(ssh -i "$base/client/id_ed25519" \
    -p "$port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    root@127.0.0.1 \
    'printf "uid=%s user=%s\n" "$(id -u)" "$(id -un)"' \
    2>&1 || true)"
  check_contains "$out" "uid=0" "$label: ssh key-auth login as root (uid 0)"

  check_served_host_key "$port" "$base/host/ssh_host_ed25519_key.pub" \
    "$cont" "$label: served host key == mounted Secret public key"

  if ! case "$out" in *"uid=0"*) true ;; *) false ;; esac; then
    echo "  container logs:"
    "$CONTAINER_TOOL" logs "$cont" 2>&1 | tail -n 20
    echo "  the privilege separation directory a root sshd requires:"
    "$CONTAINER_TOOL" exec "$cont" ls -ld /run/sshd 2>&1 || true
  fi
  "$CONTAINER_TOOL" rm -f "$cont" >/dev/null 2>&1 || true
}

# The family account is admitted *beside* root, and a non-root sshd must not admit
# root at all: it cannot setuid to it, so the login would be accepted and then die
# at setresuid. The assertion is therefore about *where* the refusal happens -
# "Permission denied" is authentication, and the marker below only appears if a
# session was built. Asserting the text is what makes the check load-bearing:
# `AllowUsers root` baked back into the drop-in restores the accepted-then-failed
# login, which a session-shaped assertion cannot tell from a refusal. Guarded
# against the vacuous pass because it is what keeps admitting root from being a
# widening of the non-root path.
# check_no_root_login <port> <client key> <container> <label>
check_no_root_login() {
  local port=$1 key=$2 cont=$3 label=$4 out
  # Without this the check passes vacuously: a server that never answered also
  # cannot produce the marker.
  if [ -z "$(served_key "$port")" ]; then
    bad "$label — sshd was not answering, so the check proves nothing"
    return
  fi
  out="$(ssh -i "$key" \
    -p "$port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    root@127.0.0.1 'echo SHOULD-NOT-HAPPEN' 2>&1 || true)"
  check_contains "$out" "Permission denied" "$label"
}

# check_session_env <container> <ssh-output> <label> — every variable the image's own sshd
# drop-in declares must reach an ssh session carrying the image's own value. sshd's SetEnv
# replaces a session's environment rather than adding to it, so the drop-in is the whole of
# what a session inherits; and it is a template, filled per image at build time. Comparing
# the two sides catches both halves at once: a placeholder that never got substituted IS the
# value, and a declared variable that sshd dropped — it keeps only the first SetEnv line and
# ignores the rest, without complaint — is simply absent from the session.
#
# The names come from the image, not from a list here: an image that starts carrying another
# variable is covered without this script changing, and one that declares none is a failure
# rather than a vacuous pass.
#
# The session side is read from the output of the login assertions rather than a second ssh
# call, and the non-interactive form is deliberately the one probed: it runs no profile, so
# what it reports is SetEnv alone, with no shell startup file able to paper over a wrong
# value. `docker exec` inherits the container's config environment, so its env is the image's.
check_session_env() {
  local name=$1 out=$2 label=$3 decl cenv pair var sess cont lost=0
  decl="$("$CONTAINER_TOOL" exec "$name" sh -c \
    'sed -n "s/^SetEnv //p" /etc/ssh/sshd_config.d/10-devenv.conf' 2>/dev/null || true)"
  cenv="$("$CONTAINER_TOOL" exec "$name" sh -c 'env' 2>/dev/null || true)"

  if [ -z "$decl" ]; then
    bad "$label the image's sshd drop-in declares no session environment"
    return 0
  fi

  for pair in $decl; do
    var="${pair%%=*}"
    sess="$(printf '%s\n' "$out" | sed -n "s/^envv:$var=//p")"
    cont="$(printf '%s\n' "$cenv" | sed -n "s/^$var=//p")"
    if [ -z "$sess" ] || [ "$sess" != "$cont" ]; then
      lost=1
      bad "$label ssh session $var differs from the image's"
      echo "        session: ${sess:-<absent>}"
      echo "        image:   ${cont:-<unset>}"
    fi
  done
  if [ "$lost" = 0 ]; then
    ok "$label ssh session environment == the image's own"
  fi
}

# check_maca_readable <container> <label> — the vendor stack is what these images exist for,
# and the base was built as root: a library under /opt/maca that uid 1000 cannot read fails
# at runtime, on a GPU node, with no build-time signal. Readable-by-the-account is checkable
# here without a GPU, so it is checked.
#
# Two traps this walks around. /opt/maca is a SYMLINK to /opt/maca-<version>, and find does
# not descend a symlinked start point — hence the trailing slash, without which both checks
# below find an empty tree, the first failing while the second passes vacuously. And `find
# -readable` is GNU's; the base is Ubuntu. Ran without --user: `docker exec` then uses the
# image's own USER, which is the account in question. The two are asserted apart so that an
# unreadable /opt/maca — which would make the find itself report nothing — cannot pass as a
# clean tree.
check_maca_readable() {
  local name=$1 label=$2 nlibs unreadable
  nlibs="$("$CONTAINER_TOOL" exec "$name" sh -c 'find /opt/maca/ -name "*.so*" 2>/dev/null | wc -l' 2>/dev/null || echo 0)"
  if [ "${nlibs:-0}" -gt 0 ]; then
    ok "$label vendor MACA stack visible to uid 1000 ($nlibs shared objects under /opt/maca)"
  else
    bad "$label no shared objects under /opt/maca/ as uid 1000: missing, or not traversable by the account"
  fi
  unreadable="$("$CONTAINER_TOOL" exec "$name" sh -c 'find /opt/maca/ -name "*.so*" ! -readable 2>/dev/null | head -n 3' 2>/dev/null || true)"
  if [ -z "$unreadable" ] && [ "${nlibs:-0}" -gt 0 ]; then
    ok "$label every MACA shared object readable by uid 1000"
  else
    bad "$label MACA shared objects not readable by uid 1000: ${unreadable:-none listed}"
  fi
}

# check_vendor_python <container> <label> [tool]... — the vendor's python is what these images exist
# for, for the reason check_maca_readable gives and with the same evidence available: the torch they
# are built around is importable only by the interpreter the base ships under /opt/conda, and the base
# publishes that directory nowhere on PATH. Putting it on PATH is the image's job, so what is asserted
# is that the image's *default* python3 is that interpreter — not that a right one exists somewhere,
# which is what a login shell would show and is exactly how a wrong default shipped.
#
# `docker exec` runs with the image's own config environment, which is also the environment sshd's
# SetEnv copies into every session, so this is the same value a non-login ssh command gets.
# Ran without --user: the image's own USER is the account in question.
#
# Further names are tools that must resolve onto that same interpreter's bin directory. Which
# interpreter the launcher came from is a separate fact from PATH — an install that ran before the
# PATH was corrected leaves the launcher on the system python while the two checks above still pass.
check_vendor_python() {
  local name=$1 label=$2
  shift 2
  local exe ver tool path
  exe="$("$CONTAINER_TOOL" exec "$name" sh -c 'command -v python3' 2>/dev/null || true)"
  case "$exe" in
    /opt/conda/*) ok "$label default python3 is the vendor's ($exe)" ;;
    *) bad "$label default python3 is '${exe:-<absent>}', not the vendor interpreter under /opt/conda" ;;
  esac

  if ver="$("$CONTAINER_TOOL" exec "$name" sh -c 'python3 -c "import torch; print(torch.__version__)"' 2>&1)"; then
    ok "$label default python3 imports the vendor torch ($ver)"
  else
    bad "$label 'python3 -c import torch' failed: $(printf '%s' "$ver" | tail -n 1)"
  fi

  for tool in "$@"; do
    path="$("$CONTAINER_TOOL" exec "$name" sh -c "command -v $tool" 2>/dev/null || true)"
    case "$path" in
      /opt/conda/bin/*) ok "$label $tool is the vendor interpreter's ($path)" ;;
      *) bad "$label $tool is '${path:-<absent>}', not /opt/conda/bin/$tool" ;;
    esac
  done
}

# check_torch <container> <label> — that the account's python3 imports torch, which is the fact
# every family image exists for. The shapes differ and the assertion does not: on the NVIDIA base
# torch comes with the base and installs into the distribution's own python; on the CPU image this
# repository's Dockerfile pip-installs the CPU build; on MACA the vendor tree is dropped under /opt
# and reached through the conda interpreter (check_maca_readable, check_vendor_python).
#
# The interpreter is the point. The account's python3 is what an ssh session and a build RUN get —
# so torch importing there is what the image has to deliver. The version is reported, not compared:
# the vendor builds carry their own suffixes (…+4fdf77b against …+4fdf77b940.nv26.08), so an
# equality check would be a false one.
#
# Read without --user, so `docker exec` uses the image's own USER — the account in question, the
# same reasoning as check_maca_readable.
check_torch() {
  local name=$1 label=$2 server version
  server="$("$CONTAINER_TOOL" exec "$name" sh -c 'command -v python3' 2>/dev/null || true)"
  if [ -z "$server" ]; then
    bad "$label no python3 on the account's PATH"
    return 0
  fi
  version="$("$CONTAINER_TOOL" exec "$name" python3 -c 'import torch; print(torch.__version__)' 2>/dev/null || true)"
  if [ -n "$version" ]; then
    ok "$label account's python3 ($server) imports torch ($version)"
  else
    bad "$label python3 at $server cannot import torch"
  fi
}

# check_notebook_kernel <container> <label> — that a *cell* runs on that same interpreter.
#
# The base's kernelspec names a bare `python`, which jupyter_client rewrites to the server's own
# sys.executable, so a notebook session lands on torch only because the server does. That rewrite is
# what this asserts rather than assumes, and it is asked of jupyter_client itself: format_kernel_cmd()
# is pure python — no ZMQ, no kernel start — which is the only reason a kernel question is answerable
# under emulation, where a real cell does not complete. (Learned on the MACA family.)
check_notebook_kernel() {
  local name=$1 label=$2 server kernel
  server="$("$CONTAINER_TOOL" exec "$name" sh -c 'command -v python3' 2>/dev/null || true)"
  kernel="$("$CONTAINER_TOOL" exec "$name" python3 -c \
    'from jupyter_client.manager import KernelManager; print(KernelManager(kernel_name="python3").format_kernel_cmd()[0])' \
    2>/dev/null || true)"
  if [ -n "$kernel" ] && [ "$kernel" = "$server" ]; then
    ok "$label notebook kernels run on that interpreter ($kernel)"
  else
    bad "$label notebook kernel interpreter is '${kernel:-<none resolved>}', expected '${server:-<none>}'"
  fi
}

# check_sudo <image> <label> — the elevation contract, in the three states the platform
# puts an environment through. The image ships sudo and grants nothing: sudo runs only
# for the accounts a sudoers rule names, and the image names none. The controller
# supplies the rule when spec.runtime.sudo asks for it — a numeric uid, which is the
# form that follows the container's identity rather than an account name the image may
# not have — and this writes the same bytes to check that they elevate.
#
# The rule has to be written *inside* the container by root: sudo refuses a drop-in root
# does not own, and a bind-mounted host file belongs to the host user with a host mode.
check_sudo() {
  local img=$1 label=$2 cont out
  # 1. the binary is there for the account.
  out="$("$CONTAINER_TOOL" run --rm --user 1000:1000 --entrypoint /bin/sh "$img" \
    -c 'command -v sudo' 2>/dev/null || true)"
  if [ -n "$out" ]; then
    ok "$label sudo installed ($out)"
  else
    bad "$label sudo is not installed"
  fi

  # 2. and grants nothing until a rule names it. The run is the image without the
  # controller's file, which is exactly what an environment that does not ask for the
  # grant gets.
  if "$CONTAINER_TOOL" run --rm --user 1000:1000 --entrypoint /bin/sh "$img" \
    -c 'sudo -n true' >/dev/null 2>&1; then
    bad "$label sudo granted an account no rule names"
  else
    ok "$label sudo refused before the platform grants it"
  fi

  # 3. with the controller's file in place, the grant is live for uid 1000.
  cont="cs-smoke-sudo-$$"
  start "$cont" --user 0:0 --entrypoint /bin/sh "$img" -c 'sleep 300'
  out="$("$CONTAINER_TOOL" exec "$cont" sh -c '
    umask 077
    printf "#1000 ALL=(ALL) NOPASSWD: ALL\n" > /etc/sudoers.d/20-cubestack
    chmod 0440 /etc/sudoers.d/20-cubestack
    visudo -cf /etc/sudoers.d/20-cubestack' 2>&1 || true)"
  check_contains "$out" "parsed OK" "$label the controller's rule passes visudo"
  out="$("$CONTAINER_TOOL" exec --user 1000:1000 "$cont" sudo -n id -u 2>&1 || true)"
  if [ "$out" = 0 ]; then
    ok "$label sudo elevates the account to root under the controller's rule"
  else
    bad "$label sudo did not elevate under the controller's rule (got '${out:-<nothing>}')"
    "$CONTAINER_TOOL" exec "$cont" visudo -c 2>&1 | tail -n 5 || true
  fi
  "$CONTAINER_TOOL" rm -f "$cont" >/dev/null 2>&1 || true
}

# check_jupyter_home <image> <home> <label> [extra run args...]
#
# The home a jupyter container actually runs with, and the directory its notebook serves — the same
# directory twice, since jupyter writes its runtime files *under $HOME* and serves its working
# directory. Both are the launcher's to decide as much as the image's, and both are baked into the
# one report the server writes at startup, <home>/.local/share/jupyter/runtime/jpserver-<pid>.json:
# its root_dir is what `jupyter server list` prints. A launcher that moves the home but not the
# notebook is the failure this catches, so it is asserted on, and neither read of it is enough alone.
#
# The run reproduces the shape the operator creates — a writable directory where the workspace claim
# goes, which is a tmpfs here so that a container running as root writes nothing on the host:
#
#   - with no HOME in the environment, the image's baked value is still in place — the underived
#     case, where the platform mounts the claim at the home the *identity* implies;
#   - with HOME passed, that is what the claim was mounted at, and the launcher must not override
#     it — a home the spec declared is a statement about where the container will look.
#
# A third place the same home has to be is the directory the server *runs in*, and the report answers
# that too — its "pid" is the server's own. root_dir does not put it there: a terminal is a process
# the server spawns, jupyter_server_terminals spawns it with the cwd the create request carries, and
# JupyterLab's request carries none, so the pty inherits the server's working directory. A launcher
# that names the home but never enters it opens every shell on the image's WORKDIR — /home/ubuntu,
# which for a root environment is the account the image bakes rather than the workspace.
#
# uid 0 throughout, since this is the root branch's check, and no Secret is mounted, so sshd never
# starts and the run is the launcher alone.
check_jupyter_home() {
  local img=$1 home=$2 label=$3 info="" pid="" cwd=""
  shift 3
  home_seq=$((home_seq + 1))
  local cont="cs-smoke-home-$$-$home_seq"
  "$CONTAINER_TOOL" run -d --name "$cont" \
    --user 0:0 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--allow-root" \
    --tmpfs "$home" \
    "$@" \
    "$img" >/dev/null
  live_containers+=("$cont")
  # The report lives inside the runtime directory, so waiting for it waits for both: a server that
  # is still starting has written neither.
  for _ in $(seq 1 120); do
    info="$("$CONTAINER_TOOL" exec "$cont" \
      sh -c "cat $home/.local/share/jupyter/runtime/jpserver-*.json 2>/dev/null" || true)"
    case "$info" in
      *"\"root_dir\": \"$home\""*) break ;;
    esac
    info=""
    sleep 1
  done
  if [ -n "$info" ]; then
    ok "$label"
    # Asked of the pid the report names as its own, so this cannot read a bystander's cwd. Only
    # reported when the report itself was read: a container whose server wrote no report has no pid
    # to ask, and a second failure would only restate the first.
    pid="$(printf '%s\n' "$info" | sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' | head -n 1)"
    cwd="$("$CONTAINER_TOOL" exec "$cont" readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ -n "$pid" ] && [ "$cwd" = "$home" ]; then
      ok "$label, and runs in it (a new terminal starts there)"
    else
      bad "$label, but the server runs in ${cwd:-<unknown>} — a new terminal would open there"
    fi
  else
    bad "$label (jupyter does not report $home as the directory it serves)"
    "$CONTAINER_TOOL" logs "$cont" 2>&1 | tail -n 20
  fi
  "$CONTAINER_TOOL" rm -f "$cont" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# cpu-pytorch (the CPU family: JupyterLab + sshd from one image)
# ---------------------------------------------------------------------------
if [ "$run_cpu_pytorch" = 1 ]; then
  echo "== smoke: $IMG_CPU_PYTORCH (cpu-pytorch) =="
  base="/dev/ns/env"

  # jupyter + sshd, the shape a jupyter-type environment with ssh enabled gets.
  cpu_pytorch_cont="cs-smoke-cpu-pytorch-$$"
  make_secret "$tmp/cpu-pytorch-ssh"
  ensure_mount_readable "$IMG_CPU_PYTORCH" "$tmp/cpu-pytorch-ssh/host/ssh_host_ed25519_key"

  start "$cpu_pytorch_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::8888 \
    -p 127.0.0.1::2222 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--ServerApp.base_url=$base/" \
    -v "$tmp/cpu-pytorch-ssh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/cpu-pytorch-ssh/keys:/run/ssh:ro" \
    "$IMG_CPU_PYTORCH"
  cpu_pytorch_port="$(port_of "$cpu_pytorch_cont" 8888)"
  cpu_pytorch_ssh_port="$(port_of "$cpu_pytorch_cont" 2222)"

  wait_jupyter "$cpu_pytorch_cont" "$cpu_pytorch_port" "$base" 120 "cpu-pytorch"
  check_jupyter_http "$cpu_pytorch_port" "$base" "cpu-pytorch"

  id_out="$("$CONTAINER_TOOL" exec "$cpu_pytorch_cont" sh -c 'printf "%s %s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
  if [ "$id_out" = "1000 1000" ]; then
    ok "cpu-pytorch container runs as uid 1000 gid 1000"
  else
    bad "cpu-pytorch expected '1000 1000', got '$id_out'"
  fi

  check_sudo "$IMG_CPU_PYTORCH" "cpu-pytorch"

  check_torch "$cpu_pytorch_cont" "cpu-pytorch"
  check_notebook_kernel "$cpu_pytorch_cont" "cpu-pytorch"

  check_jupyter_ssh "$cpu_pytorch_cont" "$cpu_pytorch_ssh_port" "$tmp/cpu-pytorch-ssh" "cpu-pytorch"
  "$CONTAINER_TOOL" rm -f "$cpu_pytorch_cont" >/dev/null 2>&1 || true

  # jupyter with no ssh Secret: sshd must not start.
  check_jupyter_only "$IMG_CPU_PYTORCH" "cs-smoke-cpu-pytorch-juponly-$$" "cpu-pytorch jupyter-only"

  # ssh alone, as CUBSTACK_TYPE=ssh states it.
  cpu_pytorch_ssh_cont="cs-smoke-cpu-pytorch-ssh-$$"
  check_ssh_mode "$IMG_CPU_PYTORCH" "$cpu_pytorch_ssh_cont" "$tmp/cpu-pytorch-ssh-only" "cpu-pytorch ssh-only"
  "$CONTAINER_TOOL" rm -f "$cpu_pytorch_ssh_cont" >/dev/null 2>&1 || true

  # ssh mode without a host key is a refusal, not a fallback.
  check_ssh_requires_key "$IMG_CPU_PYTORCH" "cpu-pytorch"

  # Root, in both modes: ssh always, and jupyter where the launcher has to serve the
  # derived home rather than the account the image bakes.
  check_root_ssh "$IMG_CPU_PYTORCH" "$tmp/cpu-pytorch-root" "cs-smoke-cpu-pytorch-root-$$" \
    "cpu-pytorch jupyter as root" -e NOTEBOOK_ARGS="--allow-root"
  check_root_ssh "$IMG_CPU_PYTORCH" "$tmp/cpu-pytorch-root-ssh" "cs-smoke-cpu-pytorch-root-ssh-$$" \
    "cpu-pytorch ssh as root" -e CUBSTACK_TYPE=ssh
  check_jupyter_home "$IMG_CPU_PYTORCH" /root \
    "cpu-pytorch as root: jupyter serves the derived home, /root"
  check_jupyter_home "$IMG_CPU_PYTORCH" /workspace/home \
    "cpu-pytorch as root: a declared HOME is served instead" \
    -e HOME=/workspace/home
fi

# ---------------------------------------------------------------------------
# maca-pytorch (platform layer on the Metax MACA base: jupyter + sshd)
#
# Same contract and the same assertions as cpu-pytorch — the overlay is what differs, not the
# operator-facing behaviour it has to satisfy. What it adds is that the vendor stack is
# reachable by the account that runs the container, in both modes.
# ---------------------------------------------------------------------------
if [ "$run_maca_pytorch" = 1 ]; then
  echo "== smoke: $IMG_MACA (maca-pytorch) =="
  base="/dev/ns/env"

  maca_cont="cs-smoke-maca-$$"
  make_secret "$tmp/macassh"
  ensure_mount_readable "$IMG_MACA" "$tmp/macassh/host/ssh_host_ed25519_key"

  start "$maca_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::8888 \
    -p 127.0.0.1::2222 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--ServerApp.base_url=$base/" \
    -v "$tmp/macassh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/macassh/keys:/run/ssh:ro" \
    "$IMG_MACA"
  maca_port="$(port_of "$maca_cont" 8888)"
  maca_ssh_port="$(port_of "$maca_cont" 2222)"

  # 120s rather than the cuda-pytorch block's 300: this base's notebook is a pip install onto a
  # vendor interpreter, not the NGC image's own stack.
  wait_jupyter "$maca_cont" "$maca_port" "$base" 120 "maca-pytorch"
  check_jupyter_http "$maca_port" "$base" "maca-pytorch"

  id_out="$("$CONTAINER_TOOL" exec "$maca_cont" sh -c 'printf "%s %s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
  if [ "$id_out" = "1000 1000" ]; then
    ok "maca-pytorch container runs as uid 1000 gid 1000"
  else
    bad "maca-pytorch expected '1000 1000', got '$id_out'"
  fi

  check_sudo "$IMG_MACA" "maca-pytorch"

  check_maca_readable "$maca_cont" "maca-pytorch"
  # `jupyter` as the tool name: this launcher execs a bare `jupyter`, so the tool it finds
  # is the interpreter the notebook will run on.
  check_vendor_python "$maca_cont" "maca-pytorch" jupyter

  check_jupyter_ssh "$maca_cont" "$maca_ssh_port" "$tmp/macassh" "maca-pytorch"
  "$CONTAINER_TOOL" rm -f "$maca_cont" >/dev/null 2>&1 || true

  check_jupyter_only "$IMG_MACA" "cs-smoke-maca-juponly-$$" "maca-pytorch jupyter-only"

  maca_ssh_cont="cs-smoke-maca-ssh-$$"
  check_ssh_mode "$IMG_MACA" "$maca_ssh_cont" "$tmp/macasshonly" "maca-pytorch ssh-only"
  # The vendor toolchain has to be there in the ssh mode too — it is what makes a MACA
  # environment usable for anything but a notebook.
  check_maca_readable "$maca_ssh_cont" "maca-pytorch ssh-only"
  check_vendor_python "$maca_ssh_cont" "maca-pytorch ssh-only"
  "$CONTAINER_TOOL" rm -f "$maca_ssh_cont" >/dev/null 2>&1 || true

  check_ssh_requires_key "$IMG_MACA" "maca-pytorch"

  # Running as root costs the jupyter arm one flag: jupyter-server refuses to start as root
  # without --allow-root. The controller injects it for a root DevEnvironment
  # (::withRootLauncherEnv), and a bare container has no controller, so the run is handed what
  # the pod would carry — this launcher reads NOTEBOOK_ARGS and none of the NB_* trio.
  check_root_ssh "$IMG_MACA" "$tmp/macaroot" "cs-smoke-macaroot-$$" \
    "maca-pytorch jupyter as root" -e NOTEBOOK_ARGS="--allow-root"
  check_root_ssh "$IMG_MACA" "$tmp/macarootssh" "cs-smoke-macarootssh-$$" \
    "maca-pytorch ssh as root" -e CUBSTACK_TYPE=ssh

  # Where a root environment's workspace is. The image bakes the uid-1000 account's home, so the
  # launcher has to decide this itself: a root container's own home is /root, the one the platform
  # derives for runAsUser: 0 and mounts the claim at. Both halves are asserted — the derived home,
  # and the declared one the launcher must leave standing, since that is where the claim really is
  # when a spec names it.
  check_jupyter_home "$IMG_MACA" /root \
    "maca-pytorch as root: jupyter serves the derived home, /root"
  check_jupyter_home "$IMG_MACA" /workspace/home \
    "maca-pytorch as root: a declared HOME is served instead" \
    -e HOME=/workspace/home
fi

# ---------------------------------------------------------------------------
# cuda-pytorch (platform layer on the NVIDIA NGC PyTorch base: jupyter + sshd)
#
# The MACA family's shape on the other vendor's base, and the same contract as cpu-pytorch.
# What differs is what the base brings rather than what the overlay does: no pip step, and
# no second interpreter to correct the PATH for, since this base installs into the
# distribution's own python. The vendor stack is therefore asserted by running it —
# check_torch and check_notebook_kernel stand where the MACA readability check stands.
# ---------------------------------------------------------------------------
if [ "$run_cuda_pytorch" = 1 ]; then
  echo "== smoke: $IMG_CUDA (cuda-pytorch) =="
  base="/dev/ns/env"

  cuda_cont="cs-smoke-cube-$$"
  make_secret "$tmp/cubessh"
  ensure_mount_readable "$IMG_CUDA" "$tmp/cubessh/host/ssh_host_ed25519_key"

  start "$cuda_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::8888 \
    -p 127.0.0.1::2222 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--ServerApp.base_url=$base/" \
    -v "$tmp/cubessh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/cubessh/keys:/run/ssh:ro" \
    "$IMG_CUDA"
  cube_port="$(port_of "$cuda_cont" 8888)"
  cube_ssh_port="$(port_of "$cuda_cont" 2222)"

  # 300s where the other families wait 120: this base's JupyterLab is a far larger import, and
  # the local run is the amd64 image under emulation. CI runs it natively and breaks out at the
  # first answer either way, so the ceiling only costs a failing run its wall-clock.
  wait_jupyter "$cuda_cont" "$cube_port" "$base" 300 "cuda-pytorch"
  check_jupyter_http "$cube_port" "$base" "cuda-pytorch"

  id_out="$("$CONTAINER_TOOL" exec "$cuda_cont" sh -c 'printf "%s %s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
  if [ "$id_out" = "1000 1000" ]; then
    ok "cuda-pytorch container runs as uid 1000 gid 1000"
  else
    bad "cuda-pytorch expected '1000 1000', got '$id_out'"
  fi

  check_sudo "$IMG_CUDA" "cuda-pytorch"

  check_torch "$cuda_cont" "cuda-pytorch"
  check_notebook_kernel "$cuda_cont" "cuda-pytorch"

  check_jupyter_ssh "$cuda_cont" "$cube_ssh_port" "$tmp/cubessh" "cuda-pytorch"
  "$CONTAINER_TOOL" rm -f "$cuda_cont" >/dev/null 2>&1 || true

  check_jupyter_only "$IMG_CUDA" "cs-smoke-cube-juponly-$$" "cuda-pytorch jupyter-only"

  cuda_ssh_cont="cs-smoke-cube-ssh-$$"
  check_ssh_mode "$IMG_CUDA" "$cuda_ssh_cont" "$tmp/cubesshonly" "cuda-pytorch ssh-only"
  check_torch "$cuda_ssh_cont" "cuda-pytorch ssh-only"
  "$CONTAINER_TOOL" rm -f "$cuda_ssh_cont" >/dev/null 2>&1 || true

  check_ssh_requires_key "$IMG_CUDA" "cuda-pytorch"

  check_root_ssh "$IMG_CUDA" "$tmp/cuberoot" "cs-smoke-cuberoot-$$" \
    "cuda-pytorch jupyter as root" -e NOTEBOOK_ARGS="--allow-root"
  check_root_ssh "$IMG_CUDA" "$tmp/cuberootssh" "cs-smoke-cuberootssh-$$" \
    "cuda-pytorch ssh as root" -e CUBSTACK_TYPE=ssh

  # The root branch of the shared launcher: root's own home is the one the platform derives for a
  # root environment and mounts the claim at, and a declared HOME is left standing.
  check_jupyter_home "$IMG_CUDA" /root \
    "cuda-pytorch as root: jupyter serves the derived home, /root"
  check_jupyter_home "$IMG_CUDA" /workspace/home \
    "cuda-pytorch as root: a declared HOME is served instead" \
    -e HOME=/workspace/home
fi

echo
echo "smoke summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
