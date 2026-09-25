#!/usr/bin/env bash
# Cubestack image entrypoint.
#
# The DevEnvironment controller never sets command/args, so this script decides
# what a container runs. CUBESTACK_IMAGE is baked into each image at build time;
# an optional CUBESTACK_TYPE (future platform mode injection) wins when present.
#
# sshd reads the operator's Secret mounts directly — there is no key staging. The
# host key is a subPath mount, so it is frozen at container start; the authorized
# keys are an ordinary Secret mount, which kubelet updates in place (see
# images/README.md).
#
# Modes:
#   jupyter  start sshd only when the operator mounted the ssh Secret, then hand
#            off to the image CMD (start-jupyter.sh in each jupyter image: the CPU
#            one dispatches into docker-stacks' start.sh, and both vendor images run
#            the shared common/jupyter one, which expands NOTEBOOK_ARGS into
#            --ServerApp.base_url itself — neither vendor base starts jupyter at all,
#            one shipping none and the other JupyterLab with no command to launch it).
#   ssh      run sshd in the foreground.
set -euo pipefail

mode="${CUBESTACK_TYPE:-${CUBESTACK_IMAGE:-ssh}}"

# The operator mounts the ssh Secret's host key here. Images ship no host keys of
# their own, so the file's presence means ssh is enabled.
ssh_enabled() { [ -f /etc/ssh/ssh_host_ed25519_key ]; }

# Root is admitted only where it can be served. A non-root sshd can only setuid to
# the account it runs as, so admitting root there buys nothing and costs a login
# that is accepted and then dies at setresuid ("Failed to set uids to 0.") - the
# refusal belongs at authentication. The condition is the uid this process runs as,
# which is also the only uid that can write there, so the two cannot disagree.
# AllowUsers accumulates across drop-ins, so this adds to 10-devenv.conf rather
# than needing to replace it (see common/sshd/10-devenv.conf).
allow_root_login() {
  [ "$EUID" -eq 0 ] || return 0
  printf 'AllowUsers root\n' >/etc/ssh/sshd_config.d/20-allow-root.conf
}

case "$mode" in
  jupyter)
    if ssh_enabled; then
      allow_root_login
      # Validate before backgrounding: a host key that is present but unusable
      # (bad config, unreadable key) would otherwise kill sshd while jupyter kept
      # serving on its own port — the environment reports ready with the published
      # ssh endpoint silently dead. The key's *absence* is the intentional
      # ssh-off case handled above; its presence means ssh was requested.
      if ! /usr/sbin/sshd -t -f /etc/ssh/sshd_config; then
        echo "cubestack: sshd -t failed; refusing to run without a working ssh endpoint" >&2
        exit 1
      fi
      /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config &
    fi
    # Hand off to the image CMD (the image decides its launch chain).
    exec "$@"
    ;;
  ssh)
    if ! ssh_enabled; then
      echo "cubestack: no host key at /etc/ssh/ssh_host_ed25519_key;" \
           "is the ssh Secret mounted?" >&2
      exit 1
    fi
    allow_root_login
    exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
    ;;
  *)
    echo "cubestack: unknown mode '$mode'" >&2
    exit 1
    ;;
esac
