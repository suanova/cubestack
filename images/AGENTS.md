# AGENTS.md

This file applies ONLY to the `images/` directory.

For platform-wide principles, see `../AGENTS.md`.

## Scope

Container images that back the DevEnvironment `type`/image contract served by the
`operator/` (see `operator/internal/controller/devenvironment_controller.go` and
`docs/design/devenv-images/decision.md`). Images belong to **two families** that are
**not** conformed to one layout:

- **Self-authored** images ship the platform default: account `ubuntu`, uid/gid **1000**, home/workdir
  **`/home/ubuntu`** (e.g. `ssh-ubuntu22.04`).
- **Stock-derived** images keep their upstream-native layout **unchanged** and the overlay
  enables only ssh (e.g. `jupyter-minimal`: account `jovyan`, uid 1000 gid 100, home
  `/home/jovyan`, stock launch chain). The platform is told about that layout per environment,
  through the DevEnvironment spec — no image metadata is read.

Every image:
- never sets command/args (the controller provides none) — the image ENTRYPOINT decides what
  runs (`common/entrypoint.sh`): mode `ssh` runs sshd; mode `jupyter` starts sshd only when the
  ssh host key is mounted, then hands off to the image CMD
- satisfies readiness = TCP listening on the image's main port (jupyter `8888`, ssh `2222`)
- reads the operator's ssh Secret **directly off subPath file mounts**, with no staging:
  `ssh_host_ed25519_key` at `/etc/ssh/ssh_host_ed25519_key` and `authorized_keys` at the absolute
  `/run/ssh/authorized_keys`, outside `$HOME` — a workspace claim may cover the home and the account
  may not be able to write it. The mounted host key is also the ssh-enabled signal — images ship no
  host keys of their own
- accepts its account, uid/gid, and home being named in the DevEnvironment spec
  (`spec.runtime.user`, `spec.runtime.securityContext`, `spec.storage.mountPath`) — `images/README.md`
  gives the values per image

## Rules

- **Build context is `images/`** for every Dockerfile. Build with
  `make -C images build` (or `docker build -f <img>/Dockerfile ... images/`). The shared logic under
  `common/` is `COPY`ed into each image from this context.
- **Name the platform on every build.** `make -C images build` builds `$(PLATFORM)`, default
  `linux/amd64` — the architecture the cluster's nodes run. A bare `docker build` resolves each
  multi-arch base (ubuntu, quay.io/jupyter) to the **host** architecture instead, which is how an
  arm64-only pair was once published and then failed on every amd64 node with *no match for platform
  in manifest*. Check what a registry actually received with
  `docker buildx imagetools inspect --raw <ref>` rather than assuming the build host's architecture.
- **Keep ignore rules in `images/.dockerignore`** (deny-by-default). Docker only honors the
  context-root ignore file; a per-subdir `.dockerignore` is inert and misleading.
- **Shared runtime logic lives in `common/`**: `entrypoint.sh` (mode selection + optional sshd +
  hand-off to the image CMD) and `sshd/10-nonroot.conf` (the sshd drop-in, where the mount
  contract's paths are fixed). The only per-family value in the drop-in is the ssh login account,
  kept as an `@SSH_USER@` placeholder that each Dockerfile substitutes from its `ARG SSH_USER` — so
  the shared parts cannot drift between families. Dockerfiles assemble packages, the overlay deltas,
  and the substitution.
- **The ssh material is mounted, never baked or staged.** Changing the mount paths means changing the
  drop-in (`HostKey`, `AuthorizedKeysFile`) *and* `images/README.md`'s contract table together, plus
  the operator's mount. Key material must stay readable by the container uid: `0644` root-owned is
  correct, tighter `defaultMode` breaks a non-root sshd.
- **Never commit secrets, private keys, or tokens.** Smoke-generated keys live only under `hack/` at
  runtime (`mktemp -d`) and are cleaned up.
- **English** code comments, commit messages, and docs.
- Reproducible base tags only; no floating tags. Mirror hooks are explicit build args
  (`APT_MIRROR`, `PIP_INDEX_URL`); nothing is baked that assumes a mirror.

## Build & smoke

```bash
make -C images build    # builds both images ($(PLATFORM), default linux/amd64), tagged
                        # $(REGISTRY)/$(PROJECT)/<image>:$(TAG)
make -C images smoke    # local Docker smoke (ssh key-auth login; jupyter + optional sshd)
make -C images push TAG=<tag>   # build, then add :latest to that image and push both refs to
                                # $(REGISTRY)/$(PROJECT); TAG defaults to the commit SHA
make -C images build PLATFORM=linux/arm64   # another architecture (explicit opt-in)
```

`PLATFORM` takes a single value; a list fails in `check-platform` with that reason. On a host of a
different architecture the build (and the smoke's throwaway containers) run emulated — slower, but
they exercise the artifact that is actually published.

There is no cluster and no CI wiring yet; `make -C images smoke` is the acceptance gate. When this
workspace gains CI, it must add a build + smoke job like the other sub-projects.
