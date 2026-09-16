# Cubestack 'ssh-ubuntu22.04' DevEnvironment base image.
#
# Minimal image exposing sshd on the unprivileged :2222 for the platform 'ssh'
# DevEnvironment type (the Service publishes it as 22).
# No key staging: the operator mounts two Secret keys as files (subPath) and sshd
# reads them in place —
#   ssh_host_ed25519_key -> /etc/ssh/ssh_host_ed25519_key   (host identity)
#   authorized_keys      -> /run/ssh/authorized_keys        (platform keys, outside $HOME)
# The container runs as uid/gid 1000 with $HOME=/home/ubuntu (the workspace PVC).
# See images/README.md for the mount contract and its subPath caveat.
#
# Build context MUST be images/ (not this directory) so common/ is COPYable, and the platform
# must be named: the base is multi-arch, so a bare `docker build` resolves it to the *host*
# architecture and an arm64 host would publish an arm64-only image.
#   docker build --platform linux/amd64 -f ssh-ubuntu-server/Dockerfile \
#     -t harbor.isuanova.com/suanova/ssh-ubuntu22.04:<tag> images/
#   (or: make -C images build)

# Base: the Ubuntu release tag, deliberately not a digest pin. The release is the
# axis the published repository name carries (ssh-ubuntu22.04), and it is
# re-resolved at build time so a rebuild picks up Ubuntu security updates; a pinned
# digest would freeze those out until someone remembered to bump it. Offline
# installs record the digest of what was actually shipped (decision doc §3.D, §5).
ARG UBUNTU_VERSION=22.04
FROM ubuntu:${UBUNTU_VERSION}

# Optional apt mirror override (e.g. a Tsinghua/Aliyun mirror in CN); empty = upstream.
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

# Platform account: literal 'ubuntu', uid/gid 1000, home /home/ubuntu — the same
# account, group, and home the AWS Ubuntu cloud image uses. The workspace PVC
# mounts at the home, so nothing durable is baked under it; ~/.ssh exists only so
# a subPath Secret mount and `ssh-copy-id` have a target when no PVC is attached.
RUN groupadd -g 1000 ubuntu \
    && useradd -u 1000 -g 1000 -s /bin/bash -d /home/ubuntu ubuntu \
    && mkdir -p /home/ubuntu/.ssh \
    && chown -R 1000:1000 /home/ubuntu \
    && chmod 700 /home/ubuntu/.ssh

# No host keys in the image: identity comes from the mounted Secret. Their
# absence is also what tells the entrypoint whether ssh is enabled.
RUN rm -f /etc/ssh/ssh_host_*

COPY common/entrypoint.sh /usr/local/bin/cubestack-entrypoint.sh
# Shared sshd config (common/), with this family's ssh login account substituted
# for the @SSH_USER@ placeholder. It must match USER below.
ARG SSH_USER=ubuntu
COPY common/sshd/10-nonroot.conf /etc/ssh/sshd_config.d/10-nonroot.conf
RUN chmod +x /usr/local/bin/cubestack-entrypoint.sh \
    && sed -i "s/@SSH_USER@/${SSH_USER}/" /etc/ssh/sshd_config.d/10-nonroot.conf

ENV CUBESTACK_IMAGE=ssh \
    HOME=/home/ubuntu

WORKDIR /home/ubuntu
USER 1000:1000
EXPOSE 2222
ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/cubestack-entrypoint.sh"]
