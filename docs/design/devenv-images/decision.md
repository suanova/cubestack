# DevEnvironment base images: sourcing / composition / delivery decision

## 1. Context and goal

Platform DevEnvironments are driven by the operator's `DevEnvironment` CRD, which lets a user pick a
container image (`spec.image`) combined with semantic axes such as `type` (jupyter / ssh / vscode),
GPU vendor, storage, and an SSH toggle. This module delivers that **base-image set**: images that
satisfy the image contract already fixed in the operator, are published to a container image
registry, and can be bundled for offline installation.

In scope: the image set that now ships — `jupyter-cuda-pytorch` and `ssh-cuda-pytorch` (NVIDIA — a
single `base-cuda` in the earlier draft, see §6.1), `jupyter-maca-pytorch` and `ssh-maca-pytorch`
(Metax — a single `base-maca` in the earlier draft, see §6.2), `jupyter-minimal`, `ssh-ubuntu22.04`,
plus offline packaging / container image registry publishing. **Out of scope**: code-server,
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
| 1 | Brand marker | `devenvironment_controller.go::brandMismatchReason`: image name (lowercased) must **contain** the vendor's token — `cuda` for nvidia, `maca` for metax. Checked **only when a GPU is requested** — an absent `spec.resources.gpu` block is exempt | Image must carry its vendor token when it is a GPU image; CPU images are named freely. Both nvidia products spell it out in their names (`jupyter-cuda-pytorch`, `ssh-cuda-pytorch`); metax products are the upstream Metax packages (`maca`, `maca-pytorch`, `maca-tensorflow`, …) mirrored under their own names, and the pair built on that mirror carries the token too | ✅ consistent with the brand gate |
| 2 | Type → port | `::mainContainerPort`: jupyter 8888 / vscode 8080 / ssh `sshContainerPort`; readiness probe = TCP on the main port | The server must listen on the type's port and accept TCP — **except ssh**, where the container listens on the unprivileged **2222** (see B) and the Service publishes that as 22 | ✅ implemented (#173): the probe targets the container port (2222 for ssh) and the Service publishes `port: 22 → targetPort: 2222` |
| 3 | Non-root default | `::desiredSecurityContext`: `runAsUser=runAsGroup=1000`, `runAsNonRoot=true` (only lifted when the user explicitly sets `0`) | Image must run as the **uid/gid the spec resolves to** (`spec.runtime.securityContext`, platform default 1000/1000), non-root, incl. writing `$HOME` (stock images ship uid 1000) | ✅ (but see #6, #9) |
| 4 | `$HOME` = the workspace mount; the working directory is separate | `::withWorkspaceHome` states the resolved mount path as the container's `HOME`, for every type, whenever `spec.storage` is set; `desiredPodSpec` sets no `container.WorkingDir`, and no image's own account home is rewritten | The container is **told** where its home is; an image must act on that for anything meant to land on the workspace. The mount path is `spec.storage.mountPath`, else the home the runtime identity implies — docker-stacks images keep `/home/jovyan` by naming `jovyan`; the self-authored images get `/home/ubuntu`. A non-root account must be able to **write** that mount, which no image can arrange for itself | ✅ Gap A closed for `HOME`: an init container repairs the claim's ownership — the root alone while it already matches, the whole tree when it does not — before the container starts. Both jupyter launchers end up serving the stated home rather than one the image bakes — the MACA one passes it as `--ServerApp.root_dir`, the CPU one takes uid 0 out of the stock chain and `cd`s into it — so a notebook serves the workspace. **The ssh family does not**: it keeps `WORKDIR /home/ubuntu` and nothing in the image reads `HOME`, so an ssh session works in the directory the image gives it, which is the claim only where the mount resolves there. A working-directory guarantee is **not implemented** |
| 5 | SSH key mount | `assets.go:60-77`: Secret data keys `ssh_host_ed25519_key`(+`.pub`) and the authorized-keys entry, the two in **separate Secrets** — the controller's `<env>-ssh-host-key`, and `<env>-ssh-client-key` or the user's `spec.ssh.authorizedKeysSecret`; `::desiredPodSpec` mounts the host key as a read-only `subPath` file and the authorized keys as a whole-Secret directory mount at `/run/ssh` whose `items` rename the selected entry to `authorized_keys`, both with a default mode that follows the container's uid — `0644` non-root, `0600` root; the host key is minted as an **OpenSSH-format** private key (`::generateSSHKeyPair`) and is **never rotated** (persistence provided by the Secret) | The operator mounts those two entries **as Secret volumes** — `ssh_host_ed25519_key` → `/etc/ssh/ssh_host_ed25519_key` and `authorized_keys` → `/run/ssh/authorized_keys` — and sshd reads them **in place: no staging, no copy, no chmod**. Both paths are absolute and outside `$HOME`: a claim mounts over the home, and a mount target created beneath it is root-owned and unwritable (Gap A). OpenSSH enforces its private-key check only on files **owned by the uid reading them**, and a Secret volume materialises its files root-owned — so the mode the reader tolerates follows the reader: a uid-1000 sshd is not the owner, is never checked, and cannot read a file it does not own, so the key must stay `0644`; a root sshd is the owner, so `0644` is refused outright and the mode must be `0600`. The two use different volume kinds because only the authorized keys change while an environment runs: a `subPath` file is frozen at container start, an ordinary Secret mount is not, so rotating a user's keys updates the running container instead of restarting it | ✅ implemented (#173, mount path moved out of `$HOME` with the workspace-ownership change; the authorized keys became a directory mount to drop the restart on key rotation; the mode became uid-dependent in #211). The private key must be in OpenSSH's own format: sshd **rejects PKCS#8 Ed25519** ("invalid format"), which is what the controller used to mint and why the reworked images had no working host key |
| 6 | sshd listening on :22 as uid 1000 | the ssh Service maps `sshServicePort` 22 → `sshContainerPort` 2222; `desiredSecurityContext` grants no capabilities | sshd listens on the unprivileged **2222**. Binding a port <1024 as non-root needs `NET_BIND_SERVICE`, which this closes **by port choice rather than by granting a privilege** — no capability, no `securityContext.sysctls` reliance, nothing for a Restricted PSA to drop. The operator publishes it as the Service's 22 and probes the container port | ✅ Gap B closed, no capability needed; implemented in #173 |
| 7 | `JUPYTER_TOKEN` | `jupyterTokenEnv="JUPYTER_TOKEN"` (:144), injected only for the jupyter type, from `<env>-jupyter-token` Secret `data[token]` | The jupyter server must authenticate with this env value | ✅ (jupyter-server reads `JUPYTER_TOKEN` natively, see §3.B4) |
| 8 | `base_url` = `/dev/<ns>/<env>/` | HTTPRoute forwards the prefix **unchanged** (no URLRewrite filter); the controller injects the prefix into the container as `NOTEBOOK_ARGS=--ServerApp.base_url=<prefix>` (`::withNotebookBaseURL`), replacing a `base_url` the environment declares while keeping that variable's other flags | Jupyter must serve under that prefix via `ServerApp.base_url`, which the injected flag supplies | ✅ Gap C closed: the controller injects the flag and drops a conflicting `base_url` the environment declares; a `NOTEBOOK_ARGS` fed by `valueFrom` cannot be rewritten, so it fails the environment instead of publishing a 404 |
| 9 | Runtime-mode inference | Single-container pod; `type` and `image` are independent axes; the controller injects no `type`/mode env | The same image must decide by itself whether to run jupyter or sshd (e.g. inferred from whether `JUPYTER_TOKEN` is injected / ssh keys are mounted) | ✅ defined by the images: `CUBESTACK_IMAGE` is baked per image and an optional injected `CUBESTACK_TYPE` wins when present (see Gap D) |
| 10 | Multi-service in one container | `sshExposed` adds a 22 Service and mounts keys for jupyter/vscode types, sharing the main container | jupyter type + `ssh.enabled` ⇒ the same process group must run jupyter *and* sshd. The entrypoint starts sshd in the background and hands off to the stock launcher. **The mounted host key is the ssh-enabled signal** — images ship no host key of their own, so `ssh` mode fails fast without it and jupyter simply stays ssh-less | ✅ handled by entrypoint script |
| 11 | GPU extended resource | `::vendorResource`: nvidia `nvidia.com/gpu` / metax `metax-tech.com/gpu`, written to requests and limits at `resources.gpu.count`. With no `gpu` block the key is **omitted entirely** — a zero request would still pin the pod to a node advertising that resource | The image is device-agnostic; `nvidia-smi`/`mx-smi` come from driver injection. A CPU image must not need either | ✅ see §3 |
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
`mountPath` — which always wins — covers a bring-your-own image whose home is somewhere else. The
resolved path is also stated as the container's `HOME`, so a launcher that reads it serves the
workspace without having to know what its own image bakes. That is a promise about `HOME`, not about
the working directory: the controller sets no `container.WorkingDir`, so a process that never reads
`HOME` — an ssh session, say — works in the directory the image gives it.

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

**An environment running as root is the one case where the pairing is not a constraint on the image.**
A root sshd can serve any account, so the image's native account is not the only one it may serve, and
`spec.runtime.securityContext.runAsUser: 0` is served as `root` whatever the image's account is — the
entrypoint admits `root` beside the family account when the container is root, and a non-root sshd does
not admit it at all, since it could not serve it. In the shipped images a root environment ends up
serving `root` alone regardless, because docker-stacks leaves its build account locked in `/etc/shadow`
and only a root sshd can read that file — so that refusal is the image's rather than this design's, and
is recorded in `images/README.md` for whoever changes the base image. The image still has to be *capable*
of it: a root sshd needs `/run/sshd`, which the images now ship, and a root env needs the host key at a
mode its owner accepts (#211). What the *launcher* needs is the controller's to supply rather than the
spec's, the same way `base_url` is (Gap C): `::withRootLauncherEnv` injects `NB_USER`/`NB_UID`/`NB_GID`
and `--allow-root` into `NOTEBOOK_ARGS` for a Jupyter environment at uid 0, so `runAsUser: 0` alone is
the whole of the request. The trio names the account in the image's own passwd database — `0:0` for
root — and not the identity the pod runs as: docker-stacks rewrites the account when the two disagree,
and that rewrite cannot succeed for root, which is measured (a pod running as `0:1000` with
`NB_GID=1000` exits with `userdel: user root is currently used by process 1`, so only the account's own
`0:0` may be named). The shipped images no longer read the trio — a root container on the CPU image
leaves `start.sh` out of the chain entirely — but the injection stays: the controller sees only
`spec.image`, and a stock docker-stacks image, which is what a bring-your-own jupyter environment is,
is served by that launcher and nothing else.

### Gap A — closed: the home mount is writable by uid 1000

An init container chowns the workspace claim's root to the identity the environment runs as, before the
main container starts (`::desiredPermissionInitContainer`), and the workspace PVC uses
`cephfs-ephemeral` (RWX, `assets.go`). The container runs as uid 1000 with `$HOME` on the mount —
`/home/ubuntu` or `/home/jovyan` in the derived case. The image cannot chown itself (non-root), so the
ownership has to be established on the way in.

**Measured with no ownership mechanism at all (2026-09-14, cs2, `cephfs-ephemeral`, uid/gid 1000): the
mount path is `root:root 0755` and a uid-1000 process cannot create anything in it** — not in the
claim's root and not in a subdirectory of it. Both CSIDrivers report `fsGroupPolicy: File`, so nothing
chowned the volume. This was broader than ssh: an environment with `spec.storage` could not write its
own workspace at all.

**Measured with `fsGroup: 1000` (probe pod, same day): solved.** The claim root becomes
`root:ubuntu 2775` and a uid-1000 process writes it. The driver gives the group the owner's permissions
and adds the setgid bit — `0755` → `2775` on directories, `0644` → `0664` on files — and applies that
**recursively, to what exists when the volume is mounted**. Two qualifications carry into the design:

- It is **driver behavior, not a Kubernetes guarantee**. `fsGroupPolicy: File` delegates to the CSI
  driver, and this mode change is ceph-csi's; a driver that implemented only the chgrp half of the
  contract would leave the mount unwritable. Kubernetes guarantees the delegation, not the result.
- The chown reaches what exists **at mount time**. A directory created afterwards — by the account, or
  by the runtime creating a `subPath` mount target — inherits only the parent's group: measured
  `2755 root:ubuntu`, not writable. That is why no platform mount target is created inside `$HOME`.

**Replaced (2026-09-15) by the init container, because `fsGroup` is Pod-scoped.** The measurements above
hold; what sank the mechanism was its reach. `fsGroup` applies to every volume in the pod mounted
**read-write**, so a PVC shared through `spec.volumes` was chowned to the container's group as well — an
ownership change applied to storage the platform does not own, and one that cannot be turned off per
mount: `fsGroup` is a Pod-level field and Kubernetes has no per-mount equivalent. The read-only exemption
that used to cover the shared case is narrower than it reads, too: kubelet applies `fsGroup` on this
driver's behalf (`fsGroupPolicy: File`), its CSI mounter returns before any chown when the volume is
read-only (`csiMountMgr.supportsFSGroup`), and a driver advertising `VOLUME_MOUNT_GROUP` does the work
itself — so the exemption was one driver's behavior to keep, not a platform guarantee to rely on.

An init container that mounts the workspace claim and nothing else has no path through which it could
reach a referenced PVC. It runs as root with every capability dropped and `CAP_CHOWN`, `CAP_FOWNER` and
`CAP_FSETID` added back (see below for which of the three each path needs), sets the claim root's mode
and owner (`chmod 2775` **before** the `chown` — see below), and runs under `set -e` so a step that fails
stops the environment rather than starting it against a volume it could not initialize. Four
consequences follow:

- **The pod carries no `fsGroup`, and no pod-level security context at all.** Nothing else mounted into
  the pod is touched.
- **A referenced PVC is mounted exactly as it is.** A PVC supplied through `spec.volumes` — including one
  standing in as the workspace — has to carry permissions the environment's account can work with. The
  platform does not modify storage it merely references.
- **The repair is conditional and recursive, like the mechanism it replaces.** The script reads the
  claim root's owner and does nothing when it is already the environment's identity; only on a mismatch
  does it set the mode and `chown -R` the tree. Those are the two choices `fsGroupChangePolicy:
  OnRootMismatch` made — never walk a workspace that is already right, repair all the way down when it is
  not — so the walk runs once, on the start after an ownership change, and not on every start. The claim
  is provisioned empty and belongs to this environment alone, so everything *already* in it is the
  environment's to own; measured on cs2, a `deep/nested` created by a root process is left `0:0 755` and
  unwritable by uid 1000 under a root-only chown, and becomes `1000:1000` and writable under `chown -R`,
  which is what the `fsGroup` walk used to deliver. The setgid bit set with the mode then carries the
  group onto everything created afterwards — measured: a directory the account creates comes out
  `1000:1000`. The condition is the owner alone, as it was for `OnRootMismatch`; a root whose owner is
  already right but whose mode has drifted from `2775` is left as the account set it, and content an
  account deliberately left root-owned inside an otherwise-correct workspace is not reclaimed.
- **A namespace hosting an environment with `spec.storage` must not enforce the Restricted Pod Security
  Standard.** Root and any of the three capabilities are rejected there, and Pod Security Admission has no
  per-container exemption — confirmed on cs2 with `--dry-run=server`: the pod is admitted under `baseline`
  and refused under `restricted` with `runAsUser=0` and the added capabilities named among the violations.
  Baseline is the floor, and it is enough: `CHOWN`, `FOWNER` and `FSETID` are all capabilities Baseline
  still allows, and Baseline does not constrain `runAsUser`. This is the one place the design takes a policy
  exception rather than removing the dependency — unlike Gap B, where removing it was possible. It is the
  init container that costs the exception, not the environment: one without storage runs under `restricted`,
  the platform pod template carrying the runtime-default seccomp profile that level requires.

**A claim outlives the identity it was initialized for, and that is what the capabilities are for.** The
root of a claim is repaired to whatever identity `spec.runtime.securityContext` names *now*, but the
claim is not re-provisioned when that spec is edited — `runAsUser` and `runAsGroup` are mutable and the
PVC persists. So the init container can find a root owned by the identity the environment **used to
run as**: a uid it is neither the owner of nor grouped with. All three cases were run on cs2 against a
cephfs claim whose root was left `1000:1000` and re-targeted to `2000:2000`:

- **`CAP_CHOWN` alone fails the environment.** The `chmod` on a directory root does not own is `EPERM` —
  `CAP_CHOWN` does not help — and `set -e` stops the init container, so the environment never starts and
  the ownership repair behind it never runs. Measured: `chmod: /managed: Operation not permitted`.
- **`CAP_FOWNER` makes it succeed but not stick.** The mode change now comes from a process outside the
  file's group, which Linux answers by clearing `S_ISGID`: measured `2000:2000 0775`, setgid lost.
  `CAP_FSETID` is what keeps the bit.
- **`CAP_CHOWN` + `CAP_FOWNER` + `CAP_FSETID` repairs it.** Measured `2000:2000 2775`, the tree chowned,
  every level writable by the new identity, and a directory it creates afterwards coming out gid 2000.

The `chmod` still precedes the `chown`, but that order is no longer what decides correctness — it is the
cheaper direction on the common path, where the claim is fresh: the init container owns that root and is
grouped with it, so the mode is set with no capability involved and no chance of losing `S_ISGID`, and
the `chown` that follows preserves `S_ISGID` because the kernel clears it only on non-directories.
Measured on a fresh claim with all three held: `1000:1000 2775`, uid 1000 writes, and a directory it
creates inherits gid 1000.

The same probes settled the `~/.ssh` design: **the subPath file mount does not need the parent to
exist.** `subPath` mounts are delegated to the runtime, and runc's `createMountpoint` creates a file bind
target's parent directory (`MkdirAllInRootOpen`, 0755) as root *inside the volume it is mounted over* —
verified with `/proc/self/mountinfo` showing the created `~/.ssh` on the ceph mount. The pod starts and
ssh works, but that directory is root-owned and, per the second qualification above, is not writable by
the account. So the platform keys are **not** mounted into `$HOME` at all: the Secret's
`authorized_keys` lands at the absolute `/run/ssh/authorized_keys`, which the drop-in's
`AuthorizedKeysFile` names, and nothing is mounted at `$HOME/.ssh`. (That path is now reached by a
whole-Secret directory mount rather than a `subPath` file, so the parent-creation behaviour above is
what the host key's mount relies on.) The account's `~/.ssh` is then
entirely its own — on a claim-mounted home it does not exist until the account creates it, which the
init container's ownership repair of the claim now makes possible; with no claim, or a claim elsewhere,
the image's baked `0700` directory serves. No `emptyDir` stand-in is needed for either case, and no
mount depends on the order in which volumes and containers are set up.

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
asset URLs and 404s break. The prefix had no source beyond the route that publishes it. Two options:

1. The controller injects the prefix through jupyter's own knob —
   `NOTEBOOK_ARGS=--ServerApp.base_url=/dev/<ns>/<env>/`. The stock launcher appends `NOTEBOOK_ARGS` to
   its command and the overlay adds no launcher of its own, so **no image change is needed**; the
   controller must merge rather than clobber a value the user also sets.
2. The Gateway adds a URLRewrite that strips the prefix, and jupyter serves at `/` as usual.

**Recommendation: option 1** (consistent with the route design's "container serves under that
base_url" semantics, no per-environment gateway rewriting, and no image-side logic — an earlier draft
had the image read a `CUBESTACK_BASE_URL` env, which the stock-native overlay deliberately does not
do); the Gateway must still pass websockets through.

**Closed as recommended (option 1)**: `::desiredPodSpec` runs `::withNotebookBaseURL` for the jupyter
type, which adds or extends `NOTEBOOK_ARGS`. The prefix comes from `::webPath`, the same function
`::desiredHTTPRoute` matches on and `::buildEndpoints` publishes, so the served prefix and the
published one cannot drift: the route is the controller's, so the prefix is too. A `base_url` the
environment declares of its own is therefore dropped and the injected one appended, with every other
`NOTEBOOK_ARGS` flag kept. `JUPYTER_TOKEN` sets the precedent — a value the controller owns is not
left to the user to disagree with.

The one declaration the controller cannot rewrite is a `NOTEBOOK_ARGS` fed by `valueFrom`: its value
is unreadable while reconciling (reading it would mean watching whatever it reads), so whether it
hides a conflicting `base_url` is unknowable. `::unsupportedNotebookArgsReason` fails such an
environment — `Phase: Failed`, `Ready=False` with the reason `NotebookArgsUnusable`, nothing
provisioned — rather than publishing an address that 404s.

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

**Not the base that shipped** (§6.1): the platform builds on the vendor's NGC **PyTorch** release
instead, which already carries the toolkit, torch and JupyterLab — so the base/runtime/devel split
surveyed above is not a choice this work had to make. The driver findings apply unchanged, being
properties of the node rather than of the image.

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
  affects the software selection inside `jupyter-maca-pytorch` (see §6).

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
   └── GPU: a vendor base, mirrored verbatim:     self-authored jupyterlab, not this overlay)
           jupyter-maca-pytorch / ssh-maca-pytorch (Metax, one image per mode: §6.2)
           jupyter-cuda-pytorch / ssh-cuda-pytorch (NVIDIA, the same two modes: §6.1)
```

Key points:

- **Reaching the CPU images.** A CPU image is selected by **omitting `spec.resources.gpu`**. That is
  what exempts it from the brand gate (§2 #1) and keeps the vendor GPU resource out of the pod spec
  (§2 #11). The block is the request: it names both the vendor and the count, so there is no way to
  state a vendor without a device, and its absence is the only spelling of "no accelerator". Saying
  nothing about GPUs therefore means no GPU — a manifest that used to rely on the old `gpuCount`
  default of 1 has to name a `gpu` block to keep its accelerator.
- **What is shared is the runtime config**: the entrypoint (`images/common/entrypoint.sh` — mode
  selection, the optional sshd, and the hand-off to the image CMD) *and* the sshd drop-in
  (`images/common/sshd/`), which GPU and CPU images and the docker-stacks overlay do not duplicate. The
  drop-in carries the two per-family values as placeholders, filled by the installer beside it
  (`images/common/sshd/install-dropin.sh`) — the login account `@SSH_USER@` (`ARG SSH_USER`) and the
  session environment `@SSH_ENV@`, which the installer assembles from the variable names each Dockerfile
  gives it, read out of the build shell's environment, i.e. the base's own. It is a placeholder because
  sshd's `SetEnv` replaces a session's environment rather than extending it, so a fixed literal would
  hide whichever family's toolchain it did not name. The mount-contract paths (`AuthorizedKeysFile`,
  `HostKey`) are `%h`-relative, so one file serves every family and the shared parts cannot drift apart.
  The jupyter launcher (`images/common/jupyter/start-jupyter.sh`) is shared too, between the two images
  that need one: it is what expands `NOTEBOOK_ARGS` into `--ServerApp.base_url` (Gap C), which the
  docker-stacks overlay does not need because upstream's launcher already does it.
- **Account / `HOME` follow the image family** (see §2 contract): the **self-authored** platform
  layer (`ssh-ubuntu22.04`, `jupyter-maca-pytorch`, `ssh-maca-pytorch`, `jupyter-cuda-pytorch`,
  `ssh-cuda-pytorch`) ships account
  `ubuntu` uid/gid 1000
  with `$HOME=/home/ubuntu`, named per environment via `spec.runtime.user` — there is no
  upstream UX to preserve, so uniformity is free. The **stock-derived jupyter** image is **not**
  conformed: it keeps `jovyan`
  (uid 1000, gid 100) and `/home/jovyan` exactly as docker-stacks ships them, so users familiar with
  the stock image see stock behavior; it adds sshd only for `ssh.enabled`. An environment selects
  either layout through the same two fields, so neither family bends to the platform's defaults.
- **The GPU images reuse the same self-authored platform layer**, and there is one per mode and per
  vendor: a jupyter-type environment picks `jupyter-maca-pytorch` or `jupyter-cuda-pytorch` by the
  vendor it asks for, and an ssh-type environment on a GPU-vendor image gets the ssh sibling of the
  same pair, which runs sshd alone. The split is at the image, not the controller: the
  mode is baked into each image as `CUBESTACK_IMAGE` and the controller injects no type today, so a
  single image cannot act on that distinction (§6.1, §6.2). The CPU pair is split the same way
  (`jupyter-minimal` / `ssh-ubuntu22.04`).

---

## 5. Registry organization and tag scheme (recommended)

Current anchors: `config/samples/ai_v1alpha1_devenvironment.yaml` and controller unit tests pin
`harbor.local/ai-images/base-cuda:11.8-pytorch2.2` / `harbor.local/ai-images/base-maca:1.0` — the
offline in-cluster registry host form. Those are fixture values for a *user-chosen* image, not the
platform's own publishing target, so they do not dictate the project below.

- **Project name**: `suanova` — our images publish as
  `harbor.isuanova.com/suanova/`
  `{ssh-ubuntu22.04,jupyter-minimal,jupyter-maca-pytorch,ssh-maca-pytorch,jupyter-cuda-pytorch,ssh-cuda-pytorch}`.
  That
  is the
  project CI already publishes operator and portal to (`suanova/cubestack-{operator,ui}`), so every
  CubeStack image lives under one project on the one host. **The repository names the axis a user
  selects on and that changes slowly; the tag carries what changes per build.** Two axes qualify.
  For the ssh image it is the Ubuntu release — a coarse LTS cadence, and a compatibility contract in
  apt/dpkg and libc — so the base release belongs in the name. For the jupyter image it is the
  docker-stacks stack variant (`foundation → base → minimal → scipy → …`), which decides what is
  preinstalled and likewise moves slowly, hence `jupyter-minimal`. What does *not* qualify is a value
  that moves every release: upstream's *date* is exactly that, so it stays in the tag, and its Ubuntu
  base is upstream's choice rather than our pin (naming it would assert something we do not control).
  The GPU images name their vendor by the same rule — it is what the user picks on: the two vendor
  pairs, `jupyter-maca-pytorch` / `ssh-maca-pytorch` for Metax and `jupyter-cuda-pytorch` /
  `ssh-cuda-pytorch` for NVIDIA, each naming the vendor's package family rather than the platform's
  own `base-maca` / `base-cuda` because what ships is a jupyter image prepared from that package, not a
  bare base (§6.1, §6.2). The **mode** is a second such axis, and it is why each vendor pair is two
  repositories rather than one repository with a tag or a flag: `ssh-maca-pytorch` is the same base
  and platform layer without JupyterLab, and `ssh-cuda-pytorch` is its NVIDIA twin. The image carries
  its mode as baked state
  (`CUBESTACK_IMAGE`), the controller injects no type (§6.2), and a repository is what a
  DevEnvironment names in `spec.image` — so the axis has to be spelled in the name for either mode to
  be selectable. Offline
  installs surface the same images at `harbor.local`; only the host is swapped, by packaging/rewriting.
- **Tags**: content-locked and reproducible. Examples:
  - `jupyter-cuda-pytorch:<ngc-release>-<sha>` / `ssh-cuda-pytorch:<ngc-release>-<sha>`, e.g.
    `26.08-<sha>`. Here the release *is* the compatibility contract: NGC pins python, torch and CUDA
    together in one tag rather than naming them as separable axes, so unlike the earlier draft's
    `base-cuda:<cuda>-py<python>-torch<torch>` there is one axis and not three — there is no torch
    version to state separately, and repeating the python field the release also encodes (`-py3`) would
    restate what it already fixes.
  - `jupyter-maca-pytorch:<maca-version>-py<python>-torch<ver>`, e.g. `3.9.0.12-py310-torch2.4`. The
    same axes the base is built on, for the same reason the ssh image carries its Ubuntu release: the
    vendor package version is the compatibility contract of the whole stack, and it is what a user
    picks between. It moves on the vendor's cadence, not ours, so it stays in the tag while the
    repository keeps the stack identity.
  - `ssh-maca-pytorch:<maca-version>-py<python>-torch<ver>`, e.g. `3.9.0.12-py310-torch2.4` — the
    ssh sibling of the entry above, resolved from the same vendor base with the same axes, so one
    base bump moves both tags together.
  - `ssh-ubuntu22.04:<date>`, e.g. `20260910`. The repository name carries the base release, so the tag
    only identifies the build; a distro bump mints a new repository under the same scheme
    (`ssh-ubuntu24.04:<date>`) rather than changing the tag shape.
  - `jupyter-minimal:<base-date>`, e.g. `2026-09-07`. The docker-stacks images version by date rather
    than by python or lab version, so the overlay inherits upstream's identity as its tag; append
    `-<date>` when the overlay changes without the base moving.
  - `make push` defaults `TAG` to the short commit SHA, so a bare command yields a traceable,
    non-floating reference; pass an explicit tag from the schemes above to publish a release. The SHA
    names the last commit rather than the working tree, so publishing expects a committed tree.
    The MACA pair does not wait for that explicit tag: `MACA_TAG` reads the two axes out of
    `MACA_PACKAGE` and publishes `<maca-version>-py<python>-torch<ver>-<sha>` — derived, not written
    twice, so the tag cannot name a base the image was not built from, and the SHA still ends it so a
    re-build of the overlay on an unchanged base moves the reference rather than redefining it. The
    CUDA pair works the same way off `CUDA_PACKAGE`, with the one axis that tag carries:
    `<ngc-release>-<sha>`. Both derivations are guarded — an unreadable vendor release stops the build
    rather than publishing a name with an empty field.
  - CI adds a second kind of pinned tag on a `vX.Y.Z` release: the platform release version, e.g.
    `ssh-ubuntu22.04:1.0.0`. The schemes above say what the image *is*; this says which CubeStack
    release it shipped with. A release publishes it instead of `:latest`, which stays a main-only tag.
  - Both forms of reference are published: the pinned tag above *and* a moving `:latest` that the push
    re-points at the image it just built, so a deployment may track the newest publish or pin exactly.
    Re-publishing an older commit therefore moves `:latest` backwards, which is inherent to the tag —
    the pinned tag is what a reproducible deployment should reference.
- The brand marker only requires the image name to contain the vendor's token, `cuda` or `maca` (§2 #1),
  orthogonal to the project/tag choices above.

---

## 6. Image inventory and composition

### 6.1 `jupyter-cuda-pytorch` and `ssh-cuda-pytorch` (NVIDIA)

Shipped as `images/jupyter-cuda-pytorch/` and `images/ssh-cuda-pytorch/`. This section was written as
`base-cuda` on a `nvidia/cuda` **runtime** base with "bake torch or not" and "runtime or devel" both
open; what ships answers both at once and not separately, because the base is NVIDIA's own NGC
**PyTorch** image (`nvcr.io/nvidia/pytorch:<release>-py3`) — the vendor's torch+CUDA stack rather than
a bare runtime the platform would assemble torch onto. A `nvidia/cuda` base would have meant owning the
wheel manifest and the CUDA/torch compatibility matrix; this one makes the vendor release the
compatibility contract, and it is also the image a user of this stack already knows. The naming is
§5's rule applied to it, exactly as §6.2's rename was: a jupyter image prepared from the vendor
package, not a bare base.

- **Base**: the NGC PyTorch release, **mirrored verbatim** into
  `harbor.isuanova.com/mirrors/nvcr.io/nvidia/…` and pinned by digest — the same delivery the Metax
  package gets, and for the same reason: a vendor artifact the platform serves rather than republishes,
  so it has no `BASE_MIRRORS` entry in `operator/Makefile` and needs none. It is **amd64-only** (the
  mirror carries one `linux/amd64` manifest), so both images are single-platform like the MACA pair.
- **Unlike the MACA base, it is not bare.** It ships the account — uid/gid 1000 `ubuntu` at
  `/home/ubuntu`, which is the self-authored family's layout exactly, so the overlay **inherits** it
  and must not `useradd` over it — plus one python 3.12 with torch in its dist-packages (no second
  interpreter, so no PATH correction), JupyterLab bound to that interpreter as a bare-`python`
  kernelspec, an `ENTRYPOINT`, and the PATH / `LD_LIBRARY_PATH` / `LIBRARY_PATH` that put the CUDA
  stack on the account's search path.
- **Overlay**: the platform layer (§4) minus what the base already provides — `openssh-server`, `tini`,
  the shared entrypoint and sshd drop-in, the shared jupyter launcher, the `ssh-copy-id` target
  `/home/ubuntu/.ssh`, `/run/sshd`, and `CUBESTACK_IMAGE`. Nothing is installed from pip: this base's
  JupyterLab is the one the notebook runs on. The base's `nvidia_entrypoint.sh` is displaced — it
  prints the vendor's banner and runs hardware diagnostics, which is not what a DevEnvironment pod log
  is for, and the entrypoint that decides what a container runs is the platform's.
- **Acceptance mapping**: as the MACA pair, minus `mx-smi`: `python3` on the account imports the
  vendor torch and prints the release's version, the notebook kernel resolves to that same interpreter,
  jupyter 8888 behind token + `base_url`, the ssh session carries the CUDA stack's paths, and ssh 2222
  key-auth login as `ubuntu`. `nvidia-smi` is **not** asserted — it comes from driver injection at
  container start (§3.A), so it is a check of the node rather than of the image.
- **Decision**: self-authored platform layer on the **mirrored vendor base**, with the account
  inherited from it. What stays open is on-node, as for MACA: the node's driver has to be at least the
  CUDA version this release requires, and whether the vendor stack works for uid 1000 once a device is
  present is untested locally.
- **The ssh sibling (`ssh-cuda-pytorch`)**: the same base and the same platform layer without
  JupyterLab — `CUBESTACK_IMAGE=ssh`, `EXPOSE 2222`, no `CMD`. This base *does* ship JupyterLab whether
  or not this image uses it, so what the mode decides is what runs rather than what is installed, and
  the smoke asserts the ssh image's process tree instead of the absence of a binary. Everything above
  that is not jupyter-specific applies to it unchanged: the vendor base pinned by digest, the
  amd64-only footgun, the driver question.

### 6.2 `jupyter-maca-pytorch` and `ssh-maca-pytorch` (Metax)

Shipped as `images/jupyter-maca-pytorch/` and `images/ssh-maca-pytorch/`; this section was written as
`base-maca`, and the rename is §5's naming rule applied to what actually ships — a jupyter image
prepared from the vendor package, not a bare base.

- **Gate: cleared, differently than expected.** Metax still has no anonymous public registry (§3.C),
  but the platform does not have to build a MACA base from the commercial package: the upstream vendor
  image (`public-library/maca-pytorch:<ver>-<os>-<arch>`) is **mirrored verbatim** into
  `harbor.isuanova.com/mirrors/cr.metax-tech.com/public-library/…`, and that mirror is the build base.
  What remains unconfirmed is the **injection model** — whether `container-runtime` injects MACA on
  demand for non-root uid-1000 containers. This image bakes the stack regardless, so it does not depend
  on injection being available; if injection does apply, the two may overlap.
- **Base**: the mirrored vendor package, pinned by digest. It is a **bare SDK image**, not a distro:
  no `config.User` (so it runs as root), no `ENTRYPOINT` at all (`Cmd: ["/bin/bash"]`, which exits
  immediately), no sshd, no jupyter, no non-root account — stock `ubuntu:22.04` plus MACA at
  `/opt/maca` and a baked `/opt/mxdriver`. It therefore cannot back a DevEnvironment as it stands, and
  the overlay is the whole platform layer rather than a delta. It is also **single-arch** (the
  `-amd64` suffix is part of the package tag, not a multi-arch index), so the published image is
  amd64-only — see `images/README.md`.
- **Overlay**: the platform layer (§4) — account `ubuntu` (1000:1000, `$HOME=/home/ubuntu`), the shared
  entrypoint and sshd drop-in — plus the jupyter launch chain, which this base has no equivalent of:
  `common/jupyter/start-jupyter.sh` stands in for docker-stacks' `start.sh` and is what expands
  `NOTEBOOK_ARGS` (Gap C), since jupyter itself does not read that variable. It is shared with the CUDA
  image rather than written per vendor, because what it does does not depend on the base (§6.1).
- **Software stack**: the vendor's own python and `torch+metax` build, inherited untouched — jupyterlab
  is installed into that interpreter rather than beside it; stock CUDA wheels remain unusable
  (cu-bridge recompile).
- **Acceptance mapping**: `mx-smi` visible and `metax-tech.com/gpu` satisfiable — on a Metax node only.
  The local smoke covers everything that does not need one: non-root 1000, `/home/ubuntu`, jupyter
  8888 behind token + `base_url`, ssh 2222, and that `/opt/maca` is readable by the account that runs.
- **Decision**: self-authored platform layer on the **mirrored vendor base**. Two risks stay open and
  are both on-node: the **baked driver** (`/opt/mxdriver` in the base vs. whatever the node injects —
  which wins is untested), and whether the vendor stack works for uid 1000 once a device is present.
- **The ssh sibling (`ssh-maca-pytorch`)**: the same mirrored base and the same platform layer, without
  JupyterLab — `ca-certificates`, `openssh-server`, `tini`, account `ubuntu` (1000:1000,
  `$HOME=/home/ubuntu`), the shared entrypoint with `CUBESTACK_IMAGE=ssh`, `EXPOSE 2222`, no `CMD` (the
  ssh branch execs sshd and never reaches `"$@"`). Everything above that is not jupyter-specific applies
  to it unchanged: the vendor base pinned by digest, the amd64-only footgun, the baked driver question.
  - **Why a second repository rather than a flag.** The mode is baked and the controller injects no
    type, so an ssh-type DevEnvironment pointed at the jupyter image would run JupyterLab with nothing
    probing it. Splitting at the image makes §4's claim — "an ssh-type environment on a GPU-vendor
    image runs only sshd" — true today, with no controller change. The CPU pair splits the same way
    (`jupyter-minimal` / `ssh-ubuntu22.04`), so this is the existing pattern, not a new one.
  - **Why two Dockerfiles rather than one parameterized build.** `EXPOSE` cannot be made conditional
    (the ssh image would falsely declare 8888) and neither can the launcher `COPY` (it would carry a
    file it never runs); what could drift between them, the vendor base pin, is already single-sourced
    in `images/Makefile`'s `MACA_BASE`. It installs nothing from pip either: the vendor base ships no
    pip, and the image adds none.
  - **Acceptance mapping**: as the jupyter image, minus jupyter — ssh 2222 key-auth login as `ubuntu`,
    the shared host-key contract, and `/opt/maca` readable by uid 1000. The session environment named
    in the sshd drop-in is what keeps the vendor toolchain (`/opt/maca/*/bin`, `/opt/mxdriver/bin`)
    reachable from an ssh session, which is the whole point of this image; the smoke asserts the
    session environment matches the container's rather than naming tools, since the vendor also
    symlinks some of them into `/usr/bin`.

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
    ecosystem trimmed; the GPU variants remain the vendor-base images' self-authored platform layer
    (§6.1, §6.2).
- **`ssh-ubuntu22.04` (CPU)**: self-build (ubuntu22.04 + openssh-server + entrypoint) — simplest,
  smallest attack surface; self-authored (no upstream stock UX to preserve) so it ships account
  `ubuntu` uid/gid 1000 with `$HOME=/home/ubuntu` (`spec.runtime.user: ubuntu`).
  Key material is mounted from the Secret, never staged (§2 #5).
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
- **CI**: two workflows, split by what they may do, mirroring how operator and portal are handled.
  `ci-operator.yml`'s `images-smoke` job builds and smokes every image on any change under `images/**`
  that is not markdown, on **pull requests** — that is what validates them, and it needs neither a
  cluster nor registry credentials. It does that in two steps with a `docker image prune -af` between
  them, so only one vendor base is resident on the runner at a time: the two vendor bases together are
  over 70 GB unpacked, well past what the reclaim leaves free. Publishing is `ci-images.yml`, on a push
  to `main` that changes
  `images/**` or the workflow file itself (a change to the lanes starts every job), in **three jobs split
  by image family** — `cpu` (ssh + jupyter), `maca` (the Metax pair) and `cuda` (the NVIDIA pair). Each smokes what it publishes,
  pushes the short-SHA tag with `PUSH_LATEST=0`, and moves its own mutable `:latest` only if `main`'s
  copy of the paths that decide those images still matches that commit. Three properties hold that
  together, and each is load-bearing: a family's trigger paths, its gate pathspec and its
  `retag-latest` list are all the same set, so any later commit that could fail its gate has itself
  started a run of that family to move the tag; a family's `:latest` is moved only by a run that
  published it; and each family carries its own concurrency group, so only a run that would redo the
  same work can cancel one in flight. The split is what keeps a merge touching only the CPU pair from
  pulling a 10.5 GiB vendor base twice on its way to publishing images it could not have changed. A
  `vX.Y.Z` tag publishes all three families at the version it names and moves no `:latest` (§5).
- **Still open**: the offline export script (§3.D) — nothing in the repo produces the bundle yet, so
  an offline install is assembled by hand from the published images.

---

## 8. Platform-side changes to close (not image-side)

| Item | Owner | Recommendation | Blocks |
|---|---|---|---|
| A workspace writability check (uid 1000 writing the home mount: `/home/ubuntu` self-authored, `/home/jovyan` jupyter) | workspace storage (cephfs-ephemeral) | **Closed controller-side**: an init container sets the claim root's mode and chowns it — recursively, but only when the owner does not already match — to the container's own identity on the way in, measured on `cephfs-ephemeral`, so the storage class needs no change (Gap A) | — |
| B non-root sshd binding :22 | controller | **Closed image-side**: sshd listens on 2222 and the Service publishes it as 22, so no capability is ever granted. Retargeting `targetPort`/probe is #173 | base image ssh acceptance |
| C injecting jupyter `base_url` | controller | **Closed controller-side**: `::withNotebookBaseURL` injects `NOTEBOOK_ARGS=--ServerApp.base_url=/dev/<ns>/<env>/` (replaces a `base_url` the environment declares, keeps its other flags; a `valueFrom`-fed `NOTEBOOK_ARGS` is refused) — docker-stacks' launcher honours it, so the CPU jupyter image needs no change. An image with a launcher of its own has to expand the variable itself; the two vendor jupyter images share one that does (`images/common/jupyter/start-jupyter.sh`, §6.1, §6.2) | — |
| D mode env (optional) | controller | Inject `CUBESTACK_TYPE`, entrypoint reads it first | vscode hook |

---

## 9. Decision summary and items to confirm

| Item | Conclusion | Status |
|---|---|---|
| Two-family model: self-authored platform layer (`ubuntu` 1000, `$HOME=/home/ubuntu`) + docker-stacks thin overlay (`jovyan`/`/home/jovyan`, stock-native, ssh added) — shared entrypoint + layout named per environment (`spec.runtime`, `spec.storage.mountPath`) | §4 | ✅ recommended here |
| GPU image = self-authored platform + runtime layer (layered reuse) | §4 | ✅ recommended here |
| Project `suanova`, host `harbor.isuanova.com` (online) / `harbor.local` (offline) | §5 | ✅ recommended |
| Dockerfiles live in monorepo `images/` | §7 | ✅ decided — landed, with CI on both sides (smoke per PR, publish on merge); the offline export script is still open |
| NVIDIA images: self-authored platform layer on the **mirrored** NGC PyTorch vendor base, which already supplies the account, the interpreter, torch and JupyterLab — so the "bake torch or not" and "runtime or devel" questions this row used to leave open are answered together by the base choice — plus the shared jupyter launcher; amd64-only, one image per mode, `jupyter-cuda-pytorch` and `ssh-cuda-pytorch` | §6.1 | ✅ shipped in `images/` (the earlier `base-cuda` on a bare `nvidia/cuda` runtime is superseded); ⚠️ **to confirm on an NVIDIA node**: the node's driver against the release's CUDA requirement, and the vendor stack under uid 1000 once a device is present |
| Metax images: self-authored platform layer on the **mirrored** vendor base, plus the shared jupyter launcher (`common/jupyter/` — the vendor base ships none), amd64-only — one image per mode, `jupyter-maca-pytorch` and `ssh-maca-pytorch` | §6.2 | ✅ shipped in `images/`; ⚠️ **to confirm on a Metax node**: driver model (the base's baked `/opt/mxdriver` vs. what the node injects) and `mx-smi`/`metax-tech.com/gpu` |
| jupyter-minimal = stock-native thin-overlay on Quay minimal-notebook + ssh only | §6.3 | ✅ decided (shipped in images work) |
| ssh-ubuntu22.04 self-build, account `ubuntu`/`$HOME=/home/ubuntu` (`spec.runtime.user: ubuntu`) | §6.3 | ✅ recommended here |
| Gaps A/B/C/D closure | §8 | ✅ A, B and C closed (A and C controller-side, B image-side); ⚠️ D remains, and only a vscode type needs it |

After review: promote the "✅ recommended" items to "decided", backfill the "to confirm" items, and
post a summary of this document so downstream image-build work can proceed.
