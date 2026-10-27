# images/ — DevEnvironment base images

Container images that back the DevEnvironment `type` contract served by the `operator/`.
See `docs/design/devenv-images/decision.md` for the sourcing/composition decision,
`docs/design/devenv-images/image-contract.md` for the runtime contract, and
`operator/internal/controller/devenvironment_controller.go` for the authoritative behaviour.

## One image per (accelerator, stack) cell

The repositories are named `<accelerator>-<stack>` (decision doc §5.1). There are **three** images
today — the `pytorch` cell of each accelerator — and each serves **both** runtime modes:

- `cpu-pytorch` — CPU, built on `ubuntu:22.04`, with the CPU build of PyTorch;
- `maca-pytorch` — Metax/MACA, on a vendor MACA base with its `torch+metax`;
- `cuda-pytorch` — NVIDIA, on NVIDIA's NGC PyTorch base.

The split is by accelerator and stack, not by mode, because the mode is a **runtime** decision:
`spec.type` is injected by the controller as `CUBSTACK_TYPE`, and `common/entrypoint.sh`
runs JupyterLab or sshd from it. Before this, each family shipped two images that differed only
in a baked mode — 42.80 GiB of images in the offline package, where the merged set is about 21.4 GiB
(10.56 + 10.57 + 0.32 GiB, the CPU image measured with its PyTorch build). That matters because an
offline install ships every image; the merge cuts the naive
per-image package in half, and it removes the image-per-mode axis from the catalog, CI and docs.
(Unique-layer deduplication in the bundle itself is still #128's job.)

All three images ship the **same layout**, so the DevEnvironment spec states the same thing for
every one of them: account `ubuntu`, uid/gid **1000:1000**, home and workdir **`/home/ubuntu`**
(where the workspace PVC mounts). No image needs a `runAsGroup` override.

| Image | Base | Account (uid:gid) | Home / workspace | Modes | Exposes |
|-------|------|-------------------|------------------|-------|---------|
| `harbor.isuanova.com/suanova/cpu-pytorch` | `ubuntu:22.04` | `ubuntu` 1000:1000 | `/home/ubuntu` | jupyter + ssh | jupyter `8888`, ssh `2222` |
| `harbor.isuanova.com/suanova/maca-pytorch` | `maca-pytorch:3.9.0.12-torch2.4-py310-ubuntu22.04-amd64` (mirror of `cr.metax-tech.com/public-library/…`) | `ubuntu` 1000:1000 | `/home/ubuntu` | jupyter + ssh | jupyter `8888`, ssh `2222` |
| `harbor.isuanova.com/suanova/cuda-pytorch` | `pytorch:26.08-py3` (mirror of `nvcr.io/nvidia/pytorch`) | `ubuntu` 1000:1000 | `/home/ubuntu` | jupyter + ssh | jupyter `8888`, ssh `2222` |

The repositories the old images were published under keep their existing tags; they are simply
no longer published. A pinned `spec.image` keeps pulling. That includes `suanova/minimal` (this
family's original name) and `suanova/cpu-base` (its name in #336): the repository is named for the
accelerator and stack it serves, as the other two are, rather than for how small the image is.

`cpu-pytorch` is the thinnest overlay but no longer a bare ssh server: it is `ubuntu:22.04` plus
`openssh-server`, `python3`/`pip`, `sudo`, `tini`, the **CPU build of PyTorch**, **numpy** (torch's
array bridge) and **JupyterLab on the system interpreter**, with the shared launcher as its CMD.
Torch comes from PyTorch's own
`download.pytorch.org/whl/cpu` index rather than PyPI, whose linux wheel is the CUDA build this
family does not have; `TORCH_INDEX_URL` overrides that index for an offline mirror. It replaces
both `ssh-ubuntu22.04` (plain ssh) and `jupyter-minimal` (stock-derived, with the `jovyan` 1000:100
and `/home/jovyan` layout).

`maca-pytorch` is the same platform layer on a very different base: a vendor GPU base is not a
distro, so the platform layer there is the whole of it. The base runs as **root** (no
`config.User`), has no `ENTRYPOINT` at all (`Cmd: ["/bin/bash"]`, so it exits immediately), no
sshd, no jupyter, and no non-root account — the account is the platform's even though the base
has none, because the shared sshd drop-in is a non-root configuration. The base ships its
interpreter beside a system python that has no torch, and names it only from a login profile, so
this Dockerfile puts `/opt/conda/bin` on `PATH` itself before installing JupyterLab. The base
publishes one architecture per tag (the `-amd64` suffix is part of the package name, not a
multi-arch index), so this image is **amd64-only** — see Platform.

`cuda-pytorch` is the **thinnest overlay here**: the base is not a bare vendor SDK but a
distribution built for the purpose, so it already ships the account (`ubuntu`, uid/gid 1000, home
`/home/ubuntu` — the platform's own default layout, so the Dockerfile inherits it rather than
creating it), one python with torch installed into it, JupyterLab on that same interpreter, and a
jupyter config that names neither a root directory nor a token. What the overlay adds is the
platform layer and nothing else: `openssh-server`, the shared entrypoint and sshd drop-in, the
shared launch chain, and the baked `CUBESTACK_IMAGE`. Nothing is installed from pip — the
JupyterLab the notebook runs on is the base's — and because there is only one interpreter there
is no `PATH` for a launcher to correct, which is the whole shape of the MACA overlay. The
vendor's `ENTRYPOINT` (`/opt/nvidia/nvidia_entrypoint.sh`: banners, then the GPU/driver
diagnostics, then `exec "$@"`) is displaced by the platform's, losing no mechanism the runtime
needs.

`cuda-pytorch` is **amd64-only** like `maca-pytorch`, though for the opposite reason: the MACA
vendor publishes one architecture per tag, while this base reaches us as a **mirror whose
manifest lists `linux/amd64` alone**. Both therefore build and publish on their own platform
variable — see Platform. The base's GPU-side properties are the same kind of thing as MACA's and
untestable here: the CUDA runtime is baked, and whether the node's driver satisfies it is a
node-side question.

## Configuring a DevEnvironment for these images

No image's layout is discoverable from the cluster: the operator takes the run-as identity, the
workspace mount path, and the ssh login account from the **DevEnvironment spec**. Pointing an
environment at a shipped image therefore means stating what the image already is — and for these
three, that is the same statement every time:

| Image | `spec.runtime.user` | `spec.runtime.securityContext` | Workspace mount |
|-------|--------------------|-------------------------------|-----------------|
| `cpu-pytorch` | `ubuntu` | *(omit — 1000:1000 is already the platform default)* | `/home/ubuntu` (derived) |
| `maca-pytorch` | `ubuntu` | *(omit — 1000:1000)* | `/home/ubuntu` (derived) |
| `cuda-pytorch` | `ubuntu` | *(omit — 1000:1000)* | `/home/ubuntu` (derived) |

What the controller derives when a field is omitted
(`operator/internal/controller/devenvironment_controller.go`, `resolveMountPath` / `runtimeUser`):

- **Workspace mount** — `spec.storage.mountPath` when set, else `/root` for an environment running as
  root (`securityContext.runAsUser: 0`), else `/home/<user>` when `spec.runtime.user` names an
  account, else `/workspace`.
- **ssh login** — `spec.runtime.user`, else the platform default `user`.

So `spec.runtime.user: ubuntu` alone yields the right mount and login for every family image. A
bring-your-own image whose home is somewhere else pins it with `spec.storage.mountPath`, which
always wins.

A **root** environment (`spec.runtime.securityContext.runAsUser: 0`) is the case this table does not
cover, since the identity comes from the security context rather than from `runtime.user`: the derived
mount is `/root`, and the container is told as much — the controller states the mount path as `HOME`
on every environment with a workspace claim, so no image has to infer it (see Runtime behavior below).

A GPU image additionally has to be requested as one: the brand gate runs only when an environment asks
for a vendor, and it requires the image's name to carry that vendor's token (`cuda` or the
platform family name `cuda-pytorch` for `nvidia`, `maca` for `metax`) — both vendor image names do,
so `spec.resources.gpu.vendor: metax` reaches `maca-pytorch` and `nvidia` reaches `cuda-pytorch`. The gate is not what keeps a CPU environment off
them either: an environment with no `gpu` block skips the check, and the reason not to point one at a
vendor image is that its stack exists for the GPU.

## Runtime behavior common to every image

- Single container, **no command/args** — the image ENTRYPOINT decides what runs
  (`common/entrypoint.sh`). The mode is `CUBSTACK_TYPE`, which the controller injects from
  `spec.type`: `jupyter` starts sshd alongside JupyterLab when the host key is mounted, then hands
  off to the image CMD (the shared `common/jupyter/start-jupyter.sh`); `ssh` runs sshd in the
  foreground and never starts a notebook. An image run outside the platform falls back to the
  `CUBESTACK_IMAGE` baked into it (`jupyter` for all three); an unknown value exits non-zero
  rather than guessing.
- Readiness = TCP listening on the image's main port (8888 / 2222). A `type: ssh` environment is
  probed on 2222 and never 8888, which is why the ssh mode must not start a notebook at all — the
  merge makes that a runtime property to assert, not something the catalogue's image choice implies.
- sshd listens on the **unprivileged `2222`**, never `:22`: a non-root process cannot bind a privileged
  port without `CAP_NET_BIND_SERVICE`, so no image needs that capability granted. The platform's
  Service carries `port: 22` → `targetPort: 2222`, which is invisible to users — the ssh endpoint is
  published through the Gateway's TCP listener pool, not on 22 either way.
- All three images **install `sudo` and grant nothing**: sudo runs only for accounts a sudoers rule
  names, and the images name none. `spec.runtime.sudo: true` is what makes the account able to run
  commands as root inside the container — the controller writes the rule by uid and mounts it, so the
  image needs no change and an environment that does not ask is exactly as it was. A root environment
  already holds the privilege and renders no grant. See `image-contract.md`, Elevation, and
  `decision.md` Gap E.
- ssh is enabled by the presence of the mounted host key file — images ship no host keys of their own,
  and there is no key staging (see the mount contract below). In `ssh` mode a missing host key fails
  the container start rather than falling back to another mode; in `jupyter` mode it simply means no
  sshd beside the notebook.
- sshd runs as the container's uid, which bounds what it can serve: at uid 1000 that is the image's own
  account, and at uid 0 (`spec.runtime.securityContext.runAsUser: 0`) it is `root`. The ssh endpoint
  address names the account to log in as — `spec.runtime.user` when it is set, else the platform default
  `user`, and `root` for a root environment whatever the spec names, since root is the only account the
  platform can promise there.
- **No base ships a usable Jupyter launcher**: the CPU base has no notebook server before the pip
  install, the MACA base has no JupyterLab, and the CUDA base ships JupyterLab but no command that
  starts it. All three therefore run the same `common/jupyter/start-jupyter.sh`, whose two knobs are
  `JUPYTER_TOKEN` (token) and `NOTEBOOK_ARGS` (extra flags, e.g. `--ServerApp.base_url=…`). The token
  is read by jupyter-server itself; `NOTEBOOK_ARGS` is a docker-stacks convention jupyter knows
  nothing about, which is why the launcher has to expand it. A **root** environment is handed
  `--allow-root` in the same `NOTEBOOK_ARGS` (`::withRootLauncherEnv`), because jupyter-server refuses
  to start as root without it; the controller also injects `NB_USER`, `NB_UID` and `NB_GID` there for
  bring-your-own docker-stacks images, and none of the three family launchers consults the trio.
- The **home** is not a launcher decision: the controller states the mount path as `HOME` on every
  environment with a workspace claim, so a root environment is handed root's own `/root` — the home
  it derives for `runAsUser: 0` and mounts the claim at. What the launcher keeps is a guard for the
  one environment the controller says nothing about: a jupyter environment with no `spec.storage`,
  and so no claim to be its home. There the container carries the home the image bakes — and at
  uid 0 the wrong one — until the spec declares one of its own. A `HOME` that is not the image's own
  is left standing: it is the controller's, or on a claim-less environment the spec's.

## ssh Secret mount contract

The operator mounts **two ssh files** into the container — nothing is copied, staged, or
re-permissioned in the container. They come from **two Secrets with different owners**: the host
identity is always the controller's, while the authorized keys are the user's when
`spec.ssh.authorizedKeysSecret` names a Secret and the controller's otherwise.

The host key is a `subPath` file, because sshd wants it at one exact path. The authorized keys are a
whole-Secret mount of the directory `/run/ssh`, with `items` renaming the selected data key to
`authorized_keys`. The container sees the same absolute paths either way; the difference is that
Kubernetes updates an ordinary Secret mount in place, while a `subPath` file stays frozen at container
start (see the operator requirements below).

| Mounted at | Secret key | Secret | Used by |
|------------|-----------|--------|---------|
| `/etc/ssh/ssh_host_ed25519_key` (`subPath`) | `ssh_host_ed25519_key` | `<env>-ssh-host-key` (controller-minted) | sshd host identity; its presence gates ssh |
| `/run/ssh/authorized_keys` | the entry the volume takes, renamed to `authorized_keys` | `spec.ssh.authorizedKeysSecret`, else `<env>-ssh-client-key` (controller-minted) | keys that may log in |

The entry the volume takes is the one the user's selector names when `spec.ssh.authorizedKeysSecret` is
set, and `id_ed25519.pub` in the controller-minted case — the public half of the generated login keypair,
taken straight out of the Secret rather than copied to a second entry first. `status.sshClientKeySecret`
names that Secret, so it is what a user reads to find where their login keys live. The controller-minted
Secret holds the keypair and nothing else: `id_ed25519`, the private half the user retrieves to log in,
and `id_ed25519.pub`. The volume maps that single entry and no other, so **the generated login private
key never enters the container**.

The private key has to be in **OpenSSH's own format** (`-----BEGIN OPENSSH PRIVATE KEY-----`): sshd
does not read a PKCS#8 Ed25519 key at all, and exits with *invalid format* if handed one. The
`.pub` is informational — sshd derives the public half from the private key.

Both mount paths are **absolute and outside `$HOME`**, so neither depends on the account an image runs
as, and the account's own `~/.ssh` is left to the account. `$HOME` is that account's home
(`/home/ubuntu` for every family image), and it is where the workspace PVC mounts:
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
  back to every environment whose `spec.ssh.authorizedKeysSecret` names it, to re-check a reference
  whose data entry has been removed or whose Secret the user has deleted.
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
- **Inject `CUBSTACK_TYPE`** from `spec.type` (jupyter/ssh) as a controller-owned environment
  variable, dropping any user-declared value — the image re-reads it on every start, and a value the
  user could contradict would desynchronize the probe and ports derived from `spec.type`. The value
  participates in the pod-template hash, so an operator upgrade rolls every jupyter/ssh environment
  once to deliver it.

## Build & smoke

```bash
make -C images build     # every image, tagged $(REGISTRY)/$(PROJECT)/<image>:$(TAG) (see Publish)
make -C images smoke     # build + local Docker smoke (no cluster)
```

Per-image: `make -C images build-cpu-pytorch` / `smoke-cpu-pytorch`, `build-maca-pytorch` / `smoke-maca-pytorch`,
`build-cuda-pytorch` / `smoke-cuda-pytorch`.

The smoke runs throwaway containers on `127.0.0.1` (ephemeral ports, fake ssh Secrets under
`mktemp -d`) and exercises each image **five ways**, because the mode is now per environment:

- **jupyter + sshd** — `CUBSTACK_TYPE=jupyter` with the ssh Secret mounted: token auth returns 200
  and lab HTML on the `NOTEBOOK_ARGS` `base_url` path; no token is rejected; the path without the
  prefix is 404; and sshd answers on 2222 in the same container — key-auth login at uid 1000, group
  `ubuntu`, `$HOME`/cwd `/home/ubuntu`, the served host key equals the mounted Secret public key
  (host keys persist via the Secret, not the image), and the ssh session environment equals the
  container's own (see the drop-in note under Layout).
- **jupyter only** — the same run with no ssh Secret: JupyterLab serves, and nothing listens on
  2222, because the entrypoint starts sshd only when the host key is there.
- **ssh only** — `CUBSTACK_TYPE=ssh`: sshd alone on 2222, nothing listening on 8888, and no
  notebook process. The absence is asked of `/proc` rather than of a binary (the CUDA base *does*
  ship JupyterLab, so a missing binary would prove nothing) and is guarded by a positive probe so a
  container that cannot report its processes fails rather than passes.
- **ssh without a host key** — must exit non-zero and name the missing host key, rather than fall
  back to another mode. A container that came up here would be one the controller marks ready with
  no ssh endpoint.
- **root, in both modes** — `--user 0:0`, `NOTEBOOK_ARGS=--allow-root` for the notebook arm. The
  login works, sshd admits root, and the notebook serves the home the platform derives (`/root`) or
  one the spec declares, and *runs in* it (the server's cwd, which a new terminal inherits). The
  family-specific checks ride along: the vendor stack has to be reachable by the account in both
  modes.
- **elevation** — the image's `sudo` is installed, refuses an account no rule names (which is the
  image as shipped), and elevates uid 1000 to root once the controller's rule is written inside the
  container, passes `visudo`, and is mode `0440`. The rule is written by a root container and used by
  a uid-1000 `docker exec`, the same split the operator's init container and main container are; a
  host-side bind mount would not do, because sudo requires the drop-in to be owned by root.

Docker has no `subPath`, so the smoke reproduces the mount contract with bind mounts — the host key
as a file, the authorized keys as a directory holding a single `authorized_keys` entry (the shape the
operator's `items` mapping produces); see the fidelity note under Trade-offs. A family-specific
assertion is added where the base makes one meaningful:

- **`maca-pytorch`** — the vendor stack under `/opt/maca` is **readable by uid 1000** (checkable
  without a GPU, and the risk that would otherwise surface only on a node: the base was built as
  root, and a library the account cannot read fails at runtime with no build-time signal), the
  default `python3` is the vendor interpreter under `/opt/conda`, it imports the vendor torch, and
  `jupyter` resolves into that same `bin` directory. Whether the *driver* works on a Metax node is
  not covered here.
- **`cuda-pytorch`** — the base's own contribution asserted by **running** it rather than by reading
  the filesystem, which is what the base's shape allows: the account's own `python3` imports torch,
  and a notebook **cell** lands on that same interpreter. The second half is worth the machinery: the
  base's kernelspec names a bare `python`, which jupyter_client rewrites to the *server's*
  `sys.executable`, so the kernel follows the server and torch follows only if the server has it. The
  question is put to jupyter_client's own `format_kernel_cmd`, which is pure python — no kernel
  start, so it answers under emulation, where a real cell does not complete. Its ssh session also
  carries the CUDA toolkit (`/usr/local/cuda/bin`) and torch's libraries on `LD_LIBRARY_PATH` — the
  naming being the whole reason that session has the stack at all.

**Not asserted, deliberately: `nvidia-smi`.** It comes from driver injection at container start, so a
check of it would be a check of the node rather than of the image; the CUDA runtime's compatibility with
a given node's driver is the same node-side question the MACA image leaves open (decision doc §3.A).

### Publish

Each image has **one name**: `make build` tags it at the reference it is published under,
`$(REGISTRY)/$(PROJECT)/<image>:<stack axes>-$(TAG)` — `py310-torch2.4` for the CPU image,
`3.9.0.12-py310-torch2.4` for MACA, `26.08` for CUDA — defaulting to `harbor.isuanova.com/suanova/...`
and the short commit SHA (decision doc §5.2). `push` adds `:latest` to that same name rather than
introducing a second one, and publishes it as **one multi-arch index per image** covering
`$(PLATFORMS)` — except the two vendor images, which publish a single-platform index (see Platform):

```bash
docker login harbor.isuanova.com              # once — the Makefile never authenticates
make -C images push                           # publish every image
make -C images push-cpu-pytorch   # cpu-pytorch:py310-torch2.4-<sha>
make -C images push-maca-pytorch  # maca-pytorch:3.9.0.12-py310-torch2.4-<sha>
make -C images push-cuda-pytorch  # cuda-pytorch:26.08-<sha>
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
explicit TAG. §5.2 gives the release schemes per image — `py<python>-torch<ver>-<sha>` for
`cpu-pytorch`, `<maca-version>-py<python>-torch<ver>-<sha>` for `maca-pytorch`, and
`<ngc-release>-<sha>` for `cuda-pytorch` — the families
version on different axes, hence the per-target form. None of those axes is a `TAG` the caller
passes: `CPU_TAG` reads `CPU_PYTHON` and `TORCH_VERSION`, `MACA_TAG` reads them out of
`MACA_PACKAGE`, and `CUDA_TAG` its release out of `CUDA_PACKAGE`,
so a tag cannot name a stack the image was not built from, and `TAG` still ends it — re-building an
overlay on an unchanged stack moves the reference rather than redefining it. There is one axis for CUDA
rather than three because the NGC release pins python, torch and CUDA together, so naming it names all
of them. Every target refuses to publish (`check-cpu-pytorch` / `check-maca-pytorch` /
`check-cuda-pytorch`) if an input bump lands a version the tag axes cannot be read from.

A deployment tracking `:latest` follows the newest publish while a pinned one keeps its SHA/release
tag; publishing an older commit therefore moves `:latest` backwards, which is expected for a moving
tag but worth knowing before rebuilding a previous release. `REGISTRY` / `PROJECT` relocate the whole
destination.

### Platform

`make build` and `make smoke` work on **one** platform, `$(PLATFORM)`, default `linux/amd64` — the
architecture the cluster's nodes run. The CPU Dockerfile starts from a multi-arch base (`ubuntu`),
so without `--platform` `docker build` resolves that base to the **host**
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

`maca-pytorch` and `cuda-pytorch` sit outside both flows' platform choice, on the same grounds: neither
vendor base has an arm64 manifest to build from — the MACA vendor publishes one architecture per tag,
the NVIDIA mirror lists `linux/amd64` alone — so `build-maca-pytorch` always passes `$(MACA_PLATFORM)` and
`build-cuda-pytorch` always passes `$(CUDA_PLATFORM)`, both defaulting to `linux/amd64`, rather than
`$(PLATFORM)`; their push targets publish that one platform rather than `$(PLATFORMS)`, which is a
single-platform index buildx supports. They are the images whose architecture is a property of the
image rather than of the host or the platform list, and each vendor image has its own variable for it:
`MACA_PLATFORM=` / `CUDA_PLATFORM=` are what move them, and `PLATFORMS=` does not reach them.

Verify what a registry received rather than assuming the build host's architecture:

```bash
docker buildx imagetools inspect --raw harbor.isuanova.com/suanova/cpu-pytorch:latest
```

### Overrides / mirror builds (CN or offline)

Every build resolves `FROM` this registry's mirrored copies of the upstream bases — they live in
the shared `$(MIRROR_PROJECT)` project, each repo named for the upstream reference it holds —
`$(REGISTRY)/$(MIRROR_PROJECT)/docker.io/library/ubuntu:$(UBUNTU_VERSION)`, passed through
`BASE_ARGS`. Building from the
mirror keeps the published image descended from the
base the platform serves, where `FROM ubuntu:22.04` would silently give whatever upstream has
retagged it to — and it is the only copy that resolves where upstream is unreachable. Each is
pinned by the digest of the mirror's index, and the digest is what the build resolves:
`operator/hack/mirror-e2e-images.sh` repoints those tags, so on the tag alone the same commit
could publish different base layers under one `TAG`. Bumping a base is therefore deliberate —
read the new digest, update `images/Makefile` and `BASE_MIRRORS` in `operator/Makefile`, then
re-run the mirror script, which fails if a mirrored tag no longer hashes to the digest it is
listed under. `BASE_ARGS=` (empty) resolves from upstream instead, unpinned.

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
APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports \
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
make -C images build
```

`APT_MIRROR` stays on `http`: the `ubuntu` base ships no CA store until the same `apt-get` installs
`ca-certificates`, so rewriting its sources to an `https` mirror before that fails InRelease
verification.

`IMG_CPU_PYTORCH` / `IMG_MACA` / `IMG_CUDA` override the
output tags (`CPU_TAG` / `MACA_TAG` / `CUDA_TAG` the axes each image derives); `BASE_ARGS` the base images
(above); `CONTAINER_TOOL` overrides `docker` (e.g. `podman`); `PLATFORM` the build/smoke architecture,
`PLATFORMS` what `push` publishes, and `MACA_PLATFORM` / `CUDA_PLATFORM` the one architecture each
vendor image builds and publishes for (see Platform).

## Layout

```
images/
  common/                  runtime config shared across the images (single source)
    entrypoint.sh          mode selection + optional sshd (admits root when it runs as root),
                           then hand-off to the image CMD
    jupyter/start-jupyter.sh  every family's CMD: the launcher none of the bases ships
    sshd/10-devenv.conf    sshd_config.d drop-in; @SSH_USER@ login account, @SSH_ENV@ session env
    sshd/install-dropin.sh fills both placeholders in, or fails the build
  cpu-pytorch/
    Dockerfile             the CPU family: plain ubuntu:22.04 + python3, the CPU torch build, JupyterLab, sshd
  maca-pytorch/
    Dockerfile             platform layer on the Metax MACA vendor base
  cuda-pytorch/
    Dockerfile             platform layer on the NVIDIA NGC PyTorch base
  hack/smoke.sh            local acceptance smoke (both modes per image)
```

The sshd_config drop-in is **shared**: it holds the mount contract's paths (`HostKey`,
`AuthorizedKeysFile`, the latter `%h`-relative so it follows each image's home) and two placeholders,
both filled in at build time by `common/sshd/install-dropin.sh` — which every Dockerfile that copies
the drop-in also copies in and calls, so the template cannot ship half-filled. The first is the login
account, `@SSH_USER@`, given as `ARG SSH_USER` (`ubuntu` in all three). A missed substitution is not a
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
you is the family one. The smoke asserts both.

The second is `@SSH_ENV@`, the `NAME=value` pairs for the drop-in's single `SetEnv`. Each Dockerfile
names the variables its session needs and the installer reads their values out of the build shell's
environment — the **image's own** by the time it runs, the base's plus whatever the overlay has set,
which is how `maca-pytorch` gets `/opt/conda/bin` onto a session's `PATH` (see Trade-offs). A
placeholder is needed at all because sshd's `SetEnv` *replaces* a session's environment rather than
adding to it, so a literal does not extend an image's environment, it hides it; and no one literal fits
every family, since the CPU image needs only its own `PATH` while each vendor base's session has to
carry its whole toolchain — the MACA one's (`PATH`, `LD_LIBRARY_PATH`, `LIBRARY_PATH`, `MACA_PATH`,
`MACA_CLANG_PATH`) or the MACA tools and compilers a user reaches that base over ssh *for* are silently
absent, and the CUDA one's (`PATH`, `LD_LIBRARY_PATH`, `LIBRARY_PATH`, `CUDA_HOME`,
`TORCH_ALLOW_TF32_CUBLAS_OVERRIDE`) or neither the toolkit nor torch's own libraries arrive. Unlike
`@SSH_USER@`, a missed substitution here fails *quiet*: the literal itself becomes a value and nothing
downstream objects. Hence the installer, which fails the build on an unset, empty or
whitespace-carrying variable, on a placeholder left behind, and on anything but exactly one `SetEnv`
line — sshd applies the first and ignores the rest without complaint — plus the smoke, which reads
the session environment back and compares it to the container's own variable by variable.

**Build context is `images/`** for every Dockerfile — that is why ignore rules live in the single
`images/.dockerignore` (deny-by-default) and why shared files are `COPY common/...`.

## Trade-offs / notes

- The merge makes the **mode** a runtime property: one image per family is built and shipped, and
  `CUBSTACK_TYPE` (controller-injected from `spec.type`) picks the arm. The property that has to
  keep holding is the ssh arm's *absence* of a notebook — asserted from the process table, not from
  a missing binary, because `cuda-pytorch` ships JupyterLab and could start it.
- sshd binds the unprivileged `2222`, so the images need **no capability at all** — design Gap B
  (`NET_BIND_SERVICE`) is closed by port choice rather than by granting a privilege. Two things follow:
  the operator must set the Service's `targetPort` to `2222` (#173), and a local smoke cannot validate
  the port privilege anyway — Docker writes `ip_unprivileged_port_start=0` into every container netns,
  so a container there can bind `:22` with no capability, while a pod's own netns defaults to `1024`.
- All three images run at the platform default uid/gid 1000:1000, so no environment needs a
  `securityContext.runAsGroup` override.
- `maca-pytorch` inherits two properties of the vendor base worth knowing before it is trusted.
  Its **driver** is baked
  into the base (`/opt/mxdriver`) while a Metax node may inject its own; which one wins is untested, and
  the local smoke cannot answer it — that needs a node advertising `metax-tech.com/gpu`. And its python
  is the **vendor's**, which is the point: jupyterlab is installed into that interpreter so the torch
  that imports is the vendor's metax build, never a second interpreter beside it. The base ships that
  interpreter beside a system python that has none, and names it only from a login profile, so the
  Dockerfile puts `/opt/conda/bin` on `PATH` itself — without that, a notebook cell or a
  non-interactive `ssh host 'python3 …'` reaches the interpreter with no torch while an interactive
  session works.
- `cuda-pytorch` inherits a different base and with it a different set of unknowns. Its **account is
  the base's**, not the platform's — uid/gid 1000 `ubuntu` at `/home/ubuntu` happens to be exactly the
  layout this family wants, which is why the Dockerfile inherits it instead of creating it, and why a
  base that named its account differently would be a build failure rather than a quiet mismatch. Its
  JupyterLab is the base's too, on the same interpreter torch is installed into, so there is no second
  interpreter to prefer and no `PATH` correction to get wrong — the trap the MACA image had. What it
  does not answer is again node-side: a driver has to satisfy the baked CUDA runtime, which no local
  smoke can see.
- The workspace PVC mounts at the account's home (`/home/ubuntu`, derived from `spec.runtime.user` —
  an explicit `spec.storage.mountPath` overrides), where the notebook root already lives by default. An
  empty/root-owned PVC is storage-side (Gap A); the image cannot fix it, and readiness is TCP-only.
- **Smoke fidelity for the host-key mode.** Kubernetes projects Secret files root-owned `0644`, which a
  uid-1000 sshd accepts (the owner check applies only to a file owned by the uid doing the reading).
  Docker does not reproduce that faithfully: Docker Desktop reports a bind mount as root-owned `0600`
  yet lets any container uid read it, while a rootful Linux daemon keeps the host uid and modes — there
  the mounted `0600` key really is unreadable to uid 1000 and sshd exits with *no hostkeys available*.
  `hack/smoke.sh` therefore mounts the private key `0600` **and** asserts up front that the container
  uid can read it (`ensure_mount_readable`), so that environment mismatch is reported as itself rather
  than as a 30-second ssh timeout. The cluster path (`0644`, root-owned) was verified separately by
  hand; only the ownership the engine presents and enforces differs, not the image.
