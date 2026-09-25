# AGENTS.md

This file applies ONLY to the `images/` directory.

For platform-wide principles, see `../AGENTS.md`.

## Scope

Container images that back the DevEnvironment `type`/image contract served by the
`operator/` (see `operator/internal/controller/devenvironment_controller.go` and
`docs/design/devenv-images/decision.md`). Images belong to **two families** — the split is by
whose layout an image keeps, and the families are **not** conformed to one layout:

- **Self-authored** images ship the platform default: account `ubuntu`, uid/gid **1000**, home/workdir
  **`/home/ubuntu`**. Five members, differing only in their base and their mode:
  `ssh-ubuntu22.04` (CPU, on `ubuntu:22.04`, ssh), `jupyter-maca-pytorch` / `ssh-maca-pytorch` (GPU, on
  a vendor's Metax MACA base, jupyter+sshd and ssh alone) and `jupyter-cuda-pytorch` /
  `ssh-cuda-pytorch` (GPU, on the vendor's NVIDIA NGC PyTorch base, the same two modes). Each vendor
  pair is two repositories rather than one image with a mode flag, because the mode is baked
  (`CUBESTACK_IMAGE`) and the controller injects no type — see `images/README.md`.
- **Stock-derived** images keep their upstream-native layout **unchanged** and the overlay
  enables only ssh (e.g. `jupyter-minimal`: account `jovyan`, uid 1000 gid 100, home
  `/home/jovyan`, stock launch chain). The platform is told about that layout per environment,
  through the DevEnvironment spec — no image metadata is read.

A self-authored image on a **vendor base** is where the overlay's size varies most, because what the
base already ships is what decides it. The MACA base ships no account, no sshd, no `ENTRYPOINT` and no
launcher at all, so the platform layer there is the whole of it, account included. The NGC PyTorch base
ships the account (`ubuntu` 1000:1000 at `/home/ubuntu` — the platform default layout exactly), an
`ENTRYPOINT`, JupyterLab, and an interpreter with torch already in it, so its overlay adds the sshd
layer and the baked mode and nothing else. Two consequences for a new image either way: the account the
image runs under is the one the shared sshd drop-in is written for (the drop-in is a non-root
configuration, so a base that ships none gets it added and a base that ships one must keep it), and the
launch chain neither vendor base provides is shared under `common/` rather than written per image.

Every image:
- never sets command/args (the controller provides none) — the image ENTRYPOINT decides what
  runs (`common/entrypoint.sh`): mode `ssh` runs sshd; mode `jupyter` starts sshd only when the
  ssh host key is mounted, then hands off to the image CMD
- satisfies readiness = TCP listening on the image's main port (jupyter `8888`, ssh `2222`)
- reads the operator's ssh Secrets **directly off Secret mounts**, with no staging:
  `ssh_host_ed25519_key` at `/etc/ssh/ssh_host_ed25519_key` (a `subPath` file mount, since sshd wants
  one exact path) and the authorized-keys entry at the absolute `/run/ssh/authorized_keys` (a
  whole-Secret directory mount, whose `items` rename the selected entry to that filename) — outside
  `$HOME`, since a workspace claim may cover the home and the account may not be able to write it. The
  two files come from two Secrets (the controller's host-key Secret, and the user's or the controller's
  authorized-keys Secret), but the image sees only the two paths. The host key is a `subPath` mount and
  therefore frozen at container start; the authorized keys are an ordinary Secret mount, so a rotation
  reaches a running container without a restart. The mounted host key is also the ssh-enabled signal —
  images ship no host keys of their own
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
  A vendor base published per architecture cannot follow `$(PLATFORM)` at all: it has no layers for any
  other architecture to build from, so each vendor pair names its own — `build-maca` / `build-ssh-maca`
  (and their `push-` forms) take `$(MACA_PLATFORM)`, the CUDA pair's take `$(CUDA_PLATFORM)` — and all
  four publish a single-platform index. The two read alike but say so differently: the MACA package
  states it in the tag (`-amd64` is part of the tag, not a multi-arch index), the NGC PyTorch tag does
  not and the mirror carries one amd64 manifest inside an index shape. That exception belongs to the
  image, not the host — do not fold it back into `PLATFORMS`.
- **Keep ignore rules in `images/.dockerignore`** (deny-by-default). Docker only honors the
  context-root ignore file; a per-subdir `.dockerignore` is inert and misleading.
- **Shared runtime logic lives in `common/`**: `entrypoint.sh` (mode selection + optional sshd +
  hand-off to the image CMD), `sshd/` (the drop-in, where the mount contract's paths are fixed, and
  the installer that fills it in) and `jupyter/` (the launcher, which expands `NOTEBOOK_ARGS` into
  `--ServerApp.base_url` — one launcher for both vendor jupyter images rather than a copy per vendor,
  since it reads the base's environment rather than naming it). The drop-in carries two per-family
  placeholders: the ssh login
  account `@SSH_USER@` (`ARG SSH_USER`) and the session environment `@SSH_ENV@`, which
  `sshd/install-dropin.sh` builds from the variable names each Dockerfile passes it, read out of the
  build shell's environment — i.e. the image's own by then: the base's, plus whatever the overlay has
  set, which is how both MACA images get `/opt/conda/bin` onto a session's `PATH`. A placeholder is
  needed because sshd's `SetEnv`
  *replaces* the session environment, so a fixed literal would hide whichever family's toolchain it did
  not name; and it reaches past `PATH`, since the vendor images need their loader and compiler
  variables there too (`MACA_CLANG_PATH` / `LD_LIBRARY_PATH` for one, `CUDA_HOME` / `LD_LIBRARY_PATH`
  for the other). A missed `@SSH_USER@` fails *closed* (sshd denies every login, and the smoke says
  so); a missed `@SSH_ENV@` fails *quiet*, so the installer fails the build instead — keep every
  Dockerfile that copies the drop-in calling it. Dockerfiles assemble packages, the overlay deltas, and
  the substitutions. The drop-in admits the family account **only**: `root` is admitted by
  `entrypoint.sh` at startup, and only when the container runs as `uid 0`. Keep that split — a
  non-root sshd cannot setuid to root, so baking `root` in makes a non-root environment accept a
  root key and then die with *Failed to set uids to 0.*, where a refusal at authentication belongs.
- **The ssh material is mounted, never baked or staged.** Changing the mount paths means changing the
  drop-in (`HostKey`, `AuthorizedKeysFile`) *and* `images/README.md`'s contract table together, plus
  the operator's mount. Key material must stay readable by the container uid: the operator renders
  `0644` for a non-root `sshd` and `0600` when `securityContext.runAsUser: 0`, because a root `sshd`
  rejects `0644` root-owned files as too open, while a non-root one cannot read `0600` files it does
  not own. Changing the mode means changing that rendering in the controller too.
- **Never commit secrets, private keys, or tokens.** Smoke-generated keys live only under `hack/` at
  runtime (`mktemp -d`) and are cleaned up.
- **English** code comments, commit messages, and docs.
- Reproducible bases only; no floating tags, and every base the build resolves is pinned by digest.
  Every build resolves `FROM` this platform's mirrored copies of the upstream bases by default
  (`BASE_ARGS`), so the published image descends from the base the platform serves. The tag names
  that base; the digest is what the build resolves, because
  `operator/hack/mirror-e2e-images.sh` repoints those tags when someone here re-mirrors — on the
  tag alone the same revision could publish different base layers. Bumping a base is therefore a
  deliberate step: read the new digest, update `images/Makefile` and `BASE_MIRRORS` in
  `operator/Makefile` together, then re-run the mirror script, which fails if a mirrored tag no
  longer hashes to the digest it is listed under. Override with `BASE_ARGS=` to resolve `FROM`
  upstream instead, unpinned.
  The vendor bases are pinned the same way but stop at `images/Makefile`: they are mirrored as they
  stand under `$(REGISTRY)/$(MIRROR_PROJECT)/<vendor host>/…` rather than re-published under
  `$(PROJECT)`, so they have no `BASE_MIRRORS` entry and `BASE_ARGS=` reaches no upstream for them — a
  vendor build overridden that way needs an explicit `--build-arg MACA_BASE=<ref>` or
  `--build-arg CUDA_BASE=<ref>`.
  `APT_MIRROR` / `PIP_INDEX_URL` stay explicit build args, and nothing baked into the running
  image assumes a mirror.

## Build & smoke

```bash
make -C images build    # builds every image ($(PLATFORM), default linux/amd64), tagged
                        # $(REGISTRY)/$(PROJECT)/<image>:$(TAG)
make -C images smoke    # local Docker smoke (ssh key-auth login; jupyter + optional sshd)
make -C images push TAG=<tag>   # builds each image for every $(PLATFORMS) (default
                                # linux/amd64 linux/arm64) and pushes it as one multi-arch
                                # index carrying :TAG and :latest
make -C images build PLATFORM=linux/arm64   # another architecture (explicit opt-in)
make -C images smoke-maca # one image: --ssh / --jupyter / --maca / --ssh-maca / --cuda /
                         # --ssh-cuda select one
```

`PLATFORM` takes a single value; a list fails in `check-platform` with that reason. On a host of a
different architecture the build (and the smoke's throwaway containers) run emulated — slower, but
they exercise the artifact that is actually published. Both **vendor pairs** ignore all of this and
build their own single platform, `linux/amd64` by default, on every host and for every publish — see
the platform rule. Their published names are the pairs' other exception: the tag carries the vendor
axis read out of the base package with `$(TAG)` after it, not `$(TAG)` alone — `MACA_TAG`, three axes
(`3.9.0.12-py310-torch2.4`), and `CUDA_TAG`, the NGC release on its own (`26.08`), because that release
pins python, torch and CUDA together instead of naming them as separable axes (README, Publish;
decision doc §5).

`PLATFORMS` is the publish list for the same reason, and `make push PLATFORMS=linux/amd64` narrows it
back to one. `push` is a `buildx build --push`, so it needs a builder that can do more than one
platform (Docker Desktop's can; otherwise `docker buildx create --use` plus QEMU) — `push-maca`,
`push-ssh-maca` and the two CUDA pushes are the targets that do not, since a single-platform push
builds on any builder. It does **not** push the
image the local smoke ran — buildx cannot load a multi-platform result and push it in one invocation,
so it builds a fresh one from the same source.

`make -C images smoke` is the acceptance gate. `ci-operator.yml`'s `images-smoke` job runs the same
targets on a pull request that changes anything under `images/` that is not markdown — in two steps,
with `docker image prune -af` between them, because the two vendor bases do not both fit on one
runner — and that is the run which gates the content; on a merge it would smoke the tree the pull
request already smoked. A merge is what `ci-images.yml` publishes: three jobs split by image family,
`cpu` (ssh + jupyter), `maca` (the Metax pair) and `cuda` (the NVIDIA pair), each smoking what it is
about to publish and then withholding `:latest` unless main's copy of the paths that family is built
from still matches this commit's. A `vX.Y.Z` tag publishes all three families at the version it names
and moves no `:latest`. The smoke itself needs no cluster and no registry credentials: every image is
built for linux/amd64 and run as throwaway containers on 127.0.0.1.

That last point is where the vendor images are expensive: each vendor base is a ~10.5 GiB pull, about
**33 GB unpacked** for MACA and **38.6 GB** for CUDA, which is what a runner has to hold — twice over,
if the smoke's images and the `push` build's own store are both on it. That is what all three `images`
jobs answer: each reclaims the runner's preinstalled SDKs first (`.github/actions/reclaim-disk`,
because ~31 GB free is less than one of these images), and each smokes *before* `Set up Buildx` — so
`docker build` loads into the engine's builder, the store `docker run` reads — then drops what it built
before pushing, since the buildx builder has a store of its own. Nothing pays that cost unless it can
change a vendor image, which is what splitting the publish into three lanes buys: the `maca` job runs
only for a merge that touched `common/`, the `Makefile`, `.dockerignore`, `ci-images.yml` itself or one
of the two MACA directories, and the `cpu` and `cuda` jobs only for that same list with one of their
own directories in place of a MACA one. `common/` is in every list because all six Dockerfiles COPY
from it, and `ci-images.yml` is in every list because it is what defines them — so a merge that changes
only that file publishes all three families. Each list is also that lane's `:latest` gate pathspec, and
a lane's trigger paths, its gate and its `retag-latest` set have to be the same set, or a tag can be
withheld that no later run would move. Every family is still in the `build` / `smoke` / `push`
aggregators, because an image that is never built is never checked and a local `make smoke` still means
all six; if that cost ever outweighs the coverage, the lever is to drop `build-maca` /
`build-ssh-maca` (or the CUDA pair) from the aggregators and run those smokes by hand — not to leave
their `push-` forms out of `push`, which would publish nothing.
The two of a pair do not each pay for the base: they resolve the same pinned reference, so the second
build of a run reuses the first's layers rather than pulling again.
