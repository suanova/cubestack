# Cubestack 'cpu-pytorch' DevEnvironment image — the CPU family, carrying the CPU build of
# PyTorch. The name is <accelerator>-<stack>: `cpu` says there is no accelerator, `pytorch` says
# which framework the image bakes in (decision doc §5).
#
# Serves BOTH modes from one container, selected at run time by CUBSTACK_TYPE (which the
# controller injects from spec.type, common/entrypoint.sh):
#   jupyter  JupyterLab on 8888 (the jupyter type's main port, which readiness probes), plus
#            sshd on the unprivileged 2222 when the operator mounted the ssh host key
#   ssh      sshd alone on 2222, no notebook process
#
# One image rather than two is what keeps the offline package small: the ssh image was this
# base plus sshd, so the jupyter half had to carry the same runtime anyway. The mode is not
# baked into the image because CUBSTACK_TYPE wins over the default below.
#
# No key staging: the operator mounts two Secret entries and sshd reads them in place —
#   ssh_host_ed25519_key -> /etc/ssh/ssh_host_ed25519_key   (host identity, subPath file)
#   authorized_keys      -> /run/ssh/authorized_keys        (platform keys, directory mount)
#
# Build context MUST be images/ (not this directory) so common/ is COPYable, and the platform
# must be named: the base is multi-arch, so a bare `docker build` resolves it to the *host*
# architecture and an arm64 host would publish an arm64-only image.
#   docker build --platform linux/amd64 -f cpu-pytorch/Dockerfile \
#     --build-arg TORCH_VERSION=2.4.0 \
#     -t harbor.isuanova.com/suanova/cpu-pytorch:py310-torch2.4-<tag> images/
#   (or: make -C images build-cpu-pytorch)

# Base: the Ubuntu release tag plus the digest of the platform registry's copy of it, which
# is what the build resolves (BASE_ARGS, images/Makefile). The digest is there because the
# tag alone is not a decision made here: the mirror is repointed by
# operator/hack/mirror-e2e-images.sh and `ubuntu:22.04` is refreshed upstream monthly, so the
# same revision could otherwise build two different base layers under one published tag.
# Pinning makes picking up the security updates that refresh carries a deliberate step —
# read the new digest, update the two maps, re-mirror. Offline installs record the digest of
# what was actually shipped (decision doc §3.D, §5).
#
# UBUNTU_BASE exists because UBUNTU_VERSION cannot carry a registry host. The base is
# therefore a separate arg defaulting to upstream through that same version, and the
# platform registry's copy is substituted for offline builds — see BASE_MIRRORS in the
# operator Makefile.
ARG UBUNTU_VERSION=22.04
ARG UBUNTU_BASE=ubuntu:${UBUNTU_VERSION}
FROM ${UBUNTU_BASE}

# Optional apt mirror override (e.g. a Tsinghua/Aliyun mirror in CN); empty = upstream.
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i -E "s#https?://(archive|ports)\.ubuntu\.com/(ubuntu|ubuntu-ports)#${APT_MIRROR}#g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
    fi

ARG DEBIAN_FRONTEND=noninteractive
# sudo is installed but grants nothing: it runs only for the accounts a sudoers rule
# names, and the image names none. spec.runtime.sudo is what supplies the rule
# (images/README.md, image-contract.md).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      openssh-server \
      python3 \
      python3-pip \
      sudo \
      tini \
    && rm -rf /var/lib/apt/lists/*

# PyTorch, the CPU build: the family's stack and the reason the image is named for it. Installed
# from PyTorch's own CPU wheel index rather than from PyPI, whose linux wheel is the *CUDA* build
# — the accelerator this family does not have, and several GB of it. TORCH_INDEX_URL overrides
# the index for an offline/CN mirror; TORCH_VERSION has no default because images/Makefile reads
# it to build the published tag, so a build that could not name its torch would publish a tag it
# cannot back. It is a required build arg, not a floating latest.
ARG TORCH_VERSION
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN python3 -m pip install --no-cache-dir \
      --index-url "$TORCH_INDEX_URL" \
      torch==${TORCH_VERSION}

# JupyterLab onto the distribution's python: the base ships no notebook stack, and the
# notebook kernel has to be the interpreter an ssh session and the launcher both reach.
# numpy rides along: torch does not depend on it, but its array bridge does — importing torch
# without numpy warns on every start and `Tensor.numpy()` fails — and the torch index above
# does not carry it. It is held below 2 because torch 2.4.0 predates its official NumPy 2
# support; the bridge does work against the 2.x that was current when this was built, but
# leaving it floating would let a rebuild change the answer under an unchanged image tag.
# pip's cache is dropped; the image carries the installed packages only.
ARG PIP_INDEX_URL=""
RUN set -eu; \
    pip_args=""; \
    if [ -n "$PIP_INDEX_URL" ]; then pip_args="--index-url $PIP_INDEX_URL"; fi; \
    python3 -m pip install --no-cache-dir $pip_args jupyterlab 'numpy<2'

# Platform account: literal 'ubuntu', uid/gid 1000, home /home/ubuntu — the same account,
# group, and home every family image ships, so a DevEnvironment states it once
# (spec.runtime.user: ubuntu) whatever family it runs. The workspace PVC mounts at the home,
# so nothing durable is baked under it; ~/.ssh exists only so the account's own
# `ssh-copy-id` target exists when no PVC is attached.
RUN groupadd -g 1000 ubuntu \
    && useradd -u 1000 -g 1000 -s /bin/bash -d /home/ubuntu ubuntu \
    && mkdir -p /home/ubuntu/.ssh \
    && chown -R 1000:1000 /home/ubuntu \
    && chmod 700 /home/ubuntu/.ssh

# No host keys in the image: identity comes from the mounted Secret. Their absence is also
# what tells the entrypoint whether ssh is enabled.
# /run/sshd is the privilege separation directory a *root* sshd requires and a non-root one
# never consults - the apt package relies on the init system to create it, which a container
# has none of (see common/sshd/10-devenv.conf).
RUN rm -f /etc/ssh/ssh_host_* \
    && mkdir -p -m 0700 /run/sshd

COPY common/entrypoint.sh /usr/local/bin/cubestack-entrypoint.sh
# The shared launch chain: the base ships no notebook server and no command to start one.
COPY common/jupyter/start-jupyter.sh /usr/local/bin/start-jupyter.sh
# Shared sshd config (common/), installed by the script that also owns its placeholders:
# this family's ssh login account (which must match USER below) and the session
# environment. This base ships nothing off the default search path, so PATH alone; the
# installer reads its value from the build environment and fails the build if it is
# missing (see the drop-in and the script).
ARG SSH_USER=ubuntu
COPY common/sshd/10-devenv.conf /etc/ssh/sshd_config.d/10-devenv.conf
COPY common/sshd/install-dropin.sh /tmp/install-dropin.sh
RUN chmod +x /usr/local/bin/cubestack-entrypoint.sh /usr/local/bin/start-jupyter.sh \
    && sh /tmp/install-dropin.sh "${SSH_USER}" PATH \
    && rm -f /tmp/install-dropin.sh

# The baked mode is only the standalone default: the controller states CUBSTACK_TYPE for
# every jupyter and ssh environment, and that wins (common/entrypoint.sh).
ENV CUBESTACK_IMAGE=jupyter \
    HOME=/home/ubuntu

WORKDIR /home/ubuntu
USER 1000:1000
EXPOSE 8888 2222
ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/cubestack-entrypoint.sh"]
CMD ["/usr/local/bin/start-jupyter.sh"]
