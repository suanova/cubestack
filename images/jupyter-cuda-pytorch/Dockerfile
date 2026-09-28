# Cubestack 'jupyter-cuda-pytorch' DevEnvironment image — NVIDIA NGC PyTorch base.
#
# Serves BOTH services from one container, like the CPU jupyter-minimal overlay: JupyterLab on
# 8888 (the jupyter type's main port, which readiness probes) and sshd on the unprivileged 2222,
# started only when the operator mounted the ssh host key (mode jupyter, common/entrypoint.sh).
#
# Unlike the MACA overlay, this one is thin: the base is not a bare vendor SDK but NVIDIA's own
# PyTorch image, which already ships the interpreter, the framework, JupyterLab and the account
# the platform's contract names. What it adds is the platform layer — openssh-server, the shared
# entrypoint and sshd drop-in, the shared jupyter launcher, and the baked CUBESTACK_IMAGE:
#
#   the account       uid/gid 1000 'ubuntu', home /home/ubuntu. Inherited, not created: it is
#                     exactly the self-authored family's identity, so the Dockerfile must NOT
#                     useradd over it (groupadd would fail on the GID it already holds).
#   the interpreter   one python 3.12 at /usr/bin/python3, with torch in its dist-packages and
#                     /usr/local/bin/jupyter shebanged to it. No second interpreter, so no PATH
#                     correction is needed, and nothing is installed from pip.
#   the kernel        the base's kernelspec names a bare `python`, which jupyter_client rewrites
#                     to the server's own sys.executable — so a cell runs on the same interpreter
#                     the server does, torch included.
#   jupyter's config  /usr/local/etc/jupyter/jupyter_notebook_config.py: ip 0.0.0.0, port from
#                     JUPYTER_PORT, allow_root, no browser. It names no root_dir, so the launcher
#                     below is the only thing that decides where notebooks land.
#
# Not used: the base's ENTRYPOINT (/opt/nvidia/nvidia_entrypoint.sh) is displaced below. It prints
# the NVIDIA banners and copyrights, runs the GPU driver / SM / MOFED / CPU diagnostics, and execs
# its own arguments — informative, but not something a DevEnvironment's pod log is for, and the
# entrypoint that decides what a Cubestack container runs is the platform's.
#
# No key staging: the operator mounts two Secret entries and sshd reads them in place —
#   ssh_host_ed25519_key -> /etc/ssh/ssh_host_ed25519_key   (host identity, subPath file)
#   authorized_keys      -> /run/ssh/authorized_keys        (platform keys, directory mount)
#
# Build context MUST be images/ (not this directory) so common/ is COPYable.
#   docker build --platform linux/amd64 -f jupyter-cuda-pytorch/Dockerfile \
#     -t harbor.isuanova.com/suanova/jupyter-cuda-pytorch:<tag> images/
#   (or: make -C images build-cuda)

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
# the CPU jupyter image: this overlay installs nothing from pip — JupyterLab here is the base's.
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
# tells the entrypoint whether ssh is enabled. (The apt package above may generate a set of its own,
# so this comes after it.)
# /run/sshd is the privilege separation directory a *root* sshd requires and a non-root one never
# consults - the apt package relies on the init system to create it, which a container has none of
# (see common/sshd/10-devenv.conf).
RUN rm -f /etc/ssh/ssh_host_* \
    && mkdir -p -m 0700 /run/sshd

# The platform's entrypoint replaces the vendor's, and hands off to the shared launcher.
COPY common/entrypoint.sh /usr/local/bin/cubestack-entrypoint.sh
COPY common/jupyter/start-jupyter.sh /usr/local/bin/start-jupyter.sh
# Shared sshd config (common/), installed by the script that also owns its placeholders: this
# image's ssh login account (which must match USER below) and the session environment. The vendor's
# PATH, loader and linker paths and CUDA_HOME are named here so the ssh session carries the same
# toolchain the container runs with — sshd replaces a session's environment, so anything not named
# is simply absent (see the drop-in and the script). The list stops at what puts the stack on a
# session's search path: /usr/local/cuda/bin and /usr/local/nvidia/bin, torch's own lib directory,
# the CUDA stubs a build links against, and the TF32 override the container itself runs with.
ARG SSH_USER=ubuntu
COPY common/sshd/10-devenv.conf /etc/ssh/sshd_config.d/10-devenv.conf
COPY common/sshd/install-dropin.sh /tmp/install-dropin.sh
RUN chmod +x /usr/local/bin/cubestack-entrypoint.sh /usr/local/bin/start-jupyter.sh \
    && sh /tmp/install-dropin.sh "${SSH_USER}" \
         PATH LD_LIBRARY_PATH LIBRARY_PATH CUDA_HOME TORCH_ALLOW_TF32_CUBLAS_OVERRIDE \
    && rm -f /tmp/install-dropin.sh

# The vendor's PATH, LD_LIBRARY_PATH and LIBRARY_PATH are inherited from the base: they are what
# put the CUDA stack on the account's search path, which a non-root login needs exactly as the
# vendor's root shell did.
ENV CUBESTACK_IMAGE=jupyter \
    HOME=/home/ubuntu

WORKDIR /home/ubuntu
USER 1000:1000
EXPOSE 8888 2222
ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/cubestack-entrypoint.sh"]
CMD ["/usr/local/bin/start-jupyter.sh"]
