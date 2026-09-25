# Cubestack 'ssh-cuda-pytorch' DevEnvironment image — NVIDIA NGC PyTorch base, ssh only.
#
# The ssh-only half of the NVIDIA story, and the GPU counterpart of ssh-ubuntu22.04: the same
# platform layer as jupyter-cuda-pytorch on the same vendor base, without JupyterLab. The split
# is not cosmetic, because the mode is baked into the image (CUBESTACK_IMAGE) — the operator
# injects no type, as entrypoint.sh notes — so no single image can be both. A `type: ssh`
# DevEnvironment pointed at the jupyter image would run JupyterLab beside sshd; pointed here,
# it runs sshd alone.
#
# What that leaves is the toolchain the image exists to serve: the base's python 3.12 and its
# torch, over an ssh session, on whatever the login account can reach. The account is the base's
# own (uid/gid 1000 'ubuntu', home /home/ubuntu) — inherited rather than created, so the
# Dockerfile must not useradd over it — and the platform adds the sshd layer: openssh-server,
# the shared entrypoint, the sshd drop-in, and the baked CUBESTACK_IMAGE. Nothing is installed
# from pip, and the vendor's ENTRYPOINT is displaced as it is in the jupyter sibling.
#
# No key staging: the operator mounts two Secret entries and sshd reads them in place —
#   ssh_host_ed25519_key -> /etc/ssh/ssh_host_ed25519_key   (host identity, subPath file)
#   authorized_keys      -> /run/ssh/authorized_keys        (platform keys, directory mount)
#
# Build context MUST be images/ (not this directory) so common/ is COPYable.
#   docker build --platform linux/amd64 -f ssh-cuda-pytorch/Dockerfile \
#     -t harbor.isuanova.com/suanova/ssh-cuda-pytorch:<tag> images/
#   (or: make -C images build-ssh-cuda)

# The platform registry's mirrored copy of the vendor image, which is what a bare `docker build`
# resolves. Every published build substitutes the same reference pinned by digest through BASE_ARGS
# in images/Makefile — which is where the base is bumped, and the pin is the only difference.
#
# The mirror serves a single-arch manifest (linux/amd64) rather than an index, so this image is
# amd64-only — see CUDA_PLATFORM in the Makefile.
ARG CUDA_BASE=harbor.isuanova.com/mirrors/nvcr.io/nvidia/pytorch:26.08-py3
FROM ${CUDA_BASE}

# The vendor image runs as root (config.User is unset); step up for the overlay steps.
USER root

# Optional apt mirror override for CN/offline builds; empty = upstream. No PIP_INDEX_URL, unlike
# the CPU jupyter image: this image installs nothing from pip.
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i -E "s#https?://(archive|ports)\.ubuntu\.com/(ubuntu|ubuntu-ports)#${APT_MIRROR}#g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
    fi

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      openssh-server \
      tini \
    && rm -rf /var/lib/apt/lists/*

# The account is the base's, so all this adds is the one directory it does not ship: the `ssh-copy-id`
# target the account's own key lands in when no workspace is attached. The workspace PVC mounts at
# this home, so nothing durable is baked under it.
RUN mkdir -p /home/ubuntu/.ssh \
    && chown 1000:1000 /home/ubuntu/.ssh \
    && chmod 700 /home/ubuntu/.ssh

# No host keys in the image: identity comes from the mounted Secret. Their absence is also what
# tells the entrypoint whether ssh is enabled — and in ssh mode an absent key is fatal, which is
# the right reading of "an ssh environment was asked for but nothing mounted the identity".
# (The apt package above may generate a set of its own, so this comes after it.)
# /run/sshd is the privilege separation directory a *root* sshd requires and a non-root one never
# consults - the apt package relies on the init system to create it, which a container has none of
# (see common/sshd/10-devenv.conf).
RUN rm -f /etc/ssh/ssh_host_* \
    && mkdir -p -m 0700 /run/sshd

# The platform's entrypoint replaces the vendor's. It is the same entrypoint as every other image;
# here the baked CUBESTACK_IMAGE=ssh below selects the branch that execs sshd in the foreground and
# never reaches "$@", which is why this image carries no CMD and copies no launcher.
COPY common/entrypoint.sh /usr/local/bin/cubestack-entrypoint.sh
# Shared sshd config (common/), installed by the script that also owns its placeholders: this
# image's ssh login account (which must match USER below) and the session environment. The vendor's
# PATH, loader and linker paths and CUDA_HOME are named here so the ssh session carries the same
# toolchain the container runs with — sshd replaces a session's environment, so anything not named
# is simply absent (see the drop-in and the script). This image is defined by that: the CUDA stack
# it exists to serve is reachable over ssh only because it is named. The list is the jupyter
# sibling's, and the two must agree — the pair moves together.
ARG SSH_USER=ubuntu
COPY common/sshd/10-devenv.conf /etc/ssh/sshd_config.d/10-devenv.conf
COPY common/sshd/install-dropin.sh /tmp/install-dropin.sh
RUN chmod +x /usr/local/bin/cubestack-entrypoint.sh \
    && sh /tmp/install-dropin.sh "${SSH_USER}" \
         PATH LD_LIBRARY_PATH LIBRARY_PATH CUDA_HOME TORCH_ALLOW_TF32_CUBLAS_OVERRIDE \
    && rm -f /tmp/install-dropin.sh

# The vendor's PATH, LD_LIBRARY_PATH and LIBRARY_PATH are inherited from the base: they are what
# put the CUDA stack on the account's search path, which a non-root login needs exactly as the
# vendor's root shell did.
ENV CUBESTACK_IMAGE=ssh \
    HOME=/home/ubuntu

WORKDIR /home/ubuntu
USER 1000:1000
# 2222 only: this image serves no jupyter, so it declares no 8888.
EXPOSE 2222
ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/cubestack-entrypoint.sh"]
