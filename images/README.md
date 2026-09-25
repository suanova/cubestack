# images/ — DevEnvironment base images

Container images that back the DevEnvironment `type`/image contract served by the `operator/`.
See `docs/design/devenv-images/decision.md` for the sourcing/composition decision and
`operator/internal/controller/devenvironment_controller.go` for the authoritative contract.

## Two image families

Images are **not** all conformed to a single layout. The decision doc splits them into two families,
by whose layout they keep:

- **Self-authored** images ship the platform default: account `ubuntu` (uid/gid **1000**), home and
  workdir **`/home/ubuntu`** (where the workspace PVC mounts). Five members share that layout —
  `ssh-ubuntu22.04` on `ubuntu:22.04` (CPU, ssh only), the Metax pair `jupyter-maca-pytorch` and
  `ssh-maca-pytorch` on a vendor MACA base, and the NVIDIA pair `jupyter-cuda-pytorch` and
  `ssh-cuda-pytorch` on a vendor CUDA one — though neither the size of the overlay that produces it
  nor whether the account is even the platform's to create (below).
- **Stock-derived** images keep their upstream native layout **unchanged**; the overlay enables only
  ssh. The platform is told about that layout per environment, through the DevEnvironment spec — no
  image metadata is read.

| Image | Family | Base | Account (uid:gid) | Home / workspace | Exposes | ssh login |
|-------|--------|------|-------------------|------------------|---------|-----------|
| `harbor.isuanova.com/suanova/ssh-ubuntu22.04` | self-authored | `ubuntu:22.04` | `ubuntu` 1000:1000 | `/home/ubuntu` | ssh `2222` | `ubuntu` |
| `harbor.isuanova.com/suanova/jupyter-minimal` | stock-derived | `quay.io/jupyter/minimal-notebook:2026-09-07` | `jovyan` 1000:100 | `/home/jovyan` | jupyter `8888`, ssh `2222` | `jovyan` |
| `harbor.isuanova.com/suanova/jupyter-maca-pytorch` | self-authored | `maca-pytorch:3.9.0.12-torch2.4-py310-ubuntu22.04-amd64` (mirror of `cr.metax-tech.com/public-library/…`) | `ubuntu` 1000:1000 | `/home/ubuntu` | jupyter `8888`, ssh `2222` | `ubuntu` |
| `harbor.isuanova.com/suanova/ssh-maca-pytorch` | self-authored | *(the same MACA mirror)* | `ubuntu` 1000:1000 | `/home/ubuntu` | ssh `2222` | `ubuntu` |
| `harbor.isuanova.com/suanova/jupyter-cuda-pytorch` | self-authored | `pytorch:26.08-py3` (mirror of `nvcr.io/nvidia/pytorch`) | `ubuntu` 1000:1000 | `/home/ubuntu` | jupyter `8888`, ssh `2222` | `ubuntu` |
| `harbor.isuanova.com/suanova/ssh-cuda-pytorch` | self-authored | *(the same NVIDIA mirror)* | `ubuntu` 1000:1000 | `/home/ubuntu` | ssh `2222` | `ubuntu` |

The `jupyter-minimal` overlay adds **only** `openssh-server` and a launcher on top of the stock image:
same account, home, conda stack, and jupyter settings, and the stock launch chain
(`tini → start.sh → start-notebook.py`) for the stock account — the launcher is the root case's.

`jupyter-maca-pytorch` is the same family as `ssh-ubuntu22.04` but not the same size of overlay: a
vendor GPU base is not a distro, so the platform layer there is the whole of it. The base runs as
**root** (no `config.User`), has no `ENTRYPOINT` at all (`Cmd: ["/bin/bash"]`, so it exits immediately),
no sshd, no jupyter, and no non-root account — the account is the platform's even though the base has
none, because the shared sshd drop-in is a non-root configuration. The base also carries no launcher,
so the platform supplies one — `common/jupyter/start-jupyter.sh`, shared with the CUDA image below —
which is the piece `jupyter-minimal` still gets from docker-stacks. And the base publishes one
architecture per tag (the `-amd64` suffix
is part of the package name, not a multi-arch index), so this image is **amd64-only** and is published
on its own platform variable — see Platform.

`ssh-maca-pytorch` is that image's sibling: the identical vendor base and platform layer, with no
JupyterLab and no launcher. The split is forced by where the mode comes from — `CUBESTACK_IMAGE` is
**baked into the image**, because the operator injects no type (`common/entrypoint.sh`), so one image
cannot serve both. A `type: ssh` environment pointed at the jupyter image would run JupyterLab beside
sshd and have nothing probing it; pointed here, it runs sshd alone. The same split already exists on
the CPU side, as `ssh-ubuntu22.04` against `jupyter-minimal`.

`jupyter-cuda-pytorch` / `ssh-cuda-pytorch` are the same pair for the other vendor, on NVIDIA's own
PyTorch image, and they are the **thinnest overlay here**: the base is not a bare vendor SDK but a
distribution built for the purpose, so it already ships the account (`ubuntu`, uid/gid 1000, home
`/home/ubuntu` — the platform's own default layout, so the Dockerfile inherits it rather than creating
it), one python 3.12 with torch installed into it, JupyterLab on that same interpreter, and a jupyter
config that names neither a root directory nor a token. What the overlay adds is the platform layer
and nothing else: `openssh-server`, the shared entrypoint and sshd drop-in, the shared launch chain,
and the baked `CUBESTACK_IMAGE`. Nothing is installed from pip — the JupyterLab the notebook runs on
is the base's — and because there is only one interpreter there is no `PATH` for a launcher to
correct, which is the whole shape of the MACA overlay. The vendor's `ENTRYPOINT`
(`/opt/nvidia/nvidia_entrypoint.sh`: banners, then the GPU/driver diagnostics, then `exec "$@"`) is
displaced by the platform's, losing no mechanism the runtime needs.

The CUDA pair is **amd64-only** like the MACA pair, though for the opposite reason: the MACA vendor
publishes one architecture per tag, while this base reaches us as a **mirror whose manifest lists
`linux/amd64` alone**. Both therefore build and publish on their own platform variable — see Platform.
The base's GPU-side properties are the same kind of thing as MACA's and untestable here: the CUDA
runtime is baked, and whether the node's driver satisfies it is a node-side question.

## Configuring a DevEnvironment for these images

No image's layout is discoverable from the cluster: the operator takes the run-as identity, the
workspace mount path, and the ssh login account from the **DevEnvironment spec**. Pointing an
environment at a shipped image therefore means stating what the image already is:

| Image | `spec.runtime.user` | `spec.runtime.securityContext` | Workspace mount |
|-------|--------------------|-------------------------------|-----------------|
| `ssh-ubuntu22.04` | `ubuntu` | *(omit — 1000:1000 is already the platform default)* | `/home/ubuntu` (derived) |
| `jupyter-minimal` | `jovyan` | `runAsGroup: 100` | `/home/jovyan` (derived) |
| `jupyter-maca-pytorch` | `ubuntu` | *(omit — 1000:1000)* | `/home/ubuntu` (derived) |
| `ssh-maca-pytorch` | `ubuntu` | *(omit — 1000:1000)* | `/home/ubuntu` (derived) |
| `jupyter-cuda-pytorch` | `ubuntu` | *(omit — 1000:1000)* | `/home/ubuntu` (derived) |
| `ssh-cuda-pytorch` | `ubuntu` | *(omit — 1000:1000)* | `/home/ubuntu` (derived) |

What the controller derives when a field is omitted
(`operator/internal/controller/devenvironment_controller.go`, `resolveMountPath` / `runtimeUser`):

- **Workspace mount** — `spec.storage.mountPath` when set, else `/root` for an environment running as
  root (`securityContext.runAsUser: 0`), else `/home/<user>` when `spec.runtime.user` names an
  account, else `/workspace`.
- **ssh login** — `spec.runtime.user`, else the platform default `user`.

So `spec.runtime.user` alone yields the right mount for every image. `runAsGroup: 100` has to be set
explicitly for `jupyter-minimal`: no other spec field implies the stock `gid 100`, and the default is
1000. A bring-your-own image whose home is somewhere else pins it with `spec.storage.mountPath`, which
always wins.

A **root** environment (`spec.runtime.securityContext.runAsUser: 0`) is the case this table does not
cover, since the identity comes from the security context rather than from `runtime.user`: the derived
mount is `/root`, and the container is told as much — the controller states the mount path as `HOME`
on every environment with a workspace claim, so no image has to infer it (see Runtime behavior below).

A GPU image additionally has to be requested as one: the brand gate runs only when an environment asks
for a vendor, and it requires the image's name to carry that vendor's token (`cuda` for `nvidia`,
`maca` for `metax`) — all four vendor image names do, so `spec.resources.gpu.vendor: metax` reaches
the MACA pair and `nvidia` the CUDA pair. The gate is not what keeps a CPU environment off them
either: an environment with no `gpu` block skips the check, and the reason not to point one at a
vendor image is that its stack exists for the GPU.

## Runtime behavior common to every image

- Single container, **no command/args** — the image ENTRYPOINT decides what runs
  (`common/entrypoint.sh`): mode `ssh` runs sshd; mode `jupyter` starts sshd alongside jupyter when the
  host key is mounted, then hands off to the image CMD (the image's own launch chain, below). The mode
  comes from `CUBESTACK_IMAGE`, baked into each image; the controller never selects it.
- Readiness = TCP listening on the image's main port (8888 / 2222).
- sshd listens on the **unprivileged `2222`**, never `:22`: a non-root process cannot bind a privileged
  port without `CAP_NET_BIND_SERVICE`, so no image needs that capability granted. The platform's
  Service carries `port: 22` → `targetPort: 2222`, which is invisible to users — the ssh endpoint is
  published through the Gateway's TCP listener pool, not on 22 either way.
- ssh is enabled by the presence of the mounted host key file — images ship no host keys of their own,
  and there is no key staging (see the mount contract below).
- sshd runs as the container's uid, which bounds what it can serve: at uid 1000 that is the image's own
  account, and at uid 0 (`spec.runtime.securityContext.runAsUser: 0`) it is `root`. The ssh endpoint
  address names the account to log in as — `spec.runtime.user` when it is set, else the platform default
  `user`, and `root` for a root environment whatever the spec names, since root is the only account the
  platform can promise there.
- Jupyter is stock-native where the base already is one — `jupyter-minimal` keeps docker-stacks' chain,
  adding only the root branch below — and platform-launched where it is not: neither vendor base brings
  a launch chain (the MACA one has no JupyterLab at all, the CUDA one ships JupyterLab but no command
  that starts it), so both vendor jupyter images run the same launcher,
  `common/jupyter/start-jupyter.sh`. Either way the two knobs are `JUPYTER_TOKEN` (token) and
  `NOTEBOOK_ARGS` (extra flags, e.g. `--ServerApp.base_url=…`). The token is read by jupyter-server
  itself; `NOTEBOOK_ARGS` is a docker-stacks convention jupyter knows nothing about, which is why a
  launcher has to expand it — the shared vendor launcher is that launcher, while the CPU one hands off
  to the stock chain that already does. A **root** environment is
  handed more than those two: the controller adds `NB_USER`, `NB_UID`, `NB_GID` and, into the same
  `NOTEBOOK_ARGS`, `--allow-root` (`::withRootLauncherEnv`). A launcher that reads none of the trio may
  ignore it — neither jupyter launcher consults it at uid 0 — but a Jupyter launcher that ignores
  `--allow-root` will not start as root at all. The **home** is no longer a launcher decision either:
  the controller states the mount path as `HOME` on every environment with a workspace claim, so a root
  environment is handed root's own `/root` — the home it derives for `runAsUser: 0` and mounts the
  claim at — with nothing left for a launcher to work out. What each launcher keeps is a guard for the
  one environment the controller says nothing about: a jupyter environment with no `spec.storage`, and
  so no claim to be its home. There the container carries the home the image bakes — and at uid 0 the
  wrong one — until the spec declares one of its own. `jupyter-minimal` keeps uid 0 out of
  docker-stacks' `start.sh` for that, since that launcher relocates root's home to `/home/root`
  whatever the environment declares, which is what a root environment there used to state
  `HOME=/home/root` for. Either way a `HOME` that is not the image's own is left standing: it is the
  controller's, or on a claim-less environment the spec's.

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
(`/home/ubuntu` for `ubuntu`, `/home/jovyan` for `jovyan`), and it is where the workspace PVC mounts:
the controller states the mount path as `HOME`, so pinning `spec.storage.mountPath` elsewhere (see
above) moves the container's home with the workspace rather than leaving the two apart. sshd
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
- **Set the Secret `defaultMode` from the reading uid, not from the file.** OpenSSH enforces its
  private-key permission check only on a file owned by the uid reading it, and a Secret volume
  materialises its files root-owned — so the mode a reader tolerates follows **who the reader is**.
  A uid-1000 sshd is not the owner: it is never checked, and it cannot read a file it does not own, so
  the host key has to stay `0644`; at `0600`/`0400` it exits with *no hostkeys available*. A root sshd
  (`spec.runtime.securityContext.runAsUser: 0`) **is** the owner, so the check applies and `0644` is
  refused outright — *Permissions 0644 … are too open* — which the `jupyter` entrypoint turns into a
  failed start rather than a dead endpoint. The controller renders `0600` for a root environment and
  `0644` otherwise (`::desiredPodSpec`); the authorized keys take the same mode, since one sshd reads
  both under one ownership.
- **Create `/run/sshd` in the image.** A root sshd refuses to start without its privilege separation
  directory, and refuses it *before* loading a host key; a non-root sshd never consults one. The apt
  package leaves the directory to the init system, which a container has none of, so each image's
  Dockerfile creates it root-owned.
- **Mount the PVC at the account's home** — the controller derives it from `spec.runtime.user` (see
  above), unless the spec pins an explicit `mountPath`, which wins — so the workspace is durable
  there, and it states that same path as the container's `HOME`, so a launcher that serves `$HOME`
  serves the workspace. The ssh keys are mounted at absolute paths and so follow no home at all; sshd
  resolves `%h` from the account's passwd entry for its own `AuthorizedKeysFile` entry.
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
make -C images build     # every image, tagged $(REGISTRY)/$(PROJECT)/<image>:$(TAG) (see Publish)
make -C images smoke     # build + local Docker smoke (no cluster)
```

Per-image: `make -C images build-ssh` / `smoke-ssh`, `build-jupyter` / `smoke-jupyter`,
`build-maca` / `smoke-maca`, `build-ssh-maca` / `smoke-ssh-maca`, `build-cuda` / `smoke-cuda`,
`build-ssh-cuda` / `smoke-ssh-cuda`.

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
  the served host key equal to the mounted Secret public key. Root mode adds the one thing this image
  does not leave to docker-stacks: a root run serves `/root` — the home the platform derives, and so
  where the claim is mounted — rather than the `/home/root` the stock `start.sh` relocates to, and a
  declared `HOME` is served unchanged.
- **jupyter-maca-pytorch** — the same jupyter and ssh assertions at the platform identity (uid/gid
  1000, `$HOME`/cwd `/home/ubuntu`, login account `ubuntu`), plus that the vendor stack under
  `/opt/maca` is **readable by uid 1000**. That last one is checkable without a GPU and is the risk
  that would otherwise surface only on a node: the base was built as root, and a library the account
  cannot read fails at runtime with no build-time signal. Whether the *driver* works on a Metax node
  is not covered here. Root mode adds one check that is this image's own work and not docker-stacks':
  a root run serves `/root` — the home the platform derives, and so where the claim is mounted —
  rather than the `/home/ubuntu` the image bakes, and a declared `HOME` is served unchanged.
- **ssh-maca-pytorch** — the same ssh assertions at the same identity and the same vendor-stack
  check, plus the two properties that make it a separate image rather than a copy: **no JupyterLab
  exists in it** (the guard against its sibling's pip step being copied across, which would silently
  put an unprobed second service in an ssh-type environment), and its ssh session **environment
  equals the container's own** — sshd's `SetEnv` replaces the image's rather than extending it, so the
  smoke reads it back over the session and compares it variable by variable (see the drop-in note
  under Layout). Also that the MACA toolchain actually resolves on that session's PATH.
- **jupyter-cuda-pytorch** — the same jupyter and ssh assertions at the same platform identity, and the
  base's own contribution asserted by **running** it rather than by reading the filesystem, which is
  what the base's shape allows: its stack is installed into the distribution's python rather than
  dropped under `/opt`, so the check is that the account's own `python3` imports torch, and that a
  notebook **cell** lands on that same interpreter. The second half is worth the machinery: the base's
  kernelspec names a bare `python`, which jupyter_client rewrites to the *server's* `sys.executable`,
  so the kernel follows the server and torch follows only if the server has it. The question is put to
  jupyter_client's own `format_kernel_cmd`, which is pure python — no kernel start, so it answers under
  emulation, where a real cell does not complete. Root mode is the shared launcher's, as on the other
  jupyter images.
- **ssh-cuda-pytorch** — the same ssh assertions and the same torch check, plus the property that makes
  it a separate image, asked of the **process tree** rather than of the binary: this base *does* ship
  JupyterLab, so its absence would prove nothing, and what the baked mode decides is whether anything
  runs it. An ssh-type environment here must show no notebook server, and a container that cannot
  report its own processes fails rather than passes. Its ssh session also carries the CUDA toolkit
  (`/usr/local/cuda/bin`) and torch's libraries on `LD_LIBRARY_PATH` — the naming being the whole reason
  that session has the stack at all.

**Not asserted, deliberately: `nvidia-smi`.** It comes from driver injection at container start, so a
check of it would be a check of the node rather than of the image; the CUDA runtime's compatibility with
a given node's driver is the same node-side question the MACA pair leaves open (decision doc §3.A).

### Publish

Each image has **one name**: `make build` tags it at the reference it is published under,
`$(REGISTRY)/$(PROJECT)/<image>:$(TAG)`, defaulting to `harbor.isuanova.com/suanova/...` and the short
commit SHA — plus, for the vendor pairs, the axes their base is chosen on (decision doc §5).
`push` adds `:latest` to that same name rather than introducing a
second one, and publishes it as **one multi-arch index per image** covering `$(PLATFORMS)` — except
the two vendor pairs, which publish a single-platform index (see Platform):

```bash
docker login harbor.isuanova.com              # once — the Makefile never authenticates
make -C images push                           # publish every image
make -C images push-ssh      TAG=20260910
make -C images push-jupyter  TAG=2026-09-07
make -C images push-maca     # jupyter-maca-pytorch:3.9.0.12-py310-torch2.4-<sha>
make -C images push-ssh-maca # ssh-maca-pytorch:3.9.0.12-py310-torch2.4-<sha>
make -C images push-cuda     # jupyter-cuda-pytorch:26.08-<sha>
make -C images push-ssh-cuda # ssh-cuda-pytorch:26.08-<sha>
make -C images push PLATFORMS=linux/amd64     # narrow back to one platform
```

`push` is a single `docker buildx build --push` per image: it does **not** depend on `make build`, and
it does not push the image sitting in the local store. buildx cannot load a multi-platform result into
the local store and push it in the same invocation, so the published layers are a **fresh build of the
same source** rather than the very image the smoke ran. That is why the smoke's acceptance carries over
only as far as the Dockerfile and context are unchanged — run `make -C images smoke` first; it is the
acceptance gate, but `push` neither runs it nor waits on it.

`:latest` is the one tag `make build` never produces, so finding it locally means it came from a
publish.

`TAG` defaults to the short commit SHA (`git rev-parse --short HEAD`), so a bare `make build` yields a
traceable, non-floating reference. It names the **last commit, not the working tree** — commit before
publishing, or the tag will not describe the built content — and it is resolved per make invocation, so
a commit landing after `make smoke` would have `make push` publish a tag nothing accepted; pass an
explicit TAG. §5 gives the release schemes per image — `ssh-ubuntu22.04:<date>`,
`jupyter-minimal:<base-date>`, `jupyter-maca-pytorch` / `ssh-maca-pytorch` on
`<maca-version>-py<python>-torch<ver>`, and `jupyter-cuda-pytorch` / `ssh-cuda-pytorch` on
`<ngc-release>-<sha>` — the families version on different axes, hence the per-target form. Neither
pair's axes are a `TAG` the caller passes: `MACA_TAG` reads them out of `MACA_PACKAGE` and `CUDA_TAG`
its release out of `CUDA_PACKAGE`, so a tag cannot name a base the image was not built from, and `TAG`
still ends it — re-building an overlay on an unchanged base moves the reference rather than redefining
it. There is one axis for CUDA rather than three because the NGC release pins python, torch and CUDA
together, so naming it names all of them. All four targets refuse to publish (`check-maca-base` /
`check-cuda-base`) if a base bump lands a package tag the axes cannot be read from.

A deployment tracking `:latest` follows the newest publish while a pinned one keeps its SHA/release
tag; publishing an older commit therefore moves `:latest` backwards, which is expected for a moving
tag but worth knowing before rebuilding a previous release. `REGISTRY` / `PROJECT` relocate the whole
destination.

### Platform

`make build` and `make smoke` work on **one** platform, `$(PLATFORM)`, default `linux/amd64` — the
architecture the cluster's nodes run. The CPU Dockerfiles start from a multi-arch base (`ubuntu`,
`quay.io/jupyter`), so without `--platform` `docker build` resolves that base to the **host**
architecture: a build on an arm64 machine produces an arm64-only image, which every amd64 node then
refuses to pull (`no match for platform in manifest`). The Makefile passes `--platform` on every build,
so the result does not depend on the architecture of the machine building it. `PLATFORM=linux/arm64` is
the explicit opt-in to build for a different architecture; it takes one value (a list fails in
`check-platform`, since a single `docker build` loads exactly one image into the local store). On a host
of another architecture the build and the smoke's throwaway containers run emulated — slower, but they
exercise the artifact that is actually published.

`make push` is the other flow: it builds for every platform in `$(PLATFORMS)`, default
`linux/amd64 linux/arm64`, and publishes the results as one index. A node then pulls the manifest for
its own architecture, so an arm64 laptop can run what an amd64 cluster runs. It needs a builder capable
of more than one platform — Docker Desktop's is; on a plain `docker` install run
`docker buildx create --use` and provide QEMU (`docker/setup-qemu-action` in CI), or the build fails on
the non-native platform. Both flows drop buildx's provenance and SBOM attestations: Harbor rejects an
index carrying them with a 404 on the manifest PUT even though every manifest it references resolves on
its own.

`jupyter-maca-pytorch` / `ssh-maca-pytorch` and `jupyter-cuda-pytorch` / `ssh-cuda-pytorch` sit outside
both flows' platform choice, on the same grounds: neither vendor base has an arm64 manifest to build
from — the MACA vendor publishes one architecture per tag, the NVIDIA mirror lists `linux/amd64` alone —
so `build-maca` / `build-ssh-maca` always pass `$(MACA_PLATFORM)` and `build-cuda` / `build-ssh-cuda`
always pass `$(CUDA_PLATFORM)`, both defaulting to `linux/amd64`, rather than `$(PLATFORM)`; their push
targets publish that one platform rather than `$(PLATFORMS)`, which is a single-platform index buildx
supports. They are the images whose architecture is a property of the image rather than of the host or
the platform list, and each vendor pair has its own variable for it: `MACA_PLATFORM=` / `CUDA_PLATFORM=`
are what move them, and `PLATFORMS=` does not reach them.

Verify what a registry received rather than assuming the build host's architecture:

```bash
docker buildx imagetools inspect --raw harbor.isuanova.com/suanova/ssh-ubuntu22.04:latest
```

### Overrides / mirror builds (CN or offline)

Every build resolves `FROM` this registry's mirrored copies of the upstream bases — they live in
the shared `$(MIRROR_PROJECT)` project, each repo named for the upstream reference it holds —
`$(REGISTRY)/$(MIRROR_PROJECT)/quay.io/jupyter/minimal-notebook:<base-date>` and
`…/docker.io/library/ubuntu:$(UBUNTU_VERSION)`, passed through `BASE_ARGS`. Building from the
mirror keeps the published image descended from the
base the platform serves, where `FROM ubuntu:22.04` would silently give whatever upstream has
retagged it to — and it is the only copy that resolves where upstream is unreachable. Each is
pinned by the digest of the mirror's index, and the digest is what the build resolves:
`operator/hack/mirror-e2e-images.sh` repoints those tags, so on the tag alone the same commit
could publish different base layers under one `TAG`. Bumping a base is therefore deliberate —
read the new digest, update `images/Makefile` and `BASE_MIRRORS` in `operator/Makefile`, then
re-run the mirror script, which fails if a mirrored tag no longer hashes to the digest it is
listed under. `BASE_ARGS=` (empty) resolves from upstream instead, unpinned. The jupyter mirror's
date tracks the base in `jupyter/Dockerfile` — bump both together.

The **vendor bases** ride the same `BASE_ARGS` and are pinned the same way, but each differs on two
counts, both of which follow from its being a **vendor package mirrored as it stands** rather than a
base the platform re-published: each lives under `$(REGISTRY)/$(MIRROR_PROJECT)/<vendor registry>/…`,
not under `$(PROJECT)` — `…/cr.metax-tech.com/public-library/…` for MACA,
`…/nvcr.io/nvidia/pytorch:26.08-py3` for CUDA — so they are named literally in `images/Makefile` and
have no entry in `operator/Makefile`'s `BASE_MIRRORS`; and `BASE_ARGS=` does not reach an upstream for
them — neither vendor registry is something a build here resolves — so a MACA or CUDA build overridden
that way needs an explicit `--build-arg MACA_BASE=<ref>` / `--build-arg CUDA_BASE=<ref>` in its place.
Bumping either stops at `images/Makefile`.

APT and pip still go upstream unless asked otherwise (the CUDA overlay installs nothing from pip, so
`PIP_INDEX_URL` does not reach it):

```bash
APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports \
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
make -C images build
```

`IMG_SSH` / `IMG_JUPYTER` / `IMG_MACA` / `IMG_SSH_MACA` / `IMG_CUDA` / `IMG_SSH_CUDA` override the
output tags (`MACA_TAG` / `CUDA_TAG` the axes the vendor pairs derive); `BASE_ARGS` the base images
(above); `CONTAINER_TOOL` overrides `docker` (e.g. `podman`); `PLATFORM` the build/smoke architecture,
`PLATFORMS` what `push` publishes, and `MACA_PLATFORM` / `CUDA_PLATFORM` the one architecture each
vendor pair builds and publishes for (see Platform).

## Layout

```
images/
  common/                  runtime config shared across the images (single source)
    entrypoint.sh          mode selection + optional sshd (admits root when it runs as root),
                           then hand-off to the image CMD
    jupyter/start-jupyter.sh  the vendor jupyter images' CMD: the launch chain both vendor
                           bases lack, which neither ships a command for
    sshd/10-devenv.conf    sshd_config.d drop-in; @SSH_USER@ login account, @SSH_ENV@ session env
    sshd/install-dropin.sh fills both placeholders in, or fails the build
  ssh-ubuntu-server/Dockerfile
  jupyter/
    Dockerfile             stock-native overlay
    start-jupyter.sh       the CMD: the stock chain, and root's own home for uid 0
  jupyter-maca-pytorch/
    Dockerfile             platform layer on the Metax MACA vendor base
  ssh-maca-pytorch/
    Dockerfile             the same base and platform layer, with sshd alone
  jupyter-cuda-pytorch/
    Dockerfile             platform layer on the NVIDIA NGC PyTorch base
  ssh-cuda-pytorch/
    Dockerfile             the same base and platform layer, with sshd alone
  hack/smoke.sh            local acceptance smoke
```

The sshd_config drop-in is **shared**: it holds the mount contract's paths (`HostKey`,
The sshd_config drop-in is **shared**: it holds the mount contract's paths (`HostKey`,
`AuthorizedKeysFile`, the latter `%h`-relative so it follows each image's home) and two placeholders,
both filled in at build time by `common/sshd/install-dropin.sh` — which every Dockerfile that copies
the drop-in also copies in and calls, so the template cannot ship half-filled. The first is the login
account, `@SSH_USER@`, given as `ARG SSH_USER` (`ubuntu` / `jovyan`). A missed substitution is not a
parse error — `AllowUsers` is a valid keyword and the pattern simply matches no account — so it fails
*closed* for the family account: sshd starts but denies that login, and the smoke fails on its login
assertion. `root` is admitted **beside** the family account, because one image serves both identities
(see Requirements on the operator) — but by the entrypoint rather than by this file: it writes a
second drop-in, `20-allow-root.conf`, only when the container runs as `uid 0`. A non-root sshd cannot
setuid to root, so admitting it there would buy nothing and cost a login that is accepted and then
dies at `setresuid` (*Failed to set uids to 0.*) instead of being refused at authentication.
`AllowUsers` is one of the few sshd options that **accumulate** across files, so that drop-in adds to
this one rather than replacing it. A missed substitution therefore fails *closed* for the family
account — but only for it: the entrypoint's file is written from the uid and never consults the
substitution, so a root environment still serves `root`, and the login a broken substitution costs
you is the family one. The smoke's assertion on that login is what catches it.

In practice the family account is refused whenever the container is root, and the accumulation above is
not what decides it: docker-stacks leaves its build account locked in `/etc/shadow`, OpenSSH refuses a
locked account, and only a *root* sshd can read that file — so `getspnam` returns nothing to uid 1000 and
the non-root path never ran the check at all. Root mode thus serves `root` alone, the identity it
advertises; the family entry stays because it is what the non-root mode serves. Worth knowing because the
refusal is docker-stacks' and not ours: an image whose build account was unlocked would be served from a
root environment too, into the image's own `/home/$USER`, which in root mode is not the workspace claim.
(`passwd -S` reports both accounts as locked and cannot tell you which one sshd will refuse.)

The second is `@SSH_ENV@`, the `NAME=value` pairs for the drop-in's single `SetEnv`. Each Dockerfile
names the variables its session needs and the installer reads their values out of the build shell's
environment — the **image's own** by the time it runs, the base's plus whatever the overlay has set,
which is how the MACA pair gets `/opt/conda/bin` onto a session's `PATH` (see Trade-offs). A placeholder is needed at all because sshd's `SetEnv` *replaces*
a session's environment rather than adding to it, so a literal does not extend an image's environment,
it hides it; and no one literal fits every family, since the stock-derived image needs only its
conda-first `PATH` while each vendor base's session has to carry its whole toolchain — the MACA one's
(`PATH`, `LD_LIBRARY_PATH`, `LIBRARY_PATH`, `MACA_PATH`, `MACA_CLANG_PATH`) or the MACA tools and
compilers a user reaches that base over ssh *for* are silently absent, and the CUDA one's (`PATH`,
`LD_LIBRARY_PATH`, `LIBRARY_PATH`, `CUDA_HOME`, `TORCH_ALLOW_TF32_CUBLAS_OVERRIDE`) or neither the
toolkit nor torch's own libraries arrive. Unlike `@SSH_USER@`, a missed substitution
here fails *quiet*: the literal itself becomes a value and nothing downstream objects. Hence the
installer, which fails the build on an unset, empty or whitespace-carrying variable, on a placeholder
left behind, and on anything but exactly one `SetEnv` line — sshd applies the first and ignores the
rest without complaint — plus the smoke, which reads the session environment back and compares it to the
container's own variable by variable.

**Build context is `images/`** for every Dockerfile — that is why ignore rules live in the single
`images/.dockerignore` (deny-by-default) and why shared files are `COPY common/...`.

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
- Both MACA images inherit two properties of the vendor base worth knowing before they are trusted.
  Their **driver** is baked
  into the base (`/opt/mxdriver`) while a Metax node may inject its own; which one wins is untested, and
  the local smoke cannot answer it — that needs a node advertising `metax-tech.com/gpu`. And their python
  is the **vendor's**, which is the point: jupyterlab is installed into that interpreter so the torch
  that imports is the vendor's metax build, never a second interpreter beside it. The base ships that
  interpreter beside a system python that has none, and names it only from a login profile, so both
  overlays put `/opt/conda/bin` on `PATH` themselves — without that, a notebook cell or a
  non-interactive `ssh host 'python3 …'` reaches the interpreter with no torch while an interactive
  session works.
- The CUDA pair inherits a different base and with it a different set of unknowns. Its **account is the
  base's**, not the platform's — uid/gid 1000 `ubuntu` at `/home/ubuntu` happens to be exactly the layout
  this family wants, which is why the Dockerfile inherits it instead of creating it, and why a base that
  named its account differently would be a build failure rather than a quiet mismatch. Its JupyterLab is
  the base's too, on the same interpreter torch is installed into, so there is no second interpreter to
  prefer and no `PATH` correction to get wrong — the trap the MACA pair had. What it does not answer is
  again node-side: a driver has to satisfy the baked CUDA runtime, which no local smoke can see.
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
