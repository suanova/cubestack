# images/ — DevEnvironment base images

Container images that back the DevEnvironment `type`/image contract served by the `operator/`.
See `docs/design/devenv-images/decision.md` for the sourcing/composition decision and
`operator/internal/controller/devenvironment_controller.go` for the authoritative contract.

## Two image families

Images are **not** all conformed to a single layout. The decision doc splits them into two families:

- **Self-authored** images ship the platform default: account `ubuntu` (uid/gid **1000**), home and
  workdir **`/home/ubuntu`** (where the workspace PVC mounts).
- **Stock-derived** images keep their upstream native layout **unchanged**; the overlay enables only
  ssh. The platform is told about that layout per environment, through the DevEnvironment spec — no
  image metadata is read.

| Image | Family | Base | Account (uid:gid) | Home / workspace | Exposes | ssh login |
|-------|--------|------|-------------------|------------------|---------|-----------|
| `harbor.isuanova.com/suanova/ssh-ubuntu22.04` | self-authored | `ubuntu:22.04` | `ubuntu` 1000:1000 | `/home/ubuntu` | ssh `2222` | `ubuntu` |
| `harbor.isuanova.com/suanova/jupyter-minimal` | stock-derived | `quay.io/jupyter/minimal-notebook:2026-09-07` | `jovyan` 1000:100 | `/home/jovyan` | jupyter `8888`, ssh `2222` | `jovyan` |

The `jupyter-minimal` overlay adds **only** `openssh-server` on top of the stock image: same account,
home, conda stack, launcher (`tini → start.sh → start-notebook.py`), and jupyter settings.

## Configuring a DevEnvironment for these images

Neither image's layout is discoverable from the cluster: the operator takes the run-as identity, the
workspace mount path, and the ssh login account from the **DevEnvironment spec**. Pointing an
environment at either shipped image therefore means stating what the image already is:

| Image | `spec.runtime.user` | `spec.runtime.securityContext` | Workspace mount |
|-------|--------------------|-------------------------------|-----------------|
| `ssh-ubuntu22.04` | `ubuntu` | *(omit — 1000:1000 is already the platform default)* | `/home/ubuntu` (derived) |
| `jupyter-minimal` | `jovyan` | `runAsGroup: 100` | `/home/jovyan` (derived) |

What the controller derives when a field is omitted
(`operator/internal/controller/devenvironment_controller.go`, `resolveMountPath` / `runtimeUser`):

- **Workspace mount** — `spec.storage.mountPath` when set, else `/root` for an environment running as
  root (`securityContext.runAsUser: 0`), else `/home/<user>` when `spec.runtime.user` names an
  account, else `/workspace`.
- **ssh login** — `spec.runtime.user`, else the platform default `user`.

So `spec.runtime.user` alone yields the right mount for both images. `runAsGroup: 100` has to be set
explicitly for `jupyter-minimal`: no other spec field implies the stock `gid 100`, and the default is
1000. A bring-your-own image whose home is somewhere else pins it with `spec.storage.mountPath`, which
always wins.

## Runtime behavior common to both images

- Single container, **no command/args** — the image ENTRYPOINT decides what runs
  (`common/entrypoint.sh`): mode `ssh` runs sshd; mode `jupyter` starts sshd alongside jupyter when the
  host key is mounted, then hands off to the image CMD (the stock launch chain for jupyter).
- Readiness = TCP listening on the image's main port (8888 / 2222).
- sshd listens on the **unprivileged `2222`**, never `:22`: a non-root process cannot bind a privileged
  port without `CAP_NET_BIND_SERVICE`, so no image needs that capability granted. The platform's
  Service carries `port: 22` → `targetPort: 2222`, which is invisible to users — the ssh endpoint is
  published through the Gateway's TCP listener pool, not on 22 either way.
- ssh is enabled by the presence of the mounted host key file — images ship no host keys of their own,
  and there is no key staging (see the mount contract below).
- sshd runs as the container account (uid 1000): a non-root sshd can only serve the uid it runs as,
  so the only login account is the image's own, and the resolved account has to name it — that is
  `spec.runtime.user` when it is set, else the platform default `user`.
- Jupyter is stock-native: the overlay adds no jupyter logic. `JUPYTER_TOKEN` (token) and
  `NOTEBOOK_ARGS` (extra flags, e.g. `--ServerApp.base_url=…`) are honored by the upstream launcher.

## ssh Secret mount contract

The operator mounts **two ssh files** into the container — nothing is copied, staged, or
re-permissioned in the container. They come from **two Secrets with different owners**: the host
identity is always the controller's, while the authorized keys are the user's when
`spec.ssh.keysSecret` names a Secret and the controller's otherwise.

The host key is a `subPath` file, because sshd wants it at one exact path. The authorized keys are a
whole-Secret mount of the directory `/run/ssh`, with `items` renaming the selected data key to
`authorized_keys`. The container sees the same absolute paths either way; the difference is that
Kubernetes updates an ordinary Secret mount in place, while a `subPath` file stays frozen at container
start (see the operator requirements below).

| Mounted at | Secret key | Secret | Used by |
|------------|-----------|--------|---------|
| `/etc/ssh/ssh_host_ed25519_key` (`subPath`) | `ssh_host_ed25519_key` | `<env>-ssh-host-key` (controller-minted) | sshd host identity; its presence gates ssh |
| `/run/ssh/authorized_keys` | the entry the volume takes, renamed to `authorized_keys` | `spec.ssh.keysSecret`, else `<env>-ssh-authorized-keys` (controller-minted) | keys that may log in |

The entry the volume takes is the one the user's selector names when `spec.ssh.keysSecret` is set, and
`id_ed25519.pub` in the controller-minted case — the public half of the generated login keypair, taken
straight out of the Secret rather than copied to a second entry first. `status.sshKeysSecret` names
that Secret, so it is what a user reads to find where their login keys live. The controller-minted
Secret holds the keypair and nothing else: `id_ed25519`, the private half the user retrieves to log in,
and `id_ed25519.pub`. The volume maps that single entry and no other, so **the generated login private
key never enters the container**.

The private key has to be in **OpenSSH's own format** (`-----BEGIN OPENSSH PRIVATE KEY-----`): sshd
does not read a PKCS#8 Ed25519 key at all, and exits with *invalid format* if handed one. The
`.pub` is informational — sshd derives the public half from the private key.

Both mount paths are **absolute and outside `$HOME`**, so neither depends on the account an image runs
as, and the account's own `~/.ssh` is left to the account. `$HOME` is that account's home
(`/home/ubuntu` for `ubuntu`, `/home/jovyan` for `jovyan`); the workspace PVC mounts there when the path
is derived — an explicit `spec.storage.mountPath` is authoritative and may point elsewhere (see above),
in which case `$HOME` stays on the container's own filesystem and only the workspace is durable. sshd
reads both files in place via the drop-in's `HostKey` and
`AuthorizedKeysFile /run/ssh/authorized_keys %h/.ssh/authorized_keys` — the second path is the user's
own file, so `ssh-copy-id` and similar tools keep working alongside the platform keys. No `.pub` and no
host-key-per-algorithm files are needed: sshd derives the public half from the private key.

The platform keys deliberately do **not** live in `$HOME`, where the images bake `~/.ssh`: the workspace
claim is mounted over the home, its root is not writable by the account, and the runtime creates a file
mount target's parent directory root-owned — so keys mounted there would sit in a directory the account
cannot write, alongside the account's own files it could not add. Under `/run` the platform keys stay
out of the user's way entirely, and `~/.ssh` is the account's own (the controller's init container is
what makes the claim, and so that directory, writable at all — see the operator requirement below).

That second path is a **deliberate, bounded trade-off**: the account that can write it is the one sshd
serves (a non-root sshd can serve no other) and `AllowUsers` fixes the login account, so a key left
there yields a login as the uid that already owns the workspace — not a new privilege. `StrictModes yes`
would not close it either, since it accepts a key file owned by the account doing the reading; it is
`no` here because the workspace PVC mounted at `%h` may not carry modes sshd demands. Restricting logins
to operator-issued keys only would mean dropping this path (and `ssh-copy-id` with it) — a product
decision, not a tightening the drop-in can make on its own.

The operator must ensure the host-key Secret always exists and carries `ssh_host_ed25519_key`; images
have no fallback identity and fail fast without it (`ssh` mode exits; `jupyter` simply starts without
sshd).
A host key that is mounted but unusable is **not** that case: `jupyter` mode runs `sshd -t` before
backgrounding sshd and exits if it fails, rather than serving a ready notebook with a dead ssh endpoint.

### Requirements on the operator

Implemented in **#173**; the controller code is in `operator/internal/controller/devenvironment_controller.go`.

- **Mint the host key in OpenSSH format.** `::generateSSHKeyPair` writes the private key as an
  OpenSSH-format PEM block — sshd rejects a PKCS#8 Ed25519 key, so a Secret carrying one leaves the
  environment with no ssh at all. The controller regenerates such a key in place when it finds one,
  which the revision annotation below then rolls the pod onto.
- **Restart the workload only when the host key changes.** Kubernetes does not propagate Secret
  updates to `subPath` mounts — the container keeps the bytes it started with
  ([Secret docs](https://kubernetes.io/docs/concepts/configuration/secret/)) — so a repaired host key
  is inert until the pod is recreated. The controller stamps its digest on the pod template
  (`ai.cubestack.io/ssh-keys-revision`, from `::sshHostKeyDigest`), which changes the StatefulSet's
  spec hash and rolls the pod — the same mechanism the Jupyter token uses. The **authorized keys need
  no such roll**: they are an ordinary Secret mount, so kubelet delivers a rotation to the running
  container within its sync period, and the controller deliberately keeps them out of the digest so
  adding a colleague's key does not restart anyone's session. It still watches Secrets, mapping one
  back to every environment whose `spec.ssh.keysSecret` names it, to re-check a reference that has been
  undelegated or had its entry removed.
- **Keep the files readable by the container uid.** The default Secret `defaultMode` `0644` is
  correct: the files are root-owned, and OpenSSH only enforces its private-key permission check on
  files owned by the uid reading them, so a uid-1000 sshd accepts a root-owned `0644` host key.
  Tightening `defaultMode` to `0600`/`0400` makes the key unreadable to that uid and sshd exits with
  *no hostkeys available*.
- **Mount the PVC at the account's home** — the controller derives it from `spec.runtime.user` (see
  above), unless the spec pins an explicit `mountPath`, which wins — so the workspace is durable
  there. The ssh keys are mounted at absolute paths and so follow no home at all; sshd resolves `%h`
  from the account's passwd entry for its own `AuthorizedKeysFile` entry.
- **Initialize the workspace claim's ownership.** A workspace claim mounts `root:root` and a non-root
  account can write nothing in it — no `~/.ssh`, no workspace files at all. The controller runs an init
  container before the environment starts (`::desiredPermissionInitContainer`) that chowns the claim
  root to the identity the container runs as (`spec.runtime.securityContext`, platform default
  1000:1000). It is deliberately not a pod-level `fsGroup`: that would chown every read-write volume in
  the pod, including a referenced PVC the platform does not own. It mounts the workspace claim and
  nothing else, repairs that claim's owner (and, on a mismatch, everything under it, as
  `fsGroupChangePolicy: OnRootMismatch` did), and leaves a directory the runtime creates *after* it runs
  alone — which is why the platform keys are mounted outside `$HOME` rather than into it, and why the
  account's own `~/.ssh` no longer needs anything mounted at all.
- **Publish the container's `2222`** as the Service's ssh port (`port: 22`, `targetPort: 2222`) and
  point the readiness probe at `2222` — the probe targets the container, not the Service.

## Build & smoke

```bash
make -C images build     # both images, tagged $(REGISTRY)/$(PROJECT)/<image>:$(TAG) (see Publish)
make -C images smoke     # build + local Docker smoke (no cluster)
```

Per-image: `make -C images build-ssh` / `smoke-ssh`, `build-jupyter` / `smoke-jupyter`.

The smoke runs throwaway containers on `127.0.0.1` (ephemeral ports, fake ssh Secrets under
`mktemp -d`) and asserts:
- **ssh-ubuntu22.04** — key-auth ssh login as `ubuntu`, uid 1000, group `ubuntu`, `$HOME`/cwd
  `/home/ubuntu`, and the served host key equals the mounted Secret public key (host keys persist via
  the Secret, not the image).
- Docker has no `subPath`, so the smoke reproduces the mount contract with bind mounts — the host key
  as a file, the authorized keys as a directory holding a single `authorized_keys` entry (the shape the
  operator's `items` mapping produces); see the fidelity note under Trade-offs.
- **jupyter-minimal** — one container running both services at native identity (uid 1000, gid 100):
  token auth returns 200 and lab HTML on the `NOTEBOOK_ARGS` `base_url` path; no token is rejected;
  the path without the prefix is 404; plus key-auth ssh login as `jovyan` (`$HOME=/home/jovyan`) with
  the served host key equal to the mounted Secret public key.

### Publish

Each image has **one name**: `make build` tags it at the reference it is published under,
`$(REGISTRY)/$(PROJECT)/<image>:$(TAG)`, defaulting to `harbor.isuanova.com/suanova/...` and the short
commit SHA (decision doc §5). `push` adds `:latest` to that same reference rather than introducing a
second name:

```bash
docker login harbor.isuanova.com           # once — the Makefile never authenticates
make -C images push                        # build, then publish both images
make -C images push-ssh      TAG=20260910
make -C images push-jupyter  TAG=2026-09-07
```

`push` depends on the build, then **adds the moving `:latest` to the built image** and pushes both
references. `:latest` is the one tag `make build` never produces, so finding it locally means it came
from a publish. The smoke is the acceptance gate but not a prerequisite of `push` — run
`make -C images smoke` first.

`TAG` defaults to the short commit SHA (`git rev-parse --short HEAD`), so a bare `make build` yields a
traceable, non-floating reference. It names the **last commit, not the working tree** — commit before
publishing, or the tag will not describe the built content — and it is resolved per make invocation, so
a commit landing between `make build` and `make push` makes the two disagree; let `make push` do both, or
pass an explicit TAG. §5 gives the release schemes per image — `ssh-ubuntu22.04:<date>` and
`jupyter-minimal:<base-date>` — the two families version on different axes, hence the per-target form.

A deployment tracking `:latest` follows the newest publish while a pinned one keeps its SHA/release
tag; publishing an older commit therefore moves `:latest` backwards, which is expected for a moving
tag but worth knowing before rebuilding a previous release. `REGISTRY` / `PROJECT` relocate the whole
destination.

### Platform

Every published image is built for `$(PLATFORM)`, default `linux/amd64` — the architecture the
cluster's nodes run. Both Dockerfiles start from a multi-arch base (`ubuntu`, `quay.io/jupyter`), so
without `--platform` `docker build` resolves that base to the **host** architecture: a build on an
arm64 machine produces an arm64-only image, which every amd64 node then refuses to pull
(`no match for platform in manifest`). The Makefile passes `--platform` on every build, so the result
does not depend on the architecture of the machine building it. `PLATFORM=linux/arm64` is the explicit
opt-in to build for a different architecture; it takes one value (a list fails in `check-platform`,
since a single `docker build` cannot produce a manifest list). On a host of another architecture the
build and the smoke's throwaway containers run emulated — slower, but they exercise the artifact that
is actually published.

Verify what a registry received rather than assuming the build host's architecture:

```bash
docker buildx imagetools inspect --raw harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest
```

### Overrides / mirror builds (CN or offline)

```bash
APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports \
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
make -C images build
```

`IMG_SSH` / `IMG_JUPYTER` override the output tags; `CONTAINER_TOOL` overrides `docker` (e.g. `podman`);
`PLATFORM` the build architecture (see Platform).

## Layout

```
images/
  common/                  runtime config shared by both images (single source)
    entrypoint.sh          mode selection + optional sshd, then hand-off to the image CMD
    sshd/10-nonroot.conf   sshd_config.d drop-in; AllowUsers is @SSH_USER@
  ssh-ubuntu-server/Dockerfile
  jupyter/Dockerfile
  hack/smoke.sh            local acceptance smoke
```

The sshd_config drop-in is **shared**: it holds the mount contract's paths (`HostKey`,
`AuthorizedKeysFile`, the latter `%h`-relative so it follows each image's home) and the login account as
an `@SSH_USER@` placeholder, which each Dockerfile substitutes from its `ARG SSH_USER` (`ubuntu` /
`jovyan`). A missed substitution is not a parse error — `AllowUsers` is a valid keyword and the pattern
simply matches no account — so it fails *closed*: sshd starts but denies every login, and the smoke
fails on its login assertion. **Build context is `images/`** for every Dockerfile
— that is why ignore rules live in the single `images/.dockerignore` (deny-by-default) and why shared
files are `COPY common/...`.

## Trade-offs / notes

- The `jupyter-minimal` overlay is intentionally thin: identical stock layout, sshd only. Tokens and the
  URL prefix flow through stock env (`JUPYTER_TOKEN`, `NOTEBOOK_ARGS`); the operator injects the
  `base_url` prefix into `NOTEBOOK_ARGS` (Gap C / decision doc §8), replacing a `base_url` the
  environment declares while keeping its other notebook flags. Its native `gid 100` and `/home/jovyan`
  are what a DevEnvironment has to be configured with (see above).
- sshd binds the unprivileged `2222`, so the images need **no capability at all** — design Gap B
  (`NET_BIND_SERVICE`) is closed by port choice rather than by granting a privilege. Two things follow:
  the operator must set the Service's `targetPort` to `2222` (#173), and a local smoke cannot validate
  the port privilege anyway — Docker writes `ip_unprivileged_port_start=0` into every container netns,
  so a container there can bind `:22` with no capability, while a pod's own netns defaults to `1024`.
- The jupyter container runs at its native gid 100 while the operator defaults `runAsGroup` to 1000, so
  the environment has to set `securityContext.runAsGroup: 100` — nothing else in the spec implies it.
  Self-authored images stay on the platform uid/gid defaults (1000:1000).
- The workspace PVC mounts at the account's home (`/home/ubuntu` self-authored; `/home/jovyan`
  jupyter, both derived from `spec.runtime.user` — an explicit `spec.storage.mountPath` overrides),
  where the notebook root already lives by default. An empty/root-owned PVC is storage-side (Gap A);
  the image cannot fix it, and readiness is TCP-only.
- **Smoke fidelity for the host-key mode.** Kubernetes projects Secret files root-owned `0644`, which a
  uid-1000 sshd accepts (the owner check applies only to a file owned by the uid doing the reading).
  Docker does not reproduce that faithfully: Docker Desktop reports a bind mount as root-owned `0600`
  yet lets any container uid read it, while a rootful Linux daemon keeps the host uid and modes — there
  the mounted `0600` key really is unreadable to uid 1000 and sshd exits with *no hostkeys available*.
  `hack/smoke.sh` therefore mounts the private key `0600` **and** asserts up front that the container
  uid can read it (`check_mount_readable`), so that environment mismatch is reported as itself rather
  than as a 30-second ssh timeout. The cluster path (`0644`, root-owned) was verified separately by
  hand; only the ownership the engine presents and enforces differs, not the image.
