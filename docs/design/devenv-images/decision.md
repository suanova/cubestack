# DevEnvironment base images: sourcing / composition / delivery decision

## 1. Context and goal

Platform DevEnvironments are driven by the operator's `DevEnvironment` CRD, which lets a user pick a
container image (`spec.image`) combined with semantic axes such as `type` (jupyter / ssh / vscode),
GPU vendor, storage, and an SSH toggle. This module delivers that **base-image set**: images that
satisfy the image contract already fixed in the operator, are published to a container image
registry, and can be bundled for offline installation.

In scope: the four image products `base-cuda` (NVIDIA), `base-maca` (Metax), `jupyter-minimal`,
`ssh-ubuntu22.04`, plus offline packaging / container image registry publishing. **Out of scope**: code-server,
`DevEnvironmentTemplate`, GPU driver / RDMA bring-up (Installer).

Whether images are pulled from public registries or self-built, how they are composed, and where the
Dockerfiles live are all undecided — this document settles them.

---

## 2. Operator image-contract cross-check

The images' only mandatory spec is what the operator has already merged
(`operator/internal/controller/*`, `operator/api/v1alpha1/*`, `operator/config/samples`). Each
assumption is checked below. "🚩" marks gaps the **controller / platform side must close before the
images are final** — they cannot be solved inside the images themselves.

| # | Operator assumption | Code evidence | Requirement on the image | Status |
|---|---|---|---|---|
| 1 | Brand marker | `devenvironment_controller.go::brandMismatchReason`: image name (lowercased) must **contain** `base-cuda` / `base-maca`. Checked **only when a GPU is requested** — `gpuCount: 0` is exempt | Image registry path must include the `base-cuda` / `base-maca` segment **when it is a GPU image**; CPU images are named freely | ✅ consistent with the brand gate |
| 2 | Type → port | `::mainContainerPort`: jupyter 8888 / ssh 22 / vscode 8080; readiness probe = TCP on the main port | The server must listen on the type's port and accept TCP — **except ssh**, where the container listens on the unprivileged **2222** (see B) and the Service publishes that as 22 | ⚠️ images ship 2222; Service `targetPort` + probe retarget is #173 |
| 3 | Non-root default | `::desiredSecurityContext`: `runAsUser=runAsGroup=1000`, `runAsNonRoot=true` (only lifted when the user explicitly sets `0`) | Image must run as the **uid/gid the spec resolves to** (`spec.runtime.securityContext`, platform default 1000/1000), non-root, incl. writing `$HOME` (stock images ship uid 1000) | ✅ (but see #6, #9) |
| 4 | `$HOME` / working dir = the workspace mount | comment in `devenvironment_types.go`: PVC mounted at the derived workspace path; the image's home/workdir should land on it | Image `USER`/`HOME`/workdir must land on the workspace PVC mount. The mount path is `spec.storage.mountPath`, else the home the runtime identity implies — docker-stacks images keep `/home/jovyan` by naming `jovyan`; the self-authored images get `/home/ubuntu` | ⚠️ see "Gap A" + §2 contract |
| 5 | SSH key mount | `assets.go:63`: Secret data keys `ssh_host_ed25519_key`(+`.pub`), `authorized_keys`; `devenvironment_controller.go:709` mounts read-only at `/etc/cubestack/ssh`, default mode 0644; host key is **never rotated** (persistence provided by the Secret) | The operator mounts two of those keys **as files with `subPath`** — `ssh_host_ed25519_key` → `/etc/ssh/ssh_host_ed25519_key` and `authorized_keys` → `$HOME/.ssh/authorized_keys2` — and sshd reads them **in place: no staging, no copy, no chmod**. A root-owned `0644` private key is accepted because OpenSSH enforces that check only on files **owned by the uid reading them**, which a Secret volume file never is | ⚠️ images ship this; the mount shape is #173 (the merged operator still mounts the old `/etc/cubestack/ssh` directory) |
| 6 | sshd listening on :22 as uid 1000 | ssh Service 22→22 in the controller; `desiredSecurityContext` grants no capabilities | sshd listens on the unprivileged **2222**. Binding a port <1024 as non-root needs `NET_BIND_SERVICE`, which this closes **by port choice rather than by granting a privilege** — no capability, no `securityContext.sysctls` reliance, nothing for a Restricted PSA to drop. The operator publishes it as the Service's 22 and probes the container port | ✅ Gap B closed, no capability needed; Service/probe retarget is #173 |
| 7 | `JUPYTER_TOKEN` | `jupyterTokenEnv="JUPYTER_TOKEN"` (:144), injected only for the jupyter type, from `<env>-auth` Secret `data[token]` | The jupyter server must authenticate with this env value | ✅ (jupyter-server reads `JUPYTER_TOKEN` natively, see §3.B4) |
| 8 | `base_url` = `/dev/<ns>/<env>/` | HTTPRoute forwards the prefix **unchanged** (no URLRewrite filter); the controller never injects the prefix into the container — yet the route design states "container serves under that base_url" | Jupyter must serve under that prefix via `ServerApp.base_url`, but nothing hands the prefix to the container | 🚩 **Gap C** |
| 9 | Runtime-mode inference | Single-container pod; `type` and `image` are independent axes; the controller injects no `type`/mode env | The same image must decide by itself whether to run jupyter or sshd (e.g. inferred from whether `JUPYTER_TOKEN` is injected / ssh keys are mounted) | ✅ defined by the images: `CUBESTACK_IMAGE` is baked per image and an optional injected `CUBESTACK_TYPE` wins when present (see Gap D) |
| 10 | Multi-service in one container | `sshExposed` adds a 22 Service and mounts keys for jupyter/vscode types, sharing the main container | jupyter type + `ssh.enabled` ⇒ the same process group must run jupyter *and* sshd. The entrypoint starts sshd in the background and hands off to the stock launcher. **The mounted host key is the ssh-enabled signal** — images ship no host key of their own, so `ssh` mode fails fast without it and jupyter simply stays ssh-less | ✅ handled by entrypoint script |
| 11 | GPU extended resource | `::gpuResource`: nvidia `nvidia.com/gpu` / metax `metax-tech.com/gpu`, written to requests and limits at `resources.gpuCount`. With `gpuCount: 0` the key is **omitted entirely** — a zero request would still pin the pod to a node advertising that resource | The image is device-agnostic; `nvidia-smi`/`mx-smi` come from driver injection. A CPU image must not need either | ✅ see §3 |
| 12 | SSH login user | `defaultRuntimeUser="user"` (:142) is the platform default → endpoint `ssh://user@<gw>`; `spec.runtime.user` overrides it, and the endpoint carries that account. The first-party images do not ship the default: the self-authored ones run `ubuntu`, the docker-stacks-derived `jupyter-minimal` runs `jovyan` | The image must contain the account `spec.runtime.user` names (default `user`, uid 1000); for jupyter that is the stock `jovyan` account | ✅ |

### Runtime metadata: named per environment, not declared by the image

Every knob the platform otherwise assumes about an image is a **DevEnvironment spec field** with a
platform default behind it. Nothing reads image metadata: the operator holds no registry client, and a
bring-your-own image is configured the same way a first-party one is.

| Knob | Platform default | Spec field |
|---|---|---|
| Container account | `user` | `spec.runtime.user` |
| Container uid | `1000` | `spec.runtime.securityContext.runAsUser` |
| Container gid | `1000` | `spec.runtime.securityContext.runAsGroup` |
| Durable home / mount | `/workspace` | `spec.storage.mountPath` |

`spec.runtime.user` is a container-identity fact rather than an SSH one: the account it names is the
one that owns the notebook files and the workspace, so it belongs beside the numeric
`securityContext.runAsUser`/`runAsGroup` it must agree with — not under `spec.ssh`, where the rest
of the fields describe ssh access rather than the identity the container runs as.

**Derivation.** The workspace PVC mounts at `spec.storage.mountPath` when the user sets it; otherwise
the path follows the runtime identity — `/root` for an environment running as root
(`securityContext.runAsUser: 0`), `/home/<user>` when `spec.runtime.user` names an account, and
`/workspace` otherwise (`::resolveMountPath`). The ssh login account is `spec.runtime.user`, else the
platform default (`::runtimeUser`). So naming the account once yields the right mount, and an explicit
`mountPath` — which always wins — covers a bring-your-own image whose home is somewhere else.

**The defaults are the operator's fallback, not a layout our images must match.** The self-authored
`ssh-ubuntu22.04` runs account `ubuntu` uid/gid 1000 with home `/home/ubuntu`, which an environment
selects with `spec.runtime.user: ubuntu`. Images we do **not** author are not forced into that layout
either: **stock-derived images** (the docker-stacks jupyter overlay) keep the upstream account/home
(`jovyan` uid 1000 gid 100, `/home/jovyan`) exactly as the stock image ships them, selected with
`spec.runtime.user: jovyan` plus `securityContext.runAsGroup: 100` — a gid no derived value implies,
since the platform default is 1000. The spec fields are therefore *statements about the image's native
layout*, not conformance requirements — and the self-authored image is the first user of that
mechanism, not an exception to it.

**Nothing validates the pairing.** The operator cannot see inside the image, so a `spec.runtime.user`
that names an account the image does not have, or a `runAsUser`/`runAsGroup` that does not match the
uid/gid the image's own sshd and files belong to, surfaces as a failed login or an unusable home
rather than as a rejected spec. A non-root sshd can only serve the uid it runs as, so the account, the
numerics, and the mount path have to agree. `images/README.md` lists the correct values per shipped
image.

### Gap A — the home mount writable by uid 1000

The pod sets no `fsGroup`; the workspace PVC uses `cephfs-ephemeral` (RWX, `assets.go:85`). The
container runs as uid 1000 with `$HOME` on the mount, so the **RWX StorageClass's mount behavior must
make the mount path writable by 1000** (cephfs owner/mode) — regardless of whether that path is
`/home/ubuntu` or `/home/jovyan`. The image cannot chown itself (non-root). This belongs to
workspace-storage work for verification; the image only commits to pointing `$HOME` at the mount point.

### Gap B — closed: sshd listens on the unprivileged 2222

The container security context grants no capabilities, and a non-root process cannot bind `:22`: Linux
clears the capability sets for a non-root uid, so binding it needs `CAP_NET_BIND_SERVICE` restored.
There were two ways to satisfy that; the images take the second:

1. ✗ The controller appends `capabilities.add: [NET_BIND_SERVICE]` to the main container's
   securityContext (when SSH is exposed), and the namespace must not enforce a Restricted PSA that
   drops that cap. This makes every cluster, every image, and every future GPU image depend on the pod
   spec granting a privileged-port capability.
2. ✅ sshd listens on **2222**, and the Service publishes it as `port: 22` → `targetPort: 2222`.

**Decided: option 2.** It removes the dependency rather than satisfying it — no capability, no reliance
on `net.ipv4.ip_unprivileged_port_start`, no interaction with `allowPrivilegeEscalation: false` or a
Restricted PSA. It is invisible to users: ssh is published through the Gateway's TCP listener pool
(`SSHPortRangeStart`), never as container port 22, so only the Service's `targetPort` and the
readiness probe change (#173). `servicePortFor` keeps returning 22, so the TCPRoute and the endpoint
assembly are untouched.

⚠️ Whoever verifies this: **a local Docker smoke cannot cover it.** Docker writes
`ip_unprivileged_port_start=0` into every container netns, so a container there binds `:22` with no
capability at all, while a pod's own netns defaults to `1024`. That is also why the images' smoke no
longer passes `--cap-add` — it proved nothing. The check belongs in-cluster or in the kind e2e.

### Gap C — injecting `base_url` into Jupyter

The HTTPRoute (`::desiredHTTPRoute`) forwards the `/dev/<ns>/<env>/` prefix unchanged to the 8888
backend (no rewrite), so jupyter must serve that prefix with `ServerApp.base_url` set, or relative
asset URLs and 404s break. Today the controller injects only `JUPYTER_TOKEN`; the prefix has no
source. Two options:

1. The controller injects the prefix through jupyter's own knob —
   `NOTEBOOK_ARGS=--ServerApp.base_url=/dev/<ns>/<env>/`. The stock launcher appends `NOTEBOOK_ARGS` to
   its command and the overlay adds no launcher of its own, so **no image change is needed**; the
   controller must merge rather than clobber a value the user also sets.
2. The Gateway adds a URLRewrite that strips the prefix, and jupyter serves at `/` as usual.

**Recommendation: option 1** (consistent with the route design's "container serves under that
base_url" semantics, no per-environment gateway rewriting, and no image-side logic — an earlier draft
had the image read a `CUBESTACK_BASE_URL` env, which the stock-native overlay deliberately does not
do); the Gateway must still pass websockets through. This is a controller change and is listed as
"to close".

### Gap D — explicit runtime mode (optional)

The §9 implicit inference (a `JUPYTER_TOKEN` present → start jupyter; ssh keys mounted with no token
→ start sshd) suffices for the current jupyter/ssh types but is fragile and leaves no hook for vscode.
Recommended: the controller also injects `CUBESTACK_TYPE=<jupyter|ssh|vscode>`, and the image
entrypoint reads it first, falling back to implicit inference when absent. **Optional** — can be done
together with Gaps B/C.

---

## 3. Upstream base survey findings (2026-09-08)

### 3.A NVIDIA CUDA (`nvidia/cuda` / `nvcr.io/nvidia/cuda`)

- Exact patch tags exist and are multi-arch (amd64/arm64): e.g. `11.8.0-{base,runtime,devel}-ubuntu22.04`,
  `12.4.1-…`, `12.6.3-…`. **No `latest` tag** — full patch tags must be pinned.
- Variants: `base` = cudart; `runtime` = base + math libraries + NCCL; `devel` = runtime + headers +
  nvcc. Sizes (ubuntu22.04, compressed layers): runtime ~1.2–1.5 GB, devel ~3.2–3.7 GB.
- `nvidia-smi` is **not baked in**: NVIDIA Container Toolkit injects it from the host driver at
  container start. So the "can run `nvidia-smi`" acceptance is really a check of **driver + toolkit
  injection**, not of image contents.
- Driver requirement: the host driver must be ≥ the image's minimum CUDA version (e.g. CUDA 12.4 ≥
  550.54.14; drivers are backward compatible).

### 3.B Jupyter docker-stacks

- **Official images are only published to Quay since 2023-10** (`quay.io/jupyter/*`); Docker Hub
  `jupyter/*` is stale. Chain: `docker-stacks-foundation → base-notebook → minimal-notebook →
  scipy-notebook → {pytorch, tensorflow, …}-notebook`. CUDA tags exist (`pytorch-notebook:cuda12-` /
  `cuda13-`).
- Default user `jovyan` (uid 1000, group users gid 100), `$HOME=/home/jovyan`.
- **Arbitrary UID is not cleanly supported**: `start.sh` remaps user/UID/GID (`NB_USER/UID/GID`) only
  when started as root; run as a non-root uid and it just execs, leaving `/home/jovyan` and
  `/opt/conda` unwritable for uids other than 1000. In K8s either use `runAsUser: 1000` or mount a
  writable volume at `/home/jovyan`.
- Token: docker-stacks' `start-notebook.py` does not read `JUPYTER_TOKEN`, but **jupyter-server
  itself** does (`IdentityProvider.token`) → setting the env suffices for auth; more explicit is
  `--IdentityProvider.token` / `NOTEBOOK_ARGS`.
- `base_url`: pass `--ServerApp.base_url=/prefix` through; under JupyterHub integration it is derived
  from `JUPYTERHUB_SERVICE_PREFIX`.

### 3.C Metax MACA

- **No anonymous public registry**: the official `cr.metax-tech.com` requires commercial authorization
  or an offline package (`metax-gpu-k8s-package.<ver>.tar.gz`). Image tags look like
  `cr.metax-tech.com/library/maca-c500:<ver>-<os>-<arch>` or the newer `<product>-maca:…`;
  `cloud/{gpu-device,container-runtime,metax-operator}` hold the driver/runtime components.
- `mx-smi` ships with / is injected from the **Metax driver userspace**, not bundled in a bare MACA
  base.
- Architecture mirrors NVIDIA: `gpu-device` = Device Plugin (advertising `metax-tech.com/gpu`),
  `container-runtime` = a private runtime that injects MACA on demand (app images need not bake the
  MACA stack).
- **The CUDA ecosystem is not drop-in**: software must be rebuilt against MACA via `cu-bridge`, and
  PyTorch must be a customized `torch…+metax` build (conflicting cupy/flashinfer wheels removed). →
  affects the software selection inside base-maca (see §6).

### 3.D Offline delivery notes

- `docker pull` (on an amd64 host) + `docker save` produces a **single-arch** tarball; the
  multi-arch index is lost. Preserving multi-arch offline needs `skopeo copy --all` or per-node
  `--platform` pulls.
- Pin patch tags and record digests (floating minor tags drift).

---

## 4. Composition model (recommended)

Two families of images share a common "platform layer" so that service capability (entrypoint, ssh
key handling) is written once. They differ in the base and the layout they carry:

```
  common script (images/common): entrypoint — mode select + optional sshd, then hand off to the CMD
                                   │ shared by both families
        ┌──────────────────────────┴───────────────────────────┐
        │                                                      │
 self-authored platform layer                     docker-stacks thin overlay
 (ubuntu22.04) — ships the self-authored          (CPU jupyter-minimal) on quay.io/jupyter/
 layout: account 'ubuntu' uid/gid 1000,           minimal-notebook — keeps stock layout
 $HOME=/home/ubuntu (an environment               native: jovyan uid 1000 gid 100,
 names it: spec.runtime.user=ubuntu); python      $HOME=/home/jovyan (spec.runtime.user=jovyan,
 + jupyterlab (jupyter type) + openssh-server     runAsGroup=100); + openssh-server ONLY, so ssh works;
   │                                              otherwise == stock
   ├── CPU: ssh-ubuntu22.04                       (jupyter type on a GPU-vendor image is the
   └── GPU: base-cuda (+nvidia runtime)           self-authored jupyterlab, not this overlay)
           base-maca (+Metax runtime)
```

Key points:

- **Reaching the CPU images.** A CPU image is selected by setting `spec.resources.gpuCount: 0`
  alongside it. That is what exempts it from the brand gate (§2 #1) and keeps the vendor GPU resource
  out of the pod spec (§2 #11); omitting `gpuCount` instead defaults it to 1 and the brand gate then
  rejects any image whose name lacks `base-cuda`/`base-maca`. There is no default that yields a
  CPU-only environment — it is always explicit.
- **What is shared is the runtime config**: the entrypoint (`images/common/entrypoint.sh` — mode
  selection, the optional sshd, and the hand-off to the image CMD) *and* the sshd drop-in
  (`images/common/sshd/10-nonroot.conf`), which GPU and CPU images and the docker-stacks
  overlay do not duplicate. The drop-in carries the login account as an `@SSH_USER@` placeholder that
  each Dockerfile substitutes from its `ARG SSH_USER`, and the mount-contract paths as `%h`-relative
  (`AuthorizedKeysFile`, `HostKey`) — both are the only per-family values, so one file serves every
  family and the shared parts cannot drift apart.
- **Account / `HOME` follow the image family** (see §2 contract): the **self-authored** platform
  layer (`ssh-ubuntu22.04`, `base-cuda`, `base-maca`) ships account `ubuntu` uid/gid 1000 with
  `$HOME=/home/ubuntu`, named per environment via `spec.runtime.user` — there is no
  upstream UX to preserve, so uniformity is free. The **stock-derived jupyter** image is **not**
  conformed: it keeps `jovyan`
  (uid 1000, gid 100) and `/home/jovyan` exactly as docker-stacks ships them, so users familiar with
  the stock image see stock behavior; it adds sshd only for `ssh.enabled`. An environment selects
  either layout through the same two fields, so neither family bends to the platform's defaults.
- **`base-cuda`/`base-maca` reuse the same self-authored platform layer**: a jupyter-type environment
  can pick a GPU-vendor image, while an ssh-type environment on a GPU-vendor image runs only sshd (mode
  chosen by the entrypoint).

---

## 5. Registry organization and tag scheme (recommended)

Current anchors: `config/samples/ai_v1alpha1_devenvironment.yaml` and controller unit tests pin
`harbor.local/ai-images/base-cuda:11.8-pytorch2.2` / `harbor.local/ai-images/base-maca:1.0` — the
offline in-cluster registry host form. Those are fixture values for a *user-chosen* image, not the
platform's own publishing target, so they do not dictate the project below.

- **Project name**: `suanova` — our images publish as
  `harbor.isuanova.com/suanova/{ssh-ubuntu22.04,jupyter-minimal,base-cuda,base-maca}`. That is the
  project CI already publishes operator and portal to (`suanova/cubestack-{operator,ui}`), so every
  CubeStack image lives under one project on the one host. **The repository names the axis a user
  selects on and that changes slowly; the tag carries what changes per build.** Two axes qualify.
  For the ssh image it is the Ubuntu release — a coarse LTS cadence, and a compatibility contract in
  apt/dpkg and libc — so the base release belongs in the name. For the jupyter image it is the
  docker-stacks stack variant (`foundation → base → minimal → scipy → …`), which decides what is
  preinstalled and likewise moves slowly, hence `jupyter-minimal`. What does *not* qualify is a value
  that moves every release: upstream's *date* is exactly that, so it stays in the tag, and its Ubuntu
  base is upstream's choice rather than our pin (naming it would assert something we do not control).
  `base-cuda`/`base-maca` name their vendor by the same rule — it is what the user picks on. Offline
  installs surface the same images at `harbor.local`; only the host is swapped, by packaging/rewriting.
- **Tags**: content-locked and reproducible. Examples:
  - `base-cuda:<cuda>-py<python>[-torch<torch>]`, e.g. `12.4.1-py3.11-torch2.4.0`; or reuse today's
    semantics `11.8-py3.10-torch2.2.2`. **Recommend promoting the sample's `11.8` to the full patch
    `11.8.0` and eventually recording digests** in the packaging manifest.
  - `base-maca:<maca-version>-py<python>[-torch<ver>+metax]`
  - `ssh-ubuntu22.04:<date>`, e.g. `20260910`. The repository name carries the base release, so the tag
    only identifies the build; a distro bump mints a new repository under the same scheme
    (`ssh-ubuntu24.04:<date>`) rather than changing the tag shape.
  - `jupyter-minimal:<base-date>`, e.g. `2026-09-07`. The docker-stacks images version by date rather
    than by python or lab version, so the overlay inherits upstream's identity as its tag; append
    `-<date>` when the overlay changes without the base moving.
  - `make push` defaults `TAG` to the short commit SHA, so a bare command yields a traceable,
    non-floating reference; pass an explicit tag from the schemes above to publish a release. The SHA
    names the last commit rather than the working tree, so publishing expects a committed tree.
  - Both forms of reference are published: the pinned tag above *and* a moving `:latest` that the push
    re-points at the image it just built, so a deployment may track the newest publish or pin exactly.
    Re-publishing an older commit therefore moves `:latest` backwards, which is inherent to the tag —
    the pinned tag is what a reproducible deployment should reference.
- The brand marker only requires the path to contain `base-cuda`/`base-maca` (§2 #1), orthogonal to
  the project/tag choices above.

---

## 6. Image inventory and composition

### 6.1 `base-cuda` (NVIDIA)

- **Base**: pull `nvidia/cuda:<cuda>-runtime-ubuntu22.04` directly (**runtime**, not devel — see below).
- **Overlay**: the platform layer (§4): python + entrypoint + account `ubuntu`(1000) with
  `$HOME=/home/ubuntu` (`spec.runtime.user: ubuntu`).
- **Bake PyTorch or not**: to decide. Today's sample implies yes (`…-pytorch2.2`); baking requires
  pulling CUDA torch wheels at build time and a larger image. **Recommendation**: bake a default,
  commonly used `torch+cu` stack into the GPU image for "out of the box" use, version pinned in the tag.
- **runtime vs devel**: a runtime base covers "run torch"; if target users must `nvcc`-compile inside
  the container, devel is needed (+~2.3 GB) or a separate `-devel` variant. **Recommendation: runtime
  by default**, compile needs handled as build-time wheels, with a devel variant if required — pending
  product confirmation.
- **Acceptance mapping**: `nvidia-smi` visible = driver+toolkit injection check (not image content);
  non-root 1000, `$HOME=/home/ubuntu`, 8888/2222 ready — smoke-driven by the controller pod spec.

### 6.2 `base-maca` (Metax)

- **Gate**: Metax has no anonymous public registry. Commercial access to the offline package/account
  (`cr.metax-tech.com`) is required first, plus confirmation that `container-runtime` injection works
  for non-root uid-1000 containers. **Until this gate passes, the Metax image cannot be self-built.**
- **Base/overlay**: stack the platform layer on the Metax MACA runtime (from the commercial package's
  images or a base unpacked from it); if `container-runtime` injection is available, the image need
  not bake the MACA stack (mirroring NVIDIA's injection model).
- **Software stack**: PyTorch must be the `torch+metax` build; stock CUDA wheels are not directly
  usable (cu-bridge recompile).
- **Acceptance mapping**: `mx-smi` visible, `metax-tech.com/gpu` request succeeds, 1000/`/home/ubuntu`/
  ports ready.
- **Decision**: direction = self-built (no public base to choose); blocker = obtaining the MACA package
  and confirming the injection model — an explicit first task; do not assume it can be pulled directly.

### 6.3 `jupyter-minimal` and `ssh-ubuntu22.04`

- **`jupyter-minimal` (CPU)**:
  - Option A: **thin-overlay `quay.io/jupyter/minimal-notebook`**, **stock-native**: keep the image
    exactly as docker-stacks ships it — `jovyan` (uid 1000, gid 100), `$HOME=/home/jovyan`, stock
    launcher/entrypoint — and add **only** openssh-server + the shared ssh key handling so that
    `ssh.enabled` works. The workspace PVC mounts at `/home/jovyan` (its native home, derived from
    `spec.runtime.user: jovyan`). Users familiar with the stock image get stock behavior; `base_url`
    / token need no image change (see below).
  - Option B: **self-build** (ubuntu22.04 + conda/pip + jupyterlab + custom entrypoint) — full control
    of uid/HOME/size, but you own the dependency manifest.
  - **Decision**: CPU `jupyter-minimal` via Option A **thin-overlay, stock + ssh only** — recommended
    in §4. No renaming to `user`, no gid-1000 move, no `/workspace` redirect, no XDG re-homing:
    everything except the added sshd stays identical to the stock image, because there is no platform
    reason to change it — the §2 contract lets an environment name the image's layout rather than
    the image conform to the platform's. Option B (self-build) stays a fallback if a product later needs the
    ecosystem trimmed; the GPU variant remains base-cuda's self-authored platform layer.
- **`ssh-ubuntu22.04` (CPU)**: self-build (ubuntu22.04 + openssh-server + entrypoint) — simplest,
  smallest attack surface; self-authored (no upstream stock UX to preserve) so it ships account
  `ubuntu` uid/gid 1000 with `$HOME=/home/ubuntu` (`spec.runtime.user: ubuntu`).
  Key material is mounted with `subPath`, never staged (§2 #5).
- **Acceptance mapping**: jupyter 8888 + token (`JUPYTER_TOKEN` env, no-token rejected) + base_url path
  reachable (depends on Gap C closing); ssh (container 2222, Service 22) + authorized_keys login + host
  keys persistent across restarts (provided by the Secret).

---

## 7. Where the Dockerfiles live (decided: monorepo `images/`)

- **Decided**: a top-level **`images/`** workspace in this monorepo, alongside `operator/` and `web/`.
  It landed with the build work and holds the shared platform layer (`images/common/`), the per-image
  Dockerfiles, and the `Makefile` + `hack/smoke.sh` build and acceptance-smoke scripts.
- Rationale: the operator contract and the e2e suite evolve in the same repo; layered builds (§4) need
  same-repo references to the shared base; consistent with the existing operator/web two-stack layout.
- Alternative: a separate Installer/image repo — not recommended (splits contract evolution from builds).
- **Still open**: the offline export script, and a CI job that builds, smokes and publishes per §5 —
  neither exists yet, so publishing today is a manual `make -C images push`, gated by a local
  `make -C images smoke`.

---

## 8. Platform-side changes to close (not image-side)

| Item | Owner | Recommendation | Blocks |
|---|---|---|---|
| A workspace writability check (uid 1000 writing the home mount: `/home/ubuntu` self-authored, `/home/jovyan` jupyter) | workspace storage (cephfs-ephemeral) | Confirm the RWX SC makes the mount path writable by 1000 | smoke of all images |
| B non-root sshd binding :22 | controller | **Closed image-side**: sshd listens on 2222 and the Service publishes it as 22, so no capability is ever granted. Retargeting `targetPort`/probe is #173 | base image ssh acceptance |
| C injecting jupyter `base_url` | controller | Inject `NOTEBOOK_ARGS=--ServerApp.base_url=/dev/<ns>/<env>/` (merge, don't clobber a user value) — the stock launcher honours it, so no image change | jupyter image acceptance, e2e |
| D mode env (optional) | controller | Inject `CUBESTACK_TYPE`, entrypoint reads it first | vscode hook |

---

## 9. Decision summary and items to confirm

| Item | Conclusion | Status |
|---|---|---|
| Two-family model: self-authored platform layer (`ubuntu` 1000, `$HOME=/home/ubuntu`) + docker-stacks thin overlay (`jovyan`/`/home/jovyan`, stock-native, ssh added) — shared entrypoint + layout named per environment (`spec.runtime`, `spec.storage.mountPath`) | §4 | ✅ recommended here |
| GPU image = self-authored platform + runtime layer (layered reuse) | §4 | ✅ recommended here |
| Project `suanova`, host `harbor.isuanova.com` (online) / `harbor.local` (offline) | §5 | ✅ recommended |
| Dockerfiles live in monorepo `images/` | §7 | ✅ decided — landed; offline export + CI still open |
| base-cuda base = runtime (not devel) + whether to bake torch | §6.1 | ⚠️ **pending product** (CUDA version 11.8 vs 12.x, torch version, devel variant?) |
| base-maca self-build + commercial gate | §6.2 | ⚠️ **to confirm**: Metax package channel / injection model / target software versions |
| jupyter-minimal = stock-native thin-overlay on Quay minimal-notebook + ssh only | §6.3 | ✅ decided (shipped in images work) |
| ssh-ubuntu22.04 self-build, account `ubuntu`/`$HOME=/home/ubuntu` (`spec.runtime.user: ubuntu`) | §6.3 | ✅ recommended here |
| Gaps A/B/C/D closure | §8 | ⚠️ **to schedule into follow-up controller work** (B closed image-side; A/C/D remain) |

After review: promote the "✅ recommended" items to "decided", backfill the "to confirm" items, and
post a summary of this document so downstream image-build work can proceed.
