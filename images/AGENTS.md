# AGENTS.md

This file applies ONLY to the `images/` directory.

For platform-wide principles, see `../AGENTS.md`.

## Scope

Container images that back the DevEnvironment `type`/image contract served by the
`operator/` (see `operator/internal/controller/devenvironment_controller.go` and
`docs/design/devenv-images/decision.md`). Images belong to **two families** — the split is by
whose layout an image keeps, and the families are **not** conformed to one layout:

- **Self-authored** images ship the platform default: account `ubuntu`, uid/gid **1000**, home/workdir
  **`/home/ubuntu`**. Three members, all differing only in their base and their mode:
  `ssh-ubuntu22.04` (CPU, on `ubuntu:22.04`, ssh), `jupyter-maca-pytorch` (GPU, on a vendor's Metax
  MACA base, jupyter+sshd) and `ssh-maca-pytorch` (the same GPU base, ssh alone). The two MACA images
  are separate repositories rather than one image with a mode flag, because the mode is baked
  (`CUBESTACK_IMAGE`) and the controller injects no type — see `images/README.md`.
- **Stock-derived** images keep their upstream-native layout **unchanged** and the overlay
  enables only ssh (e.g. `jupyter-minimal`: account `jovyan`, uid 1000 gid 100, home
  `/home/jovyan`, stock launch chain). The platform is told about that layout per environment,
  through the DevEnvironment spec — no image metadata is read.

A self-authored image on a **vendor base** is the one case where the overlay is not small: a vendor GPU
base is not a distro, and may ship no account, no sshd, no ENTRYPOINT and no launcher at all (the MACA
one ships none of them). The account is the platform's regardless — the shared sshd drop-in is a
non-root configuration — and a missing launcher is the image's to supply.

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
  A vendor base published per architecture (the MACA package's `-amd64` suffix is part of its tag, not
  a multi-arch index) cannot follow `$(PLATFORM)` at all: it has no layers for any other architecture
  to build from, so the two MACA images' `build-maca` / `build-ssh-maca` (and their `push-` forms) take
  `$(MACA_PLATFORM)` and publish a single-platform index. That exception belongs to the image, not the
  host — do not fold it back into `PLATFORMS`.
- **Keep ignore rules in `images/.dockerignore`** (deny-by-default). Docker only honors the
  context-root ignore file; a per-subdir `.dockerignore` is inert and misleading.
- **Shared runtime logic lives in `common/`**: `entrypoint.sh` (mode selection + optional sshd +
  hand-off to the image CMD) and `sshd/` (the drop-in, where the mount contract's paths are fixed, and
  the installer that fills it in). The drop-in carries two per-family placeholders: the ssh login
  account `@SSH_USER@` (`ARG SSH_USER`) and the session environment `@SSH_ENV@`, which
  `sshd/install-dropin.sh` builds from the variable names each Dockerfile passes it, read out of the
  build shell's environment — i.e. the image's own by then: the base's, plus whatever the overlay has
  set, which is how both MACA images get `/opt/conda/bin` onto a session's `PATH`. A placeholder is
  needed because sshd's `SetEnv`
  *replaces* the session environment, so a fixed literal would hide whichever family's toolchain it did
  not name; and it reaches past `PATH`, since the MACA images need their loader, linker and compiler
  variables there too. A missed `@SSH_USER@` fails *closed* (sshd denies every login, and the smoke says
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
  The vendor base is pinned the same way but stops at `images/Makefile`: it is mirrored as it stands
  under `$(REGISTRY)/mirrors/<vendor host>/…` rather than re-published under `$(PROJECT)`, so it has no
  `BASE_MIRRORS` entry and `BASE_ARGS=` reaches no upstream for it — a MACA build overridden that way
  needs an explicit `--build-arg MACA_BASE=<ref>`.
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
make -C images smoke-maca # one image: --ssh / --jupyter / --maca / --ssh-maca select one
```

`PLATFORM` takes a single value; a list fails in `check-platform` with that reason. On a host of a
different architecture the build (and the smoke's throwaway containers) run emulated — slower, but
they exercise the artifact that is actually published. Both MACA images ignore all of this and build
`$(MACA_PLATFORM)`, `linux/amd64` by default, on every host and for every publish — see the platform
rule. Their published name is the pair's other exception: the tag is `MACA_TAG`, the vendor axes read
out of `MACA_PACKAGE` with `$(TAG)` after them, not `$(TAG)` alone (README, Publish; decision doc §5).

`PLATFORMS` is the publish list for the same reason, and `make push PLATFORMS=linux/amd64` narrows it
back to one. `push` is a `buildx build --push`, so it needs a builder that can do more than one
platform (Docker Desktop's can; otherwise `docker buildx create --use` plus QEMU) — `push-maca` and
`push-ssh-maca` are the targets that do not, since a single-platform push builds on any builder. It does
**not** push the
image the local smoke ran — buildx cannot load a multi-platform result and push it in one invocation,
so it builds a fresh one from the same source.

`make -C images smoke` is the acceptance gate, and which images it covers is a rule rather than a
hand-kept list: `hack/changed-images.sh` answers "which images does this diff reach", and
`ci-operator.yml` asks it — in place of a paths filter — what a pull request must smoke. Each image
depends on its own directory, on `common/`, on the `Makefile` and `.dockerignore`, and on the CI that
builds, smokes and publishes it — the two workflows and the `changed-images` action both of them
delegate to, which is what picks the diff base and the flags that size a publishing leg; a Dockerfile
never `COPY`s from a sibling image's directory, which is what makes the
answer derivable from a changed path alone, and `make -C images check-deps` is what asserts that
convention rather than assuming it. A changed path under `images/` the rule does not recognise
selects **every** image and says so on stderr — over-selecting costs a rebuild, under-selecting
ships a stale image — and markdown selects nothing. It returns two selections, not one: the images
to smoke are a superset of the images to build, because a change to `hack/smoke.sh` rebuilds
nothing while re-verifying everything. `make -C images check-select` runs the rule's fixtures, and
`ci-operator.yml`'s `images-check` job runs both checks.

`images-smoke` builds and smokes exactly that selection, on a pull request or a `release-*` push —
the run which gates the content, since on `main` it would smoke the tree the pull request already
smoked — and a change that reaches no image skips it. A merge is what `ci-images.yml` publishes, as
**one job per image**, and it asks the same rule: the selection *is* the job matrix, so an image the
merge did not reach has no job at all rather than a skipped one, claims no runner and enters no
concurrency group. Each leg smokes the image it is about to publish and then withholds `:latest`
unless main's copy of what that image is built from still matches this commit's — those paths read
from `changed-images.sh paths <image>` rather than written out, so a job's trigger paths, its gate
and its `retag-latest` set are one set by construction, and a gate cannot withhold a tag that no
later run would move. A `vX.Y.Z` tag publishes every image at the version it names and moves no
`:latest`; it does so without consulting the rule, a release being no kind of change. The smoke
itself needs no cluster and no registry credentials: every image is built for linux/amd64 and run as
throwaway containers on 127.0.0.1.

That last point is where the MACA images are expensive: their shared vendor base is a 10.5 GiB pull
and about **33 GB unpacked**, which is what a runner has to hold — twice over, if the image the smoke
built and the one `push` builds land in different stores. That is what the steps answer: a vendor leg
reclaims the runner's preinstalled SDKs first (`.github/actions/reclaim-disk`, because ~31 GB free is
less than one of these images), and smokes *before* `Set up Buildx`, so `docker build` loads into the
engine's builder — the store `docker run` reads — and then pushes **out of that same builder**,
because a MACA build is single-platform and the default `docker` driver both pushes one and builds in
the engine's store. The push reads back what the smoke just pulled and built instead of repeating
both (a second pull of that base measured at 590s, and the build it feeds). `Drop what the smoke
built`, `Set up QEMU` and `Set up Buildx` are the CPU legs' steps and all three are keyed off the
same `vendor` flag the selector puts on each matrix leg: they exist because the container driver
`Set up Buildx` installs builds in a store of its own — which the CPU pair needs for its amd64+arm64
index, and which a vendor leg would need a second ~33 GB of runner disk to keep. Nothing pays that
cost unless it can
change a MACA image. One job per image is what keeps it that way: a merge that reaches only a CPU
image, only the smoke harness or only markdown schedules no vendor build at all, and the two vendor
images get a whole runner's disk each rather than sharing one. The reclaim and the long timeout are
the vendor legs' alone too — the CPU pair is a fraction of that base (`ssh-ubuntu22.04` measures 132
MB). The other side of that split is that the two vendor legs no longer share a runner's layer store,
so a merge reaching both runs the base's pull on two runners in parallel where one lane ran it twice
on one; the exchange is the disk, the CPU legs' 1m41s and the fact that a merge reaching one of them
pays for one. Both families are still in the `build` / `smoke` / `push`
aggregators, because an image that is never built is never checked and a local `make smoke` still
means all four; if that cost ever outweighs the coverage, the lever is to drop `build-maca` /
`build-ssh-maca` from the aggregators and run `smoke-maca` / `smoke-ssh-maca` by hand — not to leave
their `push-` forms out of `push`, which would publish nothing.
