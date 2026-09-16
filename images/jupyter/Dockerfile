# Cubestack 'jupyter-minimal' DevEnvironment image (CPU) — stock-native overlay.
#
# Thin overlay on the docker-stacks minimal-notebook image that enables ONLY ssh
# for the platform (see docs/design/devenv-images/decision.md): everything else
# stays identical to the stock image. The upstream layout is kept exactly — user
# 'jovyan' (uid 1000, primary group 'users' gid 100), $HOME=/home/jovyan, and the
# stock launch chain tini -> start.sh -> start-notebook.py. A DevEnvironment
# running this image configures that layout explicitly: spec.runtime.user=jovyan
# derives the workspace mount /home/jovyan, and securityContext.runAsGroup must
# be set to 100 (see images/README.md).
#
# Additions on top of stock:
#   - openssh-server, started only when the operator mounted the ssh Secret. No
#     key staging: the Secret keys are mounted with subPath (host key at
#     /etc/ssh/ssh_host_ed25519_key, platform authorized_keys at
#     /run/ssh/authorized_keys, outside $HOME) and sshd reads them in place.
#   - Jupyter itself honors JUPYTER_TOKEN and NOTEBOOK_ARGS natively (token,
#     base_url, ...) — no overlay jupyter logic.
#
# Build context MUST be images/ so common/ is COPYable, and the platform must be named: the base
# is multi-arch, so a bare `docker build` resolves it to the *host* architecture and an arm64 host
# would publish an arm64-only image.
#   docker build --platform linux/amd64 -f jupyter/Dockerfile \
#     -t harbor.isuanova.com/suanova/jupyter-minimal:<tag> images/
#   (or: make -C images build)

ARG JUPYTER_BASE=quay.io/jupyter/minimal-notebook:2026-09-07
FROM ${JUPYTER_BASE}

# docker-stacks ends with `USER jovyan`; step up for the overlay steps.
USER root

# Optional apt/pip mirror overrides for CN/offline builds; empty = upstream.
ARG APT_MIRROR=""
ARG PIP_INDEX_URL=""
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i -E "s#https?://(archive|ports)\.ubuntu\.com/(ubuntu|ubuntu-ports)#${APT_MIRROR}#g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
    fi

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server \
    && rm -rf /var/lib/apt/lists/*

# Create the ~/.ssh target for the subPath authorized_keys mount (so a manual run
# without a workspace PVC still works; the PVC shadows it in-cluster), and drop
# the package-generated host keys: identity comes from the mounted Secret, and
# their absence is how the entrypoint detects that ssh is enabled.
RUN mkdir -p /home/jovyan/.ssh \
    && chown 1000:100 /home/jovyan/.ssh \
    && chmod 700 /home/jovyan/.ssh \
    && rm -f /etc/ssh/ssh_host_*

COPY common/entrypoint.sh /usr/local/bin/cubestack-entrypoint.sh
# Shared sshd config (common/), with this family's ssh login account substituted
# for the @SSH_USER@ placeholder. It must match the stock container account
# (jovyan) that USER selects below.
ARG SSH_USER=jovyan
COPY common/sshd/10-nonroot.conf /etc/ssh/sshd_config.d/10-nonroot.conf
RUN chmod +x /usr/local/bin/cubestack-entrypoint.sh \
    && sed -i "s/@SSH_USER@/${SSH_USER}/" /etc/ssh/sshd_config.d/10-nonroot.conf

ENV CUBESTACK_IMAGE=jupyter

EXPOSE 8888 2222

# Back to the stock account; HOME/workdir remain stock /home/jovyan.
USER 1000

# Our entrypoint runs first (starts sshd when the Secret is mounted), then hands
# off to the image CMD, which reproduces the stock launch chain exactly (the base
# image runs tini + ENTRYPOINT start.sh + CMD start-notebook.py).
ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/cubestack-entrypoint.sh"]
CMD ["/usr/local/bin/start.sh", "start-notebook.py"]
