# Cubestack 'maca-pytorch' DevEnvironment image — the Metax family.
#
# Serves BOTH modes from one container, selected at run time by CUBSTACK_TYPE (which the
# controller injects from spec.type, common/entrypoint.sh):
#   jupyter  JupyterLab on 8888 (the jupyter type's main port, which readiness probes), plus
#            sshd on the unprivileged 2222 when the operator mounted the ssh host key
#   ssh      sshd alone on 2222, no notebook process
#
# One image rather than two is what keeps the offline package small: the ssh sibling omitted the
# JupyterLab pip step and baked a mode, which CUBSTACK_TYPE now states at run time.
#
# Unlike the cuda-pytorch image this is not stock-native: the vendor base ships no launcher, no sshd,
# no non-root account, and no ENTRYPOINT at all (config.User is unset, so it would run as root and
# its CMD is a bare /bin/bash that exits immediately). So this Dockerfile adds the platform
# layer the cpu-pytorch family image defines — account ubuntu 1000:1000 with $HOME=/home/ubuntu,
# openssh-server, the shared entrypoint — on top of the vendor's own python/torch/MACA stack,
# inherited as the base published it except for PATH, which the overlay corrects so that `python3`
# is the interpreter that owns the vendor torch (see below). The account is not a preference: the
# shared sshd drop-in is a non-root configuration (Port 2222, UsePAM no, AllowUsers pinned to that
# one account), and a non-root sshd can only serve the uid it runs as.
#
# No key staging: the operator mounts two Secret entries and sshd reads them in place —
#   ssh_host_ed25519_key -> /etc/ssh/ssh_host_ed25519_key   (host identity, subPath file)
#   authorized_keys      -> /run/ssh/authorized_keys        (platform keys, directory mount)
#
# Build context MUST be images/ (not this directory) so common/ is COPYable.
#   docker build --platform linux/amd64 -f maca-pytorch/Dockerfile \
#     -t harbor.isuanova.com/suanova/maca-pytorch:<tag> images/
#   (or: make -C images build-maca-pytorch)

# The platform registry's mirrored copy of the vendor package, which is what a bare `docker build`
# resolves. Every published build substitutes the same reference pinned by digest through BASE_ARGS
# in images/Makefile — which is where the base is bumped, and the pin is the only difference.
#
# The vendor publishes this package per architecture (`-amd64` is part of the tag), and the
# mirror is a single-arch manifest rather than an index, so this image is amd64-only — see
# MACA_PLATFORM in the Makefile.
ARG MACA_BASE=harbor.isuanova.com/mirrors/cr.metax-tech.com/public-library/maca-pytorch:3.9.0.12-torch2.4-py310-ubuntu22.04-amd64
FROM ${MACA_BASE}

# The vendor image runs as root and ships no non-root account; step up for the overlay steps.
USER root

# Optional apt/pip mirror overrides for CN/offline builds; empty = upstream.
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
      sudo \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Make the VENDOR's python the image's python, before anything resolves `python3`.
#
# The base ships two 3.10 interpreters: /opt/conda/bin/python3, which owns the vendor torch, and the
# system /usr/bin/python3, which does not. It publishes conda only from /etc/profile.d/conda.sh, which
# prepends it for a *login* shell — so an interactive session gets the right interpreter while a build
# RUN, or the non-login shell sshd gives a one-shot command, silently gets the other. Naming it here is
# what makes every path agree: this build, the launch chain below, the notebook kernel (jupyter_client
# rewrites a bare `python` argv[0] to sys.executable, so the kernel runs the server's interpreter), and
# the ssh session, whose SetEnv carries exactly this PATH (see common/sshd/install-dropin.sh).
#
# Prepending is safe against this base in particular: /opt/conda/bin shares no name with any of the
# MACA toolchain directories and holds no compiler, linker or mpirun, so the vendor's own tools are
# not shadowed (images/README.md, Trade-offs).
ENV PATH=/opt/conda/bin:$PATH

# JupyterLab onto that interpreter, never a second one: the point of this image is that the torch a
# notebook imports is the vendor's metax build, importable only by the interpreter named above. The
# step deliberately calls bare `python3` rather than an absolute path, so it is also the build-time
# check of the claim — if the PATH above were ever wrong, this is where it shows.
#
# It carries no fallback for a vendor pip that is missing: conda ships pip (24.3.1 on the pinned base),
# and one would install pip for /usr/bin/python3 while `python3` still resolved to conda's, so it could
# only ever mask a wrong interpreter rather than repair one. `set -eu` fails the build instead.
ARG PIP_INDEX_URL=""
RUN set -eu; \
    pip_args=""; \
    if [ -n "$PIP_INDEX_URL" ]; then pip_args="--index-url $PIP_INDEX_URL"; fi; \
    python3 -m pip install --no-cache-dir $pip_args jupyterlab

# Platform account: literal 'ubuntu', uid/gid 1000, home /home/ubuntu — the identity every family
# image ships, so one account names them all and a DevEnvironment states it once
# (spec.runtime.user: ubuntu). The workspace PVC mounts at the home, so nothing durable is baked
# under it; ~/.ssh exists only so the account's own `ssh-copy-id` target exists when no PVC is
# attached.
RUN groupadd -g 1000 ubuntu \
    && useradd -u 1000 -g 1000 -s /bin/bash -d /home/ubuntu ubuntu \
    && mkdir -p /home/ubuntu/.ssh \
    && chown -R 1000:1000 /home/ubuntu \
    && chmod 700 /home/ubuntu/.ssh

# No host keys in the image: identity comes from the mounted Secret. Their absence is also what
# tells the entrypoint whether ssh is enabled.
# /run/sshd is the privilege separation directory a *root* sshd requires and a non-root one never
# consults - the apt package relies on the init system to create it, which a container has none of
# (see common/sshd/10-devenv.conf).
RUN rm -f /etc/ssh/ssh_host_* \
    && mkdir -p -m 0700 /run/sshd

# The vendor base ships no launcher and no ENTRYPOINT, so the platform supplies both the
# entrypoint and the jupyter launch chain it hands off to — the latter shared with the other two
# family images, common/jupyter/start-jupyter.sh.
COPY common/entrypoint.sh /usr/local/bin/cubestack-entrypoint.sh
COPY common/jupyter/start-jupyter.sh /usr/local/bin/start-jupyter.sh
# Shared sshd config (common/), installed by the script that also owns its placeholders: this
# image's ssh login account (which must match USER below) and the session environment. The
# vendor's PATH, loader and linker paths and the MACA variables are named here so the ssh
# session carries the same toolchain the container runs with — sshd replaces a session's
# environment, so anything not named is simply absent (see the drop-in and the script).
ARG SSH_USER=ubuntu
COPY common/sshd/10-devenv.conf /etc/ssh/sshd_config.d/10-devenv.conf
COPY common/sshd/install-dropin.sh /tmp/install-dropin.sh
RUN chmod +x /usr/local/bin/cubestack-entrypoint.sh /usr/local/bin/start-jupyter.sh \
    && sh /tmp/install-dropin.sh "${SSH_USER}" \
         PATH LD_LIBRARY_PATH LIBRARY_PATH MACA_PATH MACA_CLANG_PATH TORCH_ALLOW_TF32_CUBLAS_OVERRIDE \
    && rm -f /tmp/install-dropin.sh

# The vendor's LD_LIBRARY_PATH and MACA_PATH are inherited from the base, and its PATH is carried
# with conda prepended (above): together they are what put the MACA stack on the account's search
# path, which a non-root login needs exactly as the vendor's root shell did.
ENV CUBESTACK_IMAGE=jupyter \
    HOME=/home/ubuntu

WORKDIR /home/ubuntu
USER 1000:1000
EXPOSE 8888 2222
ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/cubestack-entrypoint.sh"]
CMD ["/usr/local/bin/start-jupyter.sh"]
