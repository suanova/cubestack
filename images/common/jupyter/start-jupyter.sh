#!/usr/bin/env bash
# Cubestack jupyter launch chain, shared by the two vendor (GPU) jupyter images: the Metax MACA
# one and the NVIDIA CUDA one.
#
# This is the image CMD. common/entrypoint.sh has already started sshd when the operator mounted
# the ssh host key, and hands off here (mode jupyter). Neither vendor base ships a launcher — the
# MACA one has no jupyter at all, the CUDA one ships JupyterLab but no command that starts it — so
# this is the platform's, and it stands in for docker-stacks' start.sh, which is what the CPU
# jupyter image runs, because the controller injects the same two variables for both:
#
#   JUPYTER_TOKEN  the operator injects it (a secretKeyRef to <env>-jupyter-token) for every
#                  jupyter-type environment, and jupyter-server reads that variable itself.
#
#   NOTEBOOK_ARGS  the platform's flag channel. The controller puts
#                  `--ServerApp.base_url=<webPath>` in it, and jupyter does NOT read the
#                  variable — a launcher has to expand it. Word-splitting is the point of the
#                  unquoted expansion below, which is why shellcheck is silenced for that line:
#                  quoting it would pass the whole string as one flag.
#
# --ServerApp.root_dir is the workspace: $HOME is the account's home, where the platform mounts
# the PVC, so a user's notebooks land on durable storage rather than in the image.
set -euo pipefail

# Which account that is depends on the uid, and the image bakes only one of the two: /home/ubuntu
# is the home of the uid-1000 account this overlay creates, while a root container's home is root's
# own, /root — the home the platform derives for a root environment and mounts the workspace at,
# and the one an ssh session already gets from the passwd database. Without this a root environment
# would keep serving the account this image bakes: jupyter's root_dir and its runtime directory
# both follow $HOME, so the notebooks would land on the container's filesystem while the PVC at
# /root went unused.
#
# The guard is what keeps a declared HOME authoritative. /home/ubuntu is a value only this image
# bakes, so anything else came from the spec (the controller passes spec.runtime.env through), and
# it is the value the platform mounted the claim at — overriding it would orphan the mount. It is
# also the one home a root environment here cannot declare, a declared /home/ubuntu being
# indistinguishable from the image's default: a root environment that wants its workspace
# elsewhere names the home it wants.
if [ "$(id -u)" = 0 ] && [ "${HOME:-}" = /home/ubuntu ]; then
  export HOME=/root
fi

# shellcheck disable=SC2086
exec jupyter lab \
  --ip=0.0.0.0 \
  --port=8888 \
  --no-browser \
  --ServerApp.allow_remote_access=True \
  --ServerApp.root_dir="$HOME" \
  ${NOTEBOOK_ARGS:-}
