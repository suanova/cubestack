#!/usr/bin/env bash
# Local Docker smoke for the Cubestack DevEnvironment base images.
#
# No cluster required: runs throwaway containers on 127.0.0.1 with ephemeral
# ports and fake ssh Secrets, then asserts the operator contract:
#   ssh-ubuntu22.04     : key-auth ssh login as 'ubuntu' (uid/gid 1000, home
#                         /home/ubuntu), served host key == mounted Secret public key
#   jupyter-minimal     : stock-native overlay (user 'jovyan', uid 1000 gid 100,
#                         /home/jovyan) — JupyterLab behind JUPYTER_TOKEN +
#                         NOTEBOOK_ARGS base_url, plus sshd-as-'jovyan' when the ssh
#                         Secret is mounted; both services in the same container, and
#                         a root run serves the home the platform derives (/root, or
#                         the one the spec declares) rather than the /home/root
#                         docker-stacks' own launcher would relocate it to
#   jupyter-maca-pytorch: platform layer on the Metax MACA base (user 'ubuntu', uid/gid
#                         1000, /home/ubuntu) — the same two services and the same
#                         assertions as jupyter-minimal, plus that the vendor stack
#                         under /opt/maca is readable by the account that runs it, that
#                         the default python3 is the vendor's own and imports its torch
#                         (and that `jupyter` comes from that interpreter), and
#                         the same root-home check on an image whose launcher is the
#                         platform's rather than docker-stacks'
#   ssh-maca-pytorch    : the same vendor base and platform layer with no JupyterLab at
#                         all — sshd alone, as CUBESTACK_IMAGE=ssh bakes in. Asserted
#                         apart from its jupyter sibling precisely on that difference, on
#                         that same vendor python, and on the ssh session PATH carrying
#                         both the vendor toolchain and the interpreter that owns torch.
#   jupyter-cuda-pytorch: the platform layer on the other vendor's base (NVIDIA NGC PyTorch),
#                         same two services and same 'ubuntu' 1000:1000 identity. The stack
#                         the base brings is asserted by running it rather than by reading
#                         the tree: the account's own python3 imports torch, and the notebook
#                         kernel resolves onto that same interpreter
#   ssh-cuda-pytorch    : the same vendor base and platform layer with sshd alone — where the
#                         NGC base differs from every other one here is that it *ships*
#                         JupyterLab, so absence of the binary proves nothing and its baked
#                         mode is asserted on the process instead
#
# Every one of them additionally has its ssh session environment compared against the
# image's own, which is what keeps the shared sshd drop-in's build-time substitution
# honest (see check_session_env below).
#
# Every image is also run as **root** (uid 0), the shape an environment takes when
# the spec asks for it, where the host key is mounted 0600 and sshd is root itself.
# The non-root runs additionally assert that this root support is not a widening:
# the entrypoint admits root only when sshd is root, so a uid-1000 sshd refuses a
# root login at authentication and a non-root environment serves no root session.
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
# Reads IMG_SSH / IMG_JUPYTER / IMG_MACA / IMG_SSH_MACA / IMG_CUDA / IMG_SSH_CUDA from the
# environment (the Makefile sets them).
# Usage: hack/smoke.sh [--ssh|--jupyter|--maca|--ssh-maca|--cuda|--ssh-cuda]   (default: all)
set -euo pipefail

cd "$(dirname "$0")/.." # images/ workspace root

# Fallback tags mirror the Makefile default: TAG is the short commit SHA, and each vendor pair
# prefixes it with the axes its published tag carries (MACA_TAG / CUDA_TAG in the Makefile — keep
# the two in step). Only a direct call reaches these: the Makefile passes every ref it built with.
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
IMG_SSH="${IMG_SSH:-harbor.isuanova.com/suanova/ssh-ubuntu22.04:$TAG}"
IMG_JUPYTER="${IMG_JUPYTER:-harbor.isuanova.com/suanova/jupyter-minimal:$TAG}"
IMG_MACA="${IMG_MACA:-harbor.isuanova.com/suanova/jupyter-maca-pytorch:3.9.0.12-py310-torch2.4-$TAG}"
IMG_SSH_MACA="${IMG_SSH_MACA:-harbor.isuanova.com/suanova/ssh-maca-pytorch:3.9.0.12-py310-torch2.4-$TAG}"
# One axis, not three: the NGC release pins python, torch and CUDA together, so CUDA_TAG is that
# release and nothing else.
IMG_CUDA="${IMG_CUDA:-harbor.isuanova.com/suanova/jupyter-cuda-pytorch:26.08-$TAG}"
IMG_SSH_CUDA="${IMG_SSH_CUDA:-harbor.isuanova.com/suanova/ssh-cuda-pytorch:26.08-$TAG}"
CONTAINER_TOOL="${CONTAINER_TOOL:-docker}"

run_ssh=1
run_jupyter=1
run_maca=1
run_ssh_maca=1
run_cuda=1
run_ssh_cuda=1
case "${1:-}" in
  --ssh) run_jupyter=0; run_maca=0; run_ssh_maca=0; run_cuda=0; run_ssh_cuda=0 ;;
  --jupyter) run_ssh=0; run_maca=0; run_ssh_maca=0; run_cuda=0; run_ssh_cuda=0 ;;
  --maca) run_ssh=0; run_jupyter=0; run_ssh_maca=0; run_cuda=0; run_ssh_cuda=0 ;;
  --ssh-maca) run_ssh=0; run_jupyter=0; run_maca=0; run_cuda=0; run_ssh_cuda=0 ;;
  --cuda) run_ssh=0; run_jupyter=0; run_maca=0; run_ssh_maca=0; run_ssh_cuda=0 ;;
  --ssh-cuda) run_ssh=0; run_jupyter=0; run_maca=0; run_ssh_maca=0; run_cuda=0 ;;
  -h | --help) sed -n '2,59p' "$0"; exit 0 ;;
  "") ;;
  *) echo "cubestack smoke: unknown option '$1'" >&2; exit 1 ;;
esac

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cubestack-smoke.XXXXXX")"
ssh_cont=""
jup_cont=""
root_cont=""
maca_cont=""
ssh_maca_cont=""
cuda_cont=""
ssh_cuda_cont=""
cleanup() {
  local code=$?
  [ -n "$ssh_cont" ] && "$CONTAINER_TOOL" rm -f "$ssh_cont" >/dev/null 2>&1 || true
  [ -n "$jup_cont" ] && "$CONTAINER_TOOL" rm -f "$jup_cont" >/dev/null 2>&1 || true
  [ -n "$root_cont" ] && "$CONTAINER_TOOL" rm -f "$root_cont" >/dev/null 2>&1 || true
  [ -n "$maca_cont" ] && "$CONTAINER_TOOL" rm -f "$maca_cont" >/dev/null 2>&1 || true
  [ -n "$ssh_maca_cont" ] && "$CONTAINER_TOOL" rm -f "$ssh_maca_cont" >/dev/null 2>&1 || true
  [ -n "$cuda_cont" ] && "$CONTAINER_TOOL" rm -f "$cuda_cont" >/dev/null 2>&1 || true
  [ -n "$ssh_cuda_cont" ] && "$CONTAINER_TOOL" rm -f "$ssh_cuda_cont" >/dev/null 2>&1 || true
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
  local port=$1 secs=$2 name=$3 i
  for i in $(seq 1 "$secs"); do
    if [ -n "$(served_key "$port")" ]; then return 0; fi
    sleep 1
  done
  echo "  container $name did not serve an ssh host key on port $port within ${secs}s; last logs:"
  "$CONTAINER_TOOL" logs "$name" 2>&1 | tail -n 20
  return 1
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

# check_root_ssh <image> <secret dir> <container name> <label> [extra run args...]
#
# The root half of the contract, which neither block below reaches: an environment
# runs its image as root when the spec asks for it
# (spec.runtime.securityContext.runAsUser 0), and ssh has to work there too. Two
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
# account the image was built around. Extra args carry what a family needs to *stay
# up* as root — a stock jupyter launcher otherwise drops to the account the image
# was built around — and are what the controller injects for a root DevEnvironment,
# which a bare container has to be given by hand (::withRootLauncherEnv).
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
  root_cont="$cont"
  port="$("$CONTAINER_TOOL" port "$cont" 2222 2>/dev/null | head -n1 | sed 's/^.*://' || true)"
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
  root_cont=""
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

# check_vendor_torch <container> <label> — the NVIDIA pair's equivalent of the readability check
# above, and a different question because the base is a different shape: it is not a vendor tree
# dropped under /opt, it installs into the distribution's own python, so "can the account reach the
# vendor stack" is answered by *running* it rather than by walking the filesystem.
#
# The interpreter is the point. This base ships one python, the account's, and it is what an ssh
# session and a build RUN get — so torch importing there is the fact the image exists for. The
# version is reported, not compared: the base's own PYTORCH_BUILD_VERSION carries the NGC release
# suffix (…+4fdf77b against …+4fdf77b940.nv26.08), so an equality check would be a false one.
#
# Read without --user, so `docker exec` uses the image's own USER — the account in question, the
# same reasoning as check_maca_readable.
check_vendor_torch() {
  local name=$1 label=$2 server version
  server="$("$CONTAINER_TOOL" exec "$name" sh -c 'command -v python3' 2>/dev/null || true)"
  if [ -z "$server" ]; then
    bad "$label no python3 on the account's PATH"
    return 0
  fi
  version="$("$CONTAINER_TOOL" exec "$name" python3 -c 'import torch; print(torch.__version__)' 2>/dev/null || true)"
  if [ -n "$version" ]; then
    ok "$label account's python3 ($server) imports the vendor torch ($version)"
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
# under emulation, where a real cell does not complete. (Learned on the MACA pair.)
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
# uid 0 throughout, since this is the root branch's check, and no Secret is mounted, so sshd never
# starts and the run is the launcher alone.
check_jupyter_home() {
  local img=$1 home=$2 label=$3 info=""
  shift 3
  # Named under root_cont like the other root-mode containers, so the EXIT trap owns it too.
  root_cont="cs-smoke-jup-home-$$"
  "$CONTAINER_TOOL" run -d --name "$root_cont" \
    --user 0:0 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--allow-root" \
    --tmpfs "$home" \
    "$@" \
    "$img" >/dev/null
  # The report lives inside the runtime directory, so waiting for it waits for both: a server that
  # is still starting has written neither.
  for _ in $(seq 1 120); do
    info="$("$CONTAINER_TOOL" exec "$root_cont" \
      sh -c "cat $home/.local/share/jupyter/runtime/jpserver-*.json 2>/dev/null" || true)"
    case "$info" in
      *"\"root_dir\": \"$home\""*) break ;;
    esac
    info=""
    sleep 1
  done
  if [ -n "$info" ]; then
    ok "$label"
  else
    bad "$label (jupyter does not report $home as the directory it serves)"
    "$CONTAINER_TOOL" logs "$root_cont" 2>&1 | tail -n 20
  fi
  "$CONTAINER_TOOL" rm -f "$root_cont" >/dev/null 2>&1 || true
  root_cont=""
}

# ---------------------------------------------------------------------------
# ssh-ubuntu22.04
# ---------------------------------------------------------------------------
if [ "$run_ssh" = 1 ]; then
  echo "== smoke: $IMG_SSH (ssh-ubuntu22.04) =="
  ssh_cont="cs-smoke-ssh-$$"
  make_secret "$tmp/ssh"
  ensure_mount_readable "$IMG_SSH" "$tmp/ssh/host/ssh_host_ed25519_key"

  "$CONTAINER_TOOL" run -d --name "$ssh_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::2222 \
    -v "$tmp/ssh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/ssh/keys:/run/ssh:ro" \
    "$IMG_SSH" >/dev/null
  # `docker port` fails on a container that is not running; `|| true` keeps that
  # from aborting the run before the checks below can report it (pipefail is on).
  ssh_port="$("$CONTAINER_TOOL" port "$ssh_cont" 2222 2>/dev/null | head -n1 | sed 's/^.*://' || true)"
  # Record a timeout instead of letting set -e cut the run short: the ssh checks
  # below and the summary are exactly what a failing run is read for.
  wait_ssh "$ssh_port" 30 "$ssh_cont" ||
    bad "sshd served no host key on port $ssh_port within 30s"

  out="$(ssh -i "$tmp/ssh/client/id_ed25519" \
    -p "$ssh_port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    ubuntu@127.0.0.1 \
    'printf "uid=%s gid=%s home=%s pwd=%s\n" "$(id -u)" "$(id -gn)" "$HOME" "$PWD"; env | sed "s/^/envv:/"' \
    2>&1 || true)"

  check_contains "$out" "uid=1000" "ssh key-auth login as uid 1000"
  check_contains "$out" "gid=ubuntu" "ssh login primary group 'ubuntu'"
  check_contains "$out" "home=/home/ubuntu" "ssh login HOME=/home/ubuntu"
  check_contains "$out" "pwd=/home/ubuntu" "ssh login cwd=/home/ubuntu"

  check_session_env "$ssh_cont" "$out" "ssh"

  check_served_host_key "$ssh_port" "$tmp/ssh/host/ssh_host_ed25519_key.pub" \
    "$ssh_cont" "served host key == mounted Secret public key"

  check_no_root_login "$ssh_port" "$tmp/ssh/client/id_ed25519" "$ssh_cont" \
    "ssh: a non-root sshd refuses a root login"

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    echo "  container logs:"
    "$CONTAINER_TOOL" logs "$ssh_cont" 2>&1 | tail -n 20
    echo "  mounted files as the container sees them:"
    "$CONTAINER_TOOL" exec --user 0 "$ssh_cont" ls -ln \
      /etc/ssh/ssh_host_ed25519_key /run/ssh/authorized_keys 2>&1 || true
  fi
  "$CONTAINER_TOOL" rm -f "$ssh_cont" >/dev/null 2>&1 || true
  ssh_cont=""

  check_root_ssh "$IMG_SSH" "$tmp/sshroot" "cs-smoke-sshroot-$$" "ssh-ubuntu22.04 as root"
fi

# ---------------------------------------------------------------------------
# jupyter-minimal (stock-native overlay: jupyter server + optional sshd)
# ---------------------------------------------------------------------------
if [ "$run_jupyter" = 1 ]; then
  echo "== smoke: $IMG_JUPYTER (jupyter-minimal) =="
  jup_cont="cs-smoke-jupyter-$$"
  base="/dev/ns/env"
  make_secret "$tmp/jupssh"
  ensure_mount_readable "$IMG_JUPYTER" "$tmp/jupssh/host/ssh_host_ed25519_key"

  # Native identity (uid 1000, gid 'users' 100) and pure-stock knobs: token via
  # JUPYTER_TOKEN, URL prefix via NOTEBOOK_ARGS. The ssh Secret is mounted so the
  # overlay's sshd starts next to jupyter.
  "$CONTAINER_TOOL" run -d --name "$jup_cont" \
    --user 1000:100 \
    -p 127.0.0.1::8888 \
    -p 127.0.0.1::2222 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--ServerApp.base_url=$base/" \
    -v "$tmp/jupssh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/jupssh/keys:/run/ssh:ro" \
    "$IMG_JUPYTER" >/dev/null
  # See the ssh block: a stopped container makes `docker port` fail, which must not
  # abort the run before the Jupyter checks and the summary.
  jup_port="$("$CONTAINER_TOOL" port "$jup_cont" 8888 2>/dev/null | head -n1 | sed 's/^.*://' || true)"
  jup_ssh_port="$("$CONTAINER_TOOL" port "$jup_cont" 2222 2>/dev/null | head -n1 | sed 's/^.*://' || true)"

  printf "  waiting for JupyterLab"
  up=0
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$jup_port$base/api/status?token=testtoken" 2>/dev/null; then
      up=1
      break
    fi
    printf "."
    sleep 1
  done
  echo
  if [ "$up" = 1 ]; then
    ok "jupyter /api/status with token -> 200"
  else
    bad "jupyter did not become reachable within 90s"
    "$CONTAINER_TOOL" logs "$jup_cont" 2>&1 | tail -n 30
  fi

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$jup_port$base/api/status")"
  case "$code" in
    401 | 403) ok "no token rejected (HTTP $code)" ;;
    *) bad "no-token request expected 401/403, got $code" ;;
  esac

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$jup_port/api/status?token=testtoken")"
  if [ "$code" = 404 ]; then
    ok "base_url prefix enforced (root path -> 404)"
  else
    bad "root path without base_url expected 404, got $code"
  fi

  html="$(curl -fsSL "http://127.0.0.1:$jup_port$base/?token=testtoken" 2>/dev/null || true)"
  check_contains "$html" "jupyter-config-data" "lab HTML served on base_url path"

  id_out="$("$CONTAINER_TOOL" exec "$jup_cont" sh -c 'printf "%s %s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
  if [ "$id_out" = "1000 100" ]; then
    ok "container runs as native uid 1000 gid 100"
  else
    bad "expected '1000 100', got '$id_out'"
  fi

  # sshd on the same container (ssh Secret mounted -> ssh.enabled).
  wait_ssh "$jup_ssh_port" 30 "$jup_cont" ||
    bad "sshd served no host key on port $jup_ssh_port within 30s"

  out="$(ssh -i "$tmp/jupssh/client/id_ed25519" \
    -p "$jup_ssh_port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    jovyan@127.0.0.1 \
    'printf "uid=%s home=%s pwd=%s\n" "$(id -u)" "$HOME" "$PWD"; env | sed "s/^/envv:/"' \
    2>&1 || true)"
  check_contains "$out" "uid=1000" "jupyter ssh key-auth login as uid 1000"
  check_contains "$out" "home=/home/jovyan" "jupyter ssh login HOME=/home/jovyan"

  check_session_env "$jup_cont" "$out" "jupyter"

  check_served_host_key "$jup_ssh_port" "$tmp/jupssh/host/ssh_host_ed25519_key.pub" \
    "$jup_cont" "jupyter served host key == mounted Secret public key"

  check_no_root_login "$jup_ssh_port" "$tmp/jupssh/client/id_ed25519" "$jup_cont" \
    "jupyter: a non-root sshd refuses a root login"

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    echo "  container logs:"
    "$CONTAINER_TOOL" logs "$jup_cont" 2>&1 | tail -n 20
    echo "  mounted files as the container sees them:"
    "$CONTAINER_TOOL" exec --user 0 "$jup_cont" ls -ln \
      /etc/ssh/ssh_host_ed25519_key /run/ssh/authorized_keys 2>&1 || true
  fi
  "$CONTAINER_TOOL" rm -f "$jup_cont" >/dev/null 2>&1 || true
  jup_cont=""

  # What the controller injects for a root DevEnvironment (::withRootLauncherEnv), which a bare
  # container has no controller to receive: the login below is only attempted against a live
  # container, and a launcher that exits takes the sshd it started with it. This image's launcher
  # does not consult them — uid 0 leaves the stock start.sh out of the chain entirely (see
  # images/jupyter/start-jupyter.sh) — but the run carries them because the pod does, and without
  # them a *stock* jupyter image still drops back to the account it was built around. NB_GID is the
  # account's own gid and not the pod's: start.sh rewrites the account when the two disagree, and
  # that rewrite cannot succeed for root.
  check_root_ssh "$IMG_JUPYTER" "$tmp/juproot" "cs-smoke-juproot-$$" "jupyter-minimal as root" \
    -e NB_USER=root -e NB_UID=0 -e NB_GID=0 \
    -e NOTEBOOK_ARGS="--allow-root"

  # The root branch this image's launcher owns: root's own home, which is the one the platform
  # derives for a root environment and mounts the claim at, and a declared HOME left standing.
  check_jupyter_home "$IMG_JUPYTER" /root \
    "jupyter-minimal as root: jupyter serves the derived home, /root"
  check_jupyter_home "$IMG_JUPYTER" /workspace/home \
    "jupyter-minimal as root: a declared HOME is served instead" \
    -e HOME=/workspace/home
fi

# ---------------------------------------------------------------------------
# jupyter-maca-pytorch (platform layer on the Metax MACA base: jupyter + sshd)
#
# Same contract and the same assertions as jupyter-minimal — the overlay is what differs,
# not the operator-facing behaviour it has to satisfy: 'ubuntu' 1000:1000 and /home/ubuntu
# instead of the stock 'jovyan' 1000:100 and /home/jovyan, because the shared sshd drop-in
# is a non-root configuration and can only serve the uid it runs as.
# ---------------------------------------------------------------------------
if [ "$run_maca" = 1 ]; then
  echo "== smoke: $IMG_MACA (jupyter-maca-pytorch) =="
  maca_cont="cs-smoke-maca-$$"
  base="/dev/ns/env"
  make_secret "$tmp/macassh"
  ensure_mount_readable "$IMG_MACA" "$tmp/macassh/host/ssh_host_ed25519_key"

  "$CONTAINER_TOOL" run -d --name "$maca_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::8888 \
    -p 127.0.0.1::2222 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--ServerApp.base_url=$base/" \
    -v "$tmp/macassh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/macassh/keys:/run/ssh:ro" \
    "$IMG_MACA" >/dev/null
  # See the ssh block: a stopped container makes `docker port` fail, which must not
  # abort the run before the Jupyter checks and the summary.
  maca_port="$("$CONTAINER_TOOL" port "$maca_cont" 8888 2>/dev/null | head -n1 | sed 's/^.*://' || true)"
  maca_ssh_port="$("$CONTAINER_TOOL" port "$maca_cont" 2222 2>/dev/null | head -n1 | sed 's/^.*://' || true)"

  printf "  waiting for JupyterLab"
  up=0
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$maca_port$base/api/status?token=testtoken" 2>/dev/null; then
      up=1
      break
    fi
    printf "."
    sleep 1
  done
  echo
  if [ "$up" = 1 ]; then
    ok "maca jupyter /api/status with token -> 200"
  else
    bad "maca jupyter did not become reachable within 120s"
    "$CONTAINER_TOOL" logs "$maca_cont" 2>&1 | tail -n 30
  fi

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$maca_port$base/api/status")"
  case "$code" in
    401 | 403) ok "maca no token rejected (HTTP $code)" ;;
    *) bad "maca no-token request expected 401/403, got $code" ;;
  esac

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$maca_port/api/status?token=testtoken")"
  if [ "$code" = 404 ]; then
    ok "maca base_url prefix enforced (root path -> 404)"
  else
    bad "maca root path without base_url expected 404, got $code"
  fi

  html="$(curl -fsSL "http://127.0.0.1:$maca_port$base/?token=testtoken" 2>/dev/null || true)"
  check_contains "$html" "jupyter-config-data" "maca lab HTML served on base_url path"

  id_out="$("$CONTAINER_TOOL" exec "$maca_cont" sh -c 'printf "%s %s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
  if [ "$id_out" = "1000 1000" ]; then
    ok "maca container runs as uid 1000 gid 1000"
  else
    bad "maca expected '1000 1000', got '$id_out'"
  fi

  check_maca_readable "$maca_cont" "maca"
  # `jupyter` as the third name: this image's launcher is the platform's (`start-jupyter.sh` execs a
  # bare `jupyter`), so the tool it finds is the interpreter the notebook will run on.
  check_vendor_python "$maca_cont" "maca" jupyter

  # sshd on the same container (ssh Secret mounted -> ssh.enabled).
  wait_ssh "$maca_ssh_port" 30 "$maca_cont" ||
    bad "maca sshd served no host key on port $maca_ssh_port within 30s"

  out="$(ssh -i "$tmp/macassh/client/id_ed25519" \
    -p "$maca_ssh_port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    ubuntu@127.0.0.1 \
    'printf "uid=%s gid=%s home=%s pwd=%s\n" "$(id -u)" "$(id -gn)" "$HOME" "$PWD"; env | sed "s/^/envv:/"' \
    2>&1 || true)"
  check_contains "$out" "uid=1000" "maca ssh key-auth login as uid 1000"
  check_contains "$out" "gid=ubuntu" "maca ssh login primary group 'ubuntu'"
  check_contains "$out" "home=/home/ubuntu" "maca ssh login HOME=/home/ubuntu"
  check_contains "$out" "pwd=/home/ubuntu" "maca ssh login cwd=/home/ubuntu"

  check_session_env "$maca_cont" "$out" "maca"
  # The user-facing half of the same fact: the vendor toolchain that exists ONLY under
  # /opt/maca/bin (mcTracer, mcclras, macainfo, mxvs, ...) is reachable over ssh. mx-smi is
  # deliberately not the check — the vendor also symlinks it into /usr/bin, so it resolves
  # even under a wrong PATH and would prove nothing.
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:PATH=//p')" "/opt/maca/bin" \
    "maca ssh session PATH carries the MACA toolchain"
  # The other half of the same fact, and the one that decides which python a *non-interactive* ssh
  # command runs: the session PATH has to carry the vendor's conda too. The base publishes it only
  # from a login profile, so without this an interactive session reaches the vendor torch and
  # `ssh host 'python3 ...'` reaches the system interpreter that has none.
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:PATH=//p')" "/opt/conda/bin" \
    "maca ssh session PATH carries the vendor python"

  check_served_host_key "$maca_ssh_port" "$tmp/macassh/host/ssh_host_ed25519_key.pub" \
    "$maca_cont" "maca served host key == mounted Secret public key"

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    echo "  container logs:"
    "$CONTAINER_TOOL" logs "$maca_cont" 2>&1 | tail -n 20
    echo "  mounted files as the container sees them:"
    "$CONTAINER_TOOL" exec --user 0 "$maca_cont" ls -ln \
      /etc/ssh/ssh_host_ed25519_key /run/ssh/authorized_keys 2>&1 || true
  fi
  "$CONTAINER_TOOL" rm -f "$maca_cont" >/dev/null 2>&1 || true
  maca_cont=""

  # Running as root costs this image one flag: jupyter-server refuses to start as root without
  # --allow-root. The controller injects it for a root DevEnvironment (::withRootLauncherEnv),
  # and a bare container has no controller, so the run is handed what the pod would carry —
  # this launcher reads NOTEBOOK_ARGS and none of the NB_* trio. A launcher that exits takes
  # the sshd it started with it, so the login below would otherwise never be attempted
  # against a live container.
  check_root_ssh "$IMG_MACA" "$tmp/macaroot" "cs-smoke-macaroot-$$" \
    "jupyter-maca-pytorch as root" \
    -e NOTEBOOK_ARGS="--allow-root"

  # Where a root environment's workspace is. This image bakes the uid-1000 account's home, so the
  # launcher has to decide this itself: a root container's own home is /root, the one the platform
  # derives for runAsUser: 0 and mounts the claim at. Both halves are asserted — the derived home,
  # and the declared one the launcher must leave standing, since that is where the claim really is
  # when a spec names it.
  check_jupyter_home "$IMG_MACA" /root \
    "maca as root: jupyter serves the derived home, /root"
  check_jupyter_home "$IMG_MACA" /workspace/home \
    "maca as root: a declared HOME is served instead" \
    -e HOME=/workspace/home
fi

# ---------------------------------------------------------------------------
# ssh-maca-pytorch (the same vendor base and platform layer, with sshd alone)
#
# Its jupyter sibling serves both services from one container; this one serves only sshd,
# because CUBESTACK_IMAGE=ssh is baked in and the entrypoint's ssh branch never reaches
# the image CMD. That difference is what is asserted here rather than the shared contract
# again — chiefly that no JupyterLab exists to run.
# ---------------------------------------------------------------------------
if [ "$run_ssh_maca" = 1 ]; then
  echo "== smoke: $IMG_SSH_MACA (ssh-maca-pytorch) =="
  ssh_maca_cont="cs-smoke-ssh-maca-$$"
  make_secret "$tmp/sshmacassh"
  ensure_mount_readable "$IMG_SSH_MACA" "$tmp/sshmacassh/host/ssh_host_ed25519_key"

  # Only 2222 is published: this image declares no 8888, and nothing serves there.
  "$CONTAINER_TOOL" run -d --name "$ssh_maca_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::2222 \
    -v "$tmp/sshmacassh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/sshmacassh/keys:/run/ssh:ro" \
    "$IMG_SSH_MACA" >/dev/null
  # See the ssh block: a stopped container makes `docker port` fail, which must not abort
  # the run before the checks below and the summary.
  ssh_maca_port="$("$CONTAINER_TOOL" port "$ssh_maca_cont" 2222 2>/dev/null | head -n1 | sed 's/^.*://' || true)"

  wait_ssh "$ssh_maca_port" 30 "$ssh_maca_cont" ||
    bad "ssh-maca sshd served no host key on port $ssh_maca_port within 30s"

  out="$(ssh -i "$tmp/sshmacassh/client/id_ed25519" \
    -p "$ssh_maca_port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    ubuntu@127.0.0.1 \
    'printf "uid=%s gid=%s home=%s pwd=%s\n" "$(id -u)" "$(id -gn)" "$HOME" "$PWD"; env | sed "s/^/envv:/"' \
    2>&1 || true)"
  check_contains "$out" "uid=1000" "ssh-maca ssh key-auth login as uid 1000"
  check_contains "$out" "gid=ubuntu" "ssh-maca ssh login primary group 'ubuntu'"
  check_contains "$out" "home=/home/ubuntu" "ssh-maca ssh login HOME=/home/ubuntu"
  check_contains "$out" "pwd=/home/ubuntu" "ssh-maca ssh login cwd=/home/ubuntu"

  check_session_env "$ssh_maca_cont" "$out" "ssh-maca"
  # The user-facing half of the same fact, and the reason an ssh-only image on this base
  # exists at all: the vendor toolchain that lives ONLY under /opt/maca/bin (mcTracer,
  # mcclras, macainfo, mxvs, ...) is reachable over ssh.
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:PATH=//p')" "/opt/maca/bin" \
    "ssh-maca ssh session PATH carries the MACA toolchain"
  # The half that decides which python a *non-interactive* `ssh host 'python3 ...'` runs, which is
  # the shape a script or a CI job uses: without the vendor's conda on the session PATH that command
  # lands on the system interpreter, whose torch does not exist, while an interactive session — which
  # gets a login shell, and so the base's own conda profile — works and hides it.
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:PATH=//p')" "/opt/conda/bin" \
    "ssh-maca ssh session PATH carries the vendor python"

  # The property that makes this a separate image rather than a copy of its sibling. The
  # vendor base ships no JupyterLab and this Dockerfile installs none, so finding one means
  # the jupyter sibling's pip step was copied across — which would silently make an
  # ssh-type environment run a second, unprobed service.
  jl="$("$CONTAINER_TOOL" exec "$ssh_maca_cont" sh -c 'command -v jupyter-lab || true' 2>/dev/null || true)"
  if [ -z "$jl" ]; then
    ok "no JupyterLab in the image (sshd alone, as its baked mode declares)"
  else
    bad "JupyterLab present at $jl: this image is meant to serve sshd alone"
  fi

  check_maca_readable "$ssh_maca_cont" "ssh-maca"
  # No tool argument: this image ships no launcher of its own, so its default python3 is the whole
  # of what a session reaches.
  check_vendor_python "$ssh_maca_cont" "ssh-maca"

  check_served_host_key "$ssh_maca_port" "$tmp/sshmacassh/host/ssh_host_ed25519_key.pub" \
    "$ssh_maca_cont" "ssh-maca served host key == mounted Secret public key"

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    echo "  container logs:"
    "$CONTAINER_TOOL" logs "$ssh_maca_cont" 2>&1 | tail -n 20
    echo "  mounted files as the container sees them:"
    "$CONTAINER_TOOL" exec --user 0 "$ssh_maca_cont" ls -ln \
      /etc/ssh/ssh_host_ed25519_key /run/ssh/authorized_keys 2>&1 || true
  fi
  "$CONTAINER_TOOL" rm -f "$ssh_maca_cont" >/dev/null 2>&1 || true
  ssh_maca_cont=""

  # Same root contract as the CPU ssh image, and the only thing the shared drop-in and the
  # entrypoint's runtime root entry need in order to work here: /run/sshd, which this Dockerfile
  # ships. An ssh-only image has no launcher to keep alive either — the entrypoint execs sshd,
  # which is what the login below reaches.
  check_root_ssh "$IMG_SSH_MACA" "$tmp/sshmacaroot" "cs-smoke-sshmacaroot-$$" \
    "ssh-maca-pytorch as root"
fi

# ---------------------------------------------------------------------------
# jupyter-cuda-pytorch (platform layer on the NVIDIA NGC PyTorch base: jupyter + sshd)
#
# The MACA pair's shape on the other vendor's base, and the same contract as jupyter-minimal.
# What differs is what the base brings rather than what the overlay does: no pip step, and no
# second interpreter to correct the PATH for, since this base installs into the distribution's own
# python. The vendor stack is therefore asserted by running it — check_vendor_torch and
# check_notebook_kernel stand where the MACA pair's readability check stands.
# ---------------------------------------------------------------------------
if [ "$run_cuda" = 1 ]; then
  echo "== smoke: $IMG_CUDA (jupyter-cuda-pytorch) =="
  cuda_cont="cs-smoke-cuda-$$"
  base="/dev/ns/env"
  make_secret "$tmp/cudassh"
  ensure_mount_readable "$IMG_CUDA" "$tmp/cudassh/host/ssh_host_ed25519_key"

  "$CONTAINER_TOOL" run -d --name "$cuda_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::8888 \
    -p 127.0.0.1::2222 \
    -e JUPYTER_TOKEN=testtoken \
    -e NOTEBOOK_ARGS="--ServerApp.base_url=$base/" \
    -v "$tmp/cudassh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/cudassh/keys:/run/ssh:ro" \
    "$IMG_CUDA" >/dev/null
  # See the ssh block: a stopped container makes `docker port` fail, which must not
  # abort the run before the Jupyter checks and the summary.
  cuda_port="$("$CONTAINER_TOOL" port "$cuda_cont" 8888 2>/dev/null | head -n1 | sed 's/^.*://' || true)"
  cuda_ssh_port="$("$CONTAINER_TOOL" port "$cuda_cont" 2222 2>/dev/null | head -n1 | sed 's/^.*://' || true)"

  # 300s where the CPU pair waits 120: this base's JupyterLab is a far larger import, and the local
  # run is the amd64 image under emulation. CI runs it natively and breaks out at the first answer
  # either way, so the ceiling only costs a failing run its wall-clock.
  printf "  waiting for JupyterLab"
  up=0
  for _ in $(seq 1 300); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$cuda_port$base/api/status?token=testtoken" 2>/dev/null; then
      up=1
      break
    fi
    printf "."
    sleep 1
  done
  echo
  if [ "$up" = 1 ]; then
    ok "cuda jupyter /api/status with token -> 200"
  else
    bad "cuda jupyter did not become reachable within 300s"
    "$CONTAINER_TOOL" logs "$cuda_cont" 2>&1 | tail -n 30
  fi

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$cuda_port$base/api/status")"
  case "$code" in
    401 | 403) ok "cuda no token rejected (HTTP $code)" ;;
    *) bad "cuda no-token request expected 401/403, got $code" ;;
  esac

  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$cuda_port/api/status?token=testtoken")"
  if [ "$code" = 404 ]; then
    ok "cuda base_url prefix enforced (root path -> 404)"
  else
    bad "cuda root path without base_url expected 404, got $code"
  fi

  html="$(curl -fsSL "http://127.0.0.1:$cuda_port$base/?token=testtoken" 2>/dev/null || true)"
  check_contains "$html" "jupyter-config-data" "cuda lab HTML served on base_url path"

  id_out="$("$CONTAINER_TOOL" exec "$cuda_cont" sh -c 'printf "%s %s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
  if [ "$id_out" = "1000 1000" ]; then
    ok "cuda container runs as uid 1000 gid 1000"
  else
    bad "cuda expected '1000 1000', got '$id_out'"
  fi

  check_vendor_torch "$cuda_cont" "cuda"
  check_notebook_kernel "$cuda_cont" "cuda"

  # sshd on the same container (ssh Secret mounted -> ssh.enabled).
  wait_ssh "$cuda_ssh_port" 30 "$cuda_cont" ||
    bad "cuda sshd served no host key on port $cuda_ssh_port within 30s"

  out="$(ssh -i "$tmp/cudassh/client/id_ed25519" \
    -p "$cuda_ssh_port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    ubuntu@127.0.0.1 \
    'printf "uid=%s gid=%s home=%s pwd=%s\n" "$(id -u)" "$(id -gn)" "$HOME" "$PWD"; env | sed "s/^/envv:/"' \
    2>&1 || true)"
  check_contains "$out" "uid=1000" "cuda ssh key-auth login as uid 1000"
  check_contains "$out" "gid=ubuntu" "cuda ssh login primary group 'ubuntu'"
  check_contains "$out" "home=/home/ubuntu" "cuda ssh login HOME=/home/ubuntu"
  check_contains "$out" "pwd=/home/ubuntu" "cuda ssh login cwd=/home/ubuntu"

  check_session_env "$cuda_cont" "$out" "cuda"
  # The user-facing half of the same fact: the CUDA toolkit that lives ONLY under
  # /usr/local/cuda/bin (nvcc, ptxas, cuobjdump, ...) is reachable over ssh, and torch's own
  # libraries are on the session's loader path. nvidia-smi is deliberately not the check — it
  # comes from driver injection at container start, so it would be a check of the node, not of the
  # image (decision.md §3.A).
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:PATH=//p')" "/usr/local/cuda/bin" \
    "cuda ssh session PATH carries the CUDA toolkit"
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:LD_LIBRARY_PATH=//p')" \
    "/usr/local/lib/python3.12/dist-packages/torch/lib" \
    "cuda ssh session LD_LIBRARY_PATH carries torch's libs"

  check_served_host_key "$cuda_ssh_port" "$tmp/cudassh/host/ssh_host_ed25519_key.pub" \
    "$cuda_cont" "cuda served host key == mounted Secret public key"

  check_no_root_login "$cuda_ssh_port" "$tmp/cudassh/client/id_ed25519" "$cuda_cont" \
    "cuda: a non-root sshd refuses a root login"

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    echo "  container logs:"
    "$CONTAINER_TOOL" logs "$cuda_cont" 2>&1 | tail -n 20
    echo "  mounted files as the container sees them:"
    "$CONTAINER_TOOL" exec --user 0 "$cuda_cont" ls -ln \
      /etc/ssh/ssh_host_ed25519_key /run/ssh/authorized_keys 2>&1 || true
  fi
  "$CONTAINER_TOOL" rm -f "$cuda_cont" >/dev/null 2>&1 || true
  cuda_cont=""

  # Running as root costs this image one flag, as it does its siblings: jupyter-server refuses to
  # start as root without --allow-root, which the controller injects for a root DevEnvironment
  # (::withRootLauncherEnv) and a bare container has to be handed. This image's launcher is the
  # shared one, so it reads NOTEBOOK_ARGS and none of the NB_* trio.
  check_root_ssh "$IMG_CUDA" "$tmp/cudaroot" "cs-smoke-cudaroot-$$" \
    "jupyter-cuda-pytorch as root" \
    -e NOTEBOOK_ARGS="--allow-root"

  # The root branch of the shared launcher: root's own home is the one the platform derives for a
  # root environment and mounts the claim at, and a declared HOME is left standing.
  check_jupyter_home "$IMG_CUDA" /root \
    "cuda as root: jupyter serves the derived home, /root"
  check_jupyter_home "$IMG_CUDA" /workspace/home \
    "cuda as root: a declared HOME is served instead" \
    -e HOME=/workspace/home
fi

# ---------------------------------------------------------------------------
# ssh-cuda-pytorch (the same vendor base and platform layer, with sshd alone)
#
# Its jupyter sibling serves both services from one container; this one serves only sshd, because
# CUBESTACK_IMAGE=ssh is baked in and the entrypoint's ssh branch never reaches the image CMD. The
# MACA pair asserts that difference by the binary, which works only because that vendor base ships
# no JupyterLab — this base ships one, so absence proves nothing here and the assertion is on the
# process tree instead.
# ---------------------------------------------------------------------------
if [ "$run_ssh_cuda" = 1 ]; then
  echo "== smoke: $IMG_SSH_CUDA (ssh-cuda-pytorch) =="
  ssh_cuda_cont="cs-smoke-ssh-cuda-$$"
  make_secret "$tmp/sshcudassh"
  ensure_mount_readable "$IMG_SSH_CUDA" "$tmp/sshcudassh/host/ssh_host_ed25519_key"

  # Only 2222 is published: this image declares no 8888, and nothing serves there.
  "$CONTAINER_TOOL" run -d --name "$ssh_cuda_cont" \
    --user 1000:1000 \
    -p 127.0.0.1::2222 \
    -v "$tmp/sshcudassh/host/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro" \
    -v "$tmp/sshcudassh/keys:/run/ssh:ro" \
    "$IMG_SSH_CUDA" >/dev/null
  # See the ssh block: a stopped container makes `docker port` fail, which must not abort
  # the run before the checks below and the summary.
  ssh_cuda_port="$("$CONTAINER_TOOL" port "$ssh_cuda_cont" 2222 2>/dev/null | head -n1 | sed 's/^.*://' || true)"

  wait_ssh "$ssh_cuda_port" 30 "$ssh_cuda_cont" ||
    bad "ssh-cuda sshd served no host key on port $ssh_cuda_port within 30s"

  out="$(ssh -i "$tmp/sshcudassh/client/id_ed25519" \
    -p "$ssh_cuda_port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    ubuntu@127.0.0.1 \
    'printf "uid=%s gid=%s home=%s pwd=%s\n" "$(id -u)" "$(id -gn)" "$HOME" "$PWD"; env | sed "s/^/envv:/"' \
    2>&1 || true)"
  check_contains "$out" "uid=1000" "ssh-cuda ssh key-auth login as uid 1000"
  check_contains "$out" "gid=ubuntu" "ssh-cuda ssh login primary group 'ubuntu'"
  check_contains "$out" "home=/home/ubuntu" "ssh-cuda ssh login HOME=/home/ubuntu"
  check_contains "$out" "pwd=/home/ubuntu" "ssh-cuda ssh login cwd=/home/ubuntu"

  check_session_env "$ssh_cuda_cont" "$out" "ssh-cuda"
  # The reason an ssh-only image on this base exists at all, and what naming the session
  # environment in the drop-in buys: the CUDA toolkit and torch's libraries are reachable over ssh.
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:PATH=//p')" "/usr/local/cuda/bin" \
    "ssh-cuda ssh session PATH carries the CUDA toolkit"
  check_contains "$(printf '%s\n' "$out" | sed -n 's/^envv:LD_LIBRARY_PATH=//p')" \
    "/usr/local/lib/python3.12/dist-packages/torch/lib" \
    "ssh-cuda ssh session LD_LIBRARY_PATH carries torch's libs"

  # The property that makes this a separate image rather than a copy of its sibling. Asked of the
  # process tree because the base ships JupyterLab: what the baked mode decides is whether anything
  # runs it. A container that cannot report its own processes fails rather than passes, so this
  # cannot go vacuous the way an unreadable directory can.
  procs="$("$CONTAINER_TOOL" exec "$ssh_cuda_cont" sh -c 'ps -eo args' 2>/dev/null || true)"
  case "$procs" in
    "") bad "ssh-cuda could not read the container's process list, so the check proves nothing" ;;
    *jupyter*) bad "ssh-cuda a notebook server is running in an ssh-type container" ;;
    *) ok "ssh-cuda no notebook server running (sshd alone, as its baked mode declares)" ;;
  esac

  check_vendor_torch "$ssh_cuda_cont" "ssh-cuda"

  check_served_host_key "$ssh_cuda_port" "$tmp/sshcudassh/host/ssh_host_ed25519_key.pub" \
    "$ssh_cuda_cont" "ssh-cuda served host key == mounted Secret public key"

  check_no_root_login "$ssh_cuda_port" "$tmp/sshcudassh/client/id_ed25519" "$ssh_cuda_cont" \
    "ssh-cuda: a non-root sshd refuses a root login"

  if ! case "$out" in *"uid=1000"*) true ;; *) false ;; esac; then
    echo "  container logs:"
    "$CONTAINER_TOOL" logs "$ssh_cuda_cont" 2>&1 | tail -n 20
    echo "  mounted files as the container sees them:"
    "$CONTAINER_TOOL" exec --user 0 "$ssh_cuda_cont" ls -ln \
      /etc/ssh/ssh_host_ed25519_key /run/ssh/authorized_keys 2>&1 || true
  fi
  "$CONTAINER_TOOL" rm -f "$ssh_cuda_cont" >/dev/null 2>&1 || true
  ssh_cuda_cont=""

  # Same root contract as the CPU ssh image: /run/sshd, which this Dockerfile ships, and an
  # entrypoint that execs sshd as root — there is no launcher here to keep alive.
  check_root_ssh "$IMG_SSH_CUDA" "$tmp/sshcudaroot" "cs-smoke-sshcudaroot-$$" \
    "ssh-cuda-pytorch as root"
fi

echo
echo "smoke summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
