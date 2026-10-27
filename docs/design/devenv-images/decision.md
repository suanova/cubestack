# DevEnvironment base images: sourcing / composition / delivery decision

## 1. Context and goal

Platform DevEnvironments are driven by the operator's `DevEnvironment` CRD, which lets a user pick a
container image (`spec.image`) combined with semantic axes such as `type` (jupyter / ssh / vscode),
GPU vendor, storage, and an SSH toggle. This module delivers that **base-image set**: images that
satisfy the image contract already fixed in the operator, are published to a container image
registry, and can be bundled for offline installation.

In scope: the image set that now ships — **one image per (accelerator, stack) cell**: `cpu-pytorch`
(CPU, on `ubuntu:22.04`), `maca-pytorch` (Metax), and `cuda-pytorch` (NVIDIA), each carrying its
family's PyTorch build. The naming rule those names follow is §5.1. Each image serves **both**
runtime modes: `spec.type` is injected as `CUBSTACK_TYPE` and the entrypoint runs JupyterLab or sshd
from it (Gap D). This supersedes the six-image set this document originally scoped — the CPU pair
`jupyter-minimal` / `ssh-ubuntu22.04` and a jupyter/ssh pair per vendor. §6 records what shipped and
why the pairs were merged; `images/README.md` and `docs/design/devenv-images/image-contract.md` are
the current description of the images themselves. Plus offline packaging / container image registry
publishing. **Out of scope**: code-server, `DevEnvironmentTemplate`, GPU driver / RDMA bring-up
(Installer).

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
| 1 | Brand marker | `devenvironment_controller.go::brandMismatchReason`: image name (lowercased) must **contain** the accelerator's token — `cuda` for nvidia, `maca` for metax. Checked **only when a GPU is requested** — an absent `spec.resources.gpu` block is exempt | Image must name its accelerator when it is a GPU image; CPU images are named freely. `cuda-pytorch` and `maca-pytorch` both do, and a user image still satisfies it by containing `cuda` / `maca` | ✅ consistent with the brand gate; the family names carry the same token, so no exception is needed |
| 2 | Type → port | `::mainContainerPort`: jupyter 8888 / vscode 8080 / ssh `sshContainerPort`; readiness probe = TCP on the main port | The server must listen on the type's port and accept TCP — **except ssh**, where the container listens on the unprivileged **2222** (see B) and the Service publishes that as 22 | ✅ implemented (#173): the probe targets the container port (2222 for ssh) and the Service publishes `port: 22 → targetPort: 2222` |
| 3 | Non-root default | `::desiredSecurityContext`: `runAsUser=runAsGroup=1000`, `runAsNonRoot=true` (only lifted when the user explicitly sets `0`) | Image must run as the **uid/gid the spec resolves to** (`spec.runtime.securityContext`, platform default 1000/1000), non-root, incl. writing `$HOME` (all first-party images ship uid 1000) | ✅ (but see #6, #9) |
| 4 | `$HOME` = the workspace mount; the working directory is separate | `::withWorkspaceHome` states the resolved mount path as the container's `HOME`, for every type, whenever `spec.storage` is set; `desiredPodSpec` sets no `container.WorkingDir`, and no image's own account home is rewritten | The container is **told** where its home is; an image must act on that for anything meant to land on the workspace. The mount path is `spec.storage.mountPath`, else the home the runtime identity implies — every first-party image runs account `ubuntu` and gets `/home/ubuntu`. A non-root account must be able to **write** that mount, which no image can arrange for itself | ✅ Gap A closed for `HOME`: an init container repairs the claim's ownership — the root alone while it already matches, the whole tree when it does not — before the container starts. The one shared jupyter launcher ends up serving the stated home rather than one the image bakes, and enters it — so a notebook and a terminal opened from it both land on the workspace. **The ssh family does not read `HOME`**: it keeps `WORKDIR /home/ubuntu` (an ssh session starts there), which is the claim when the mount resolves there. A working-directory guarantee for a non-default mount is **not implemented** |
| 5 | SSH key mount | `assets.go:60-77`: Secret data keys `ssh_host_ed25519_key`(+`.pub`) and the authorized-keys entry, the two in **separate Secrets** — the controller's `<env>-ssh-host-key`, and `<env>-ssh-client-key` or the user's `spec.ssh.authorizedKeysSecret`; `::desiredPodSpec` mounts the host key as a read-only `subPath` file and the authorized keys as a whole-Secret directory mount at `/run/ssh` whose `items` rename the selected entry to `authorized_keys`, both with a default mode that follows the container's uid — `0644` non-root, `0600` root; the host key is minted as an **OpenSSH-format** private key (`::generateSSHKeyPair`) and is **never rotated** (persistence provided by the Secret) | The operator mounts those two entries **as Secret volumes** — `ssh_host_ed25519_key` → `/etc/ssh/ssh_host_ed25519_key` and `authorized_keys` → `/run/ssh/authorized_keys` — and sshd reads them **in place: no staging, no copy, no chmod**. Both paths are absolute and outside `$HOME`: a claim mounts over the home, and a mount target created beneath it is root-owned and unwritable (Gap A). OpenSSH enforces its private-key check only on files **owned by the uid reading them**, and a Secret volume materialises its files root-owned — so the mode the reader tolerates follows the reader: a uid-1000 sshd is not the owner, is never checked, and cannot read a file it does not own, so the key must stay `0644`; a root sshd is the owner, so `0644` is refused outright and the mode must be `0600`. The two use different volume kinds because only the authorized keys change while an environment runs: a `subPath` file is frozen at container start, an ordinary Secret mount is not, so rotating a user's keys updates the running container instead of restarting it | ✅ implemented (#173, mount path moved out of `$HOME` with the workspace-ownership change; the authorized keys became a directory mount to drop the restart on key rotation; the mode became uid-dependent in #211). The private key must be in OpenSSH's own format: sshd **rejects PKCS#8 Ed25519** ("invalid format"), which is what the controller used to mint and why the reworked images had no working host key |
| 6 | sshd listening on :22 as uid 1000 | the ssh Service maps `sshServicePort` 22 → `sshContainerPort` 2222; `desiredSecurityContext` grants no capabilities | sshd listens on the unprivileged **2222**. Binding a port <1024 as non-root needs `NET_BIND_SERVICE`, which this closes **by port choice rather than by granting a privilege** — no capability, no `securityContext.sysctls` reliance, nothing for a Restricted PSA to drop. The operator publishes it as the Service's 22 and probes the container port | ✅ Gap B closed, no capability needed; implemented in #173 |
| 7 | `JUPYTER_TOKEN` | `jupyterTokenEnv="JUPYTER_TOKEN"` (:144), injected only for the jupyter type, from `<env>-jupyter-token` Secret `data[token]` | The jupyter server must authenticate with this env value | ✅ (jupyter-server reads `JUPYTER_TOKEN` natively, see §3.B4) |
| 8 | `base_url` = `/dev/<ns>/<env>/` | HTTPRoute forwards the prefix **unchanged** (no URLRewrite filter); the controller injects the prefix into the container as `NOTEBOOK_ARGS=--ServerApp.base_url=<prefix>` (`::withNotebookBaseURL`), replacing a `base_url` the environment declares while keeping that variable's other flags | Jupyter must serve under that prefix via `ServerApp.base_url`, which the injected flag supplies | ✅ Gap C closed: the controller injects the flag and drops a conflicting `base_url` the environment declares; a `NOTEBOOK_ARGS` fed by `valueFrom` cannot be rewritten, so it fails the environment instead of publishing a 404 |
| 9 | Runtime-mode inference | Single-container pod; `type` and `image` are independent axes | The image must run jupyter or sshd from the environment the controller provides, not from a per-image baked choice | ✅ Gap D closed (#332): the controller injects `CUBSTACK_TYPE` (jupyter or ssh) from `spec.type`, owned like `JUPYTER_TOKEN`, and the entrypoint reads it first (`CUBESTACK_IMAGE` remains the standalone default). One image per accelerator family therefore serves both types |
| 10 | Multi-service in one container | `sshExposed` adds a 22 Service and mounts keys for jupyter/vscode types, sharing the main container | jupyter type + `ssh.enabled` ⇒ the same process group must run jupyter *and* sshd. The entrypoint starts sshd in the background and hands off to the stock launcher. **The mounted host key is the ssh-enabled signal** — images ship no host key of their own, so `ssh` mode fails fast without it and jupyter simply stays ssh-less | ✅ handled by entrypoint script |
| 11 | GPU extended resource | `::vendorResource`: nvidia `nvidia.com/gpu` / metax `metax-tech.com/gpu`, written to requests and limits at `resources.gpu.count`. With no `gpu` block the key is **omitted entirely** — a zero request would still pin the pod to a node advertising that resource | The image is device-agnostic; `nvidia-smi`/`mx-smi` come from driver injection. A CPU image must not need either | ✅ see §3 |
| 12 | SSH login user | `defaultRuntimeUser="user"` (:142) is the platform default → endpoint `ssh://user@<gw>`; `spec.runtime.user` overrides it, and the endpoint carries that account. Every first-party image runs `ubuntu` | The image must contain the account `spec.runtime.user` names (default `user`, uid 1000); for the first-party images that is `ubuntu` | ✅ |

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

**The defaults are the operator's fallback, not a layout our images must match.** The three
first-party images run account `ubuntu` uid/gid 1000 with home `/home/ubuntu` - the platform
default - so a spec naming none of `spec.runtime.user`, `runAsUser`/`runAsGroup` or
`storage.mountPath` gets the image's own layout, and only a bring-your-own image states any.
Images we do **not** author are not forced into that layout either: a stock docker-stacks image
keeps its upstream account/home (`jovyan` uid 1000 gid 100, `/home/jovyan`), selected with
`spec.runtime.user: jovyan` plus `securityContext.runAsGroup: 100` - a gid no derived value
implies, since the platform default is 1000. The spec fields are therefore *statements about the
image's native layout*, not conformance requirements - and the first-party images are the first
users of that mechanism, not an exception to it.

**Nothing validates the pairing.** The operator cannot see inside the image, so a `spec.runtime.user`
that names an account the image does not have, or a `runAsUser`/`runAsGroup` that does not match the
uid/gid the image's own sshd and files belong to, surfaces as a failed login or an unusable home
rather than as a rejected spec. A non-root sshd can only serve the uid it runs as, so the account, the
numerics, and the mount path have to agree. `images/README.md` lists the correct values per shipped
image.

**An environment running as root is the one case where the pairing is not a constraint on the image.**
A root sshd can serve any account, so the image's native account is not the only one it may serve, and
`spec.runtime.securityContext.runAsUser: 0` is served as `root` whatever the image's account is - the
entrypoint admits `root` beside the family account when the container is root, and a non-root sshd does
not admit it at all, since it could not serve it. In the shipped images a root environment ends up
serving `root` alone regardless, because every image creates (or inherits) its family account with a
locked password - a leading `!` in `/etc/shadow` `useradd` leaves behind, and NGC's `ubuntu` ships the
same way - and OpenSSH refuses a locked account. Only a root sshd can read `/etc/shadow` at all, so
that check is skipped throughout the non-root path and is one more thing root mode turns on. The
refusal is therefore the account's rather than this design's, and is recorded in `images/README.md`
for whoever changes a base image. The image still has to be *capable* of root: a root sshd needs
`/run/sshd`, which the images now ship, and a root env needs the host key at a mode its owner accepts
(#211). What the *launcher* needs is the controller's to supply rather than the spec's, the same way
`base_url` is (Gap C): `::withRootLauncherEnv` injects `NB_USER`/`NB_UID`/`NB_GID` and `--allow-root`
into `NOTEBOOK_ARGS` for a Jupyter environment at uid 0, so `runAsUser: 0` alone is the whole of the
request. The trio names the account in the image's own passwd database - `0:0` for root - and not the
identity the pod runs as: docker-stacks rewrites the account when the two disagree, and that rewrite
cannot succeed for root, which is measured (a pod running as `0:1000` with `NB_GID=1000` exits with
`userdel: user root is currently used by process 1`, so only the account's own `0:0` may be named).
The first-party images do not read the trio - the shared launcher expands `NOTEBOOK_ARGS` and takes
`--allow-root` from it rather than deciding anything itself - but the injection stays: the controller
sees only `spec.image`, and a bring-your-own docker-stacks image is made root-capable by that
injection, not by anything the image does.

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

### Gap D — explicit runtime mode (required; closed in #332)

The implicit inference (a `JUPYTER_TOKEN` present -> start jupyter; ssh keys mounted with no
token -> start sshd) suffices for the jupyter/ssh types but is fragile and leaves no hook for
vscode. **Required** once the image set is one image per accelerator family: there is no
per-mode image left to pick, so the mode has to be stated. The controller injects
`CUBSTACK_TYPE` (jupyter or ssh) from `spec.type` - controller-owned, so a user-declared value is
dropped - and the image entrypoint reads it first, falling back to the baked `CUBESTACK_IMAGE`
when it is absent (a hand-run container) and exiting non-zero on an unknown value. The value
participates in the StatefulSet template hash, so upgrading the operator rolls every jupyter/ssh
environment once to deliver it. `vscode` injects nothing: no first-party image serves it.

### Gap E — closed: opt-in non-root elevation (`spec.runtime.sudo`)

An environment runs as uid 1000 and had no way to become root: no image shipped `sudo`, and the
platform holds no privilege a non-root process could borrow. A tenant who needs `apt-get install` —
the reason the issue was filed — had exactly one option: `spec.runtime.securityContext.runAsUser: 0`,
which turns the whole environment root and changes its identity (login account, workspace ownership,
the `Accepted` report). That is a different environment, not an elevation.

Three options were considered:

1. **Run the environment as root.** The status quo. It answers "install a package" by making
   everything the environment runs root: the grant is permanent, the workspace belongs to root, and
   the account the ssh endpoint advertises is not the one in use.
2. **Add capabilities to the container.** Capabilities are not what `apt-get` needs — it needs the
   whole of root, including writing anywhere and executing setuid binaries — and widening a
   container's capability set is what the Restricted Pod Security Standard refuses.
3. **Ship `sudo`, grant it opt-in per environment.** *Decided.* The image carries the binary and no
   rule; the controller writes the rule when, and only when, the spec asks.

**Decided (issue #330):** `spec.runtime.sudo: true`, default `false`. All three family images install
`sudo` and grant nothing: sudo runs only for accounts a sudoers rule names, and the images name none.
When the field is true and the container runs as a positive uid, the controller adds:

- an `emptyDir` volume;
- a root init container (`initialize-sudoers`, the mirrored busybox the workspace repair already
  uses) that writes `#<uid> ALL=(ALL) NOPASSWD: ALL` to `/sudoers/20-cubestack`, mode `0440`;
- a read-only `subPath` mount of that one file at `/etc/sudoers.d/20-cubestack` in the main container.

The rule names the **uid**, not `spec.runtime.user`: sudoers' numeric-user form is `#<uid>` (no space),
and it follows the container's identity whatever name the image's passwd gives it. The rule is
written inside the pod rather than kept in a Secret: it is derived from the spec, holds nothing
secret, and must not outlive the pod. An environment that runs as root already holds the privilege
the field asks for, so the field
renders nothing there. `allowPrivilegeEscalation` on the main container stays unset (Kubernetes'
default, true): `sudo` is a setuid binary, and an explicit `false` would make the grant inert.

**Pod Security.** The field adds no requirement to the namespace. A `baseline` namespace already admits
the root init container — the workspace repair is one too — and the main container still runs as its
non-root account; sudo is a setuid binary inside the container, not a pod capability. The one
host-adjacent consequence follows the network, not sudo: a RoCE environment
(`spec.network.rdmaEnabled: true` with `rdmaType: roce`) shares the node's network namespace, so root
there acts on the node's network exactly as a `runAsUser: 0` environment on the same fabric already
does. A namespace enforcing `restricted` refuses every DevEnvironment pod at admission for reasons
unrelated to sudo, so the field cannot be the thing that decides whether an environment is admitted.
The operator reads no Namespace objects and holds no `namespaces` RBAC, so it cannot preflight a
namespace's enforced level either; that is documented in `operator/README.md` rather than reported on
the `Accepted` condition.

**Bring-your-own images** must ship `sudo`, read `/etc/sudoers.d`, and have a passwd entry for the uid
the container runs as for the grant to take effect: the controller writes the rule but cannot install
the binary or the account. See `image-contract.md`.

**Not in scope:** a console control for the field, and a permanent e2e conformance case.

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
  affects the software selection inside `maca-pytorch` (see §6).

### 3.D Offline delivery notes

- `docker pull` (on an amd64 host) + `docker save` produces a **single-arch** tarball; the
  multi-arch index is lost. Preserving multi-arch offline needs `skopeo copy --all` or per-node
  `--platform` pulls.
- Pin patch tags and record digests (floating minor tags drift).

---

## 4. Composition model (recommended)

One image per **(accelerator, stack) cell** — one per accelerator family today, each with PyTorch —
each carrying a shared "platform layer" so that service capability (entrypoint, ssh key handling, the
Jupyter launcher) is written once. They differ in the base and what the base already ships:

```
  common scripts (images/common): entrypoint - mode select + optional sshd, then hand off to the
                                  CMD; the sshd drop-in; the Jupyter launcher
                                   | shared by all three images
            +----------------------+----------------------+
            |                      |                      |
   cpu-pytorch                  cuda-pytorch               maca-pytorch
   on ubuntu:22.04           on the vendor's NGC     on a vendor Metax
   self-authored overlay:    PyTorch base: keeps     MACA base: ships no
   account, sshd, python3,   its account (ubuntu     account, no sshd, no
   the CPU build of torch,   1000:1000 /home/ubuntu), ENTRYPOINT - the
   jupyterlab, launcher      torch, JupyterLab; the   overlay is the whole
                             overlay adds sshd +     platform layer, account
                             the launcher             included
```

Key points:

- **Why three, not six.** The offline package ships every image, and the six-image set cost a
  naive per-image total of **42.80 GiB** compressed, four of the six being >10 GiB. Splitting a
  family again by runtime mode repeats its whole base for a delta of a few MB (the Jupyter-only
  layer measured 0.003 MiB on CUDA and 44.8 MiB on MACA), so the merge takes that naive total to
  about **21.4 GiB** - the three images share no layers, so that is also the union of their unique
  blobs. (The CPU image grew from 0.09 GiB to 0.32 GiB when it gained its PyTorch build; see §6.)
  Bundling those blobs once remains #128's job; #332 removes the repetition, not the dedupe.
- **Reaching the CPU image.** A CPU image is selected by **omitting `spec.resources.gpu`**. That is
  what exempts it from the brand gate (§2 #1) and keeps the vendor GPU resource out of the pod spec
  (§2 #11). The block is the request: it names both the vendor and the count, so there is no way to
  state a vendor without a device, and its absence is the only spelling of "no accelerator". Saying
  nothing about GPUs therefore means no GPU - a manifest that used to rely on the old `gpuCount`
  default of 1 has to name a `gpu` block to keep its accelerator.
- **What is shared is the runtime config**: the entrypoint (`images/common/entrypoint.sh` - mode
  selection, the optional sshd, and the hand-off to the image CMD), the sshd drop-in
  (`images/common/sshd/`), and the Jupyter launcher (`images/common/jupyter/start-jupyter.sh`,
  which expands `NOTEBOOK_ARGS` into `--ServerApp.base_url` - Gap C) are copied into all three.
  The drop-in carries the two per-family values as placeholders, filled by the installer beside it
  (`images/common/sshd/install-dropin.sh`) - the login account `@SSH_USER@` (`ARG SSH_USER`) and the
  session environment `@SSH_ENV@`, which the installer assembles from the variable names each
  Dockerfile gives it, read out of the build shell's environment, i.e. the base's own. It is a
  placeholder because sshd's `SetEnv` replaces a session's environment rather than extending it, so
  a fixed literal would hide whichever family's toolchain it did not name. The mount-contract paths
  (`HostKey`, the platform `AuthorizedKeysFile` entry) are absolute and outside every home, so one
  file serves every family and the shared parts cannot drift apart.
- **Account / `HOME` are uniform across all three** (see §2 contract): account `ubuntu`, uid/gid
  **1000:1000**, `$HOME=/home/ubuntu`, named per environment via `spec.runtime.user`. On the CPU
  and MACA images this is the platform layer's own choice; on the NGC PyTorch base it is what the
  base already ships, so the overlay keeps it instead of conforming anything. The retired
  docker-stacks-derived image (`jovyan`, gid 100, `/home/jovyan`) was the one exception, and it is
  gone: no image needs a `runAsGroup` override, and `spec.storage.mountPath` defaults to the same
  home everywhere.
- **The mode is runtime-selected, not baked.** One image serves both `jupyter` and `ssh`: the
  controller injects `CUBSTACK_TYPE` from `spec.type` (Gap D), and the entrypoint runs JupyterLab
  or sshd from it. The split is therefore at the image (one per accelerator and stack) and at the
  environment (its type), never at the image per mode as it used to be. `vscode` injects nothing -
  no first-party image serves it.


---

## 5. Registry organization and tag scheme (recommended)

Current anchors: `config/samples/ai_v1alpha1_devenvironment.yaml` and controller unit tests pin
`harbor.local/ai-images/base-cuda:11.8-pytorch2.2` / `harbor.local/ai-images/base-maca:1.0` — the
offline in-cluster registry host form. Those are fixture values for a *user-chosen* image, not the
platform's own publishing target, so they do not dictate the project below.

### 5.1 Names: `<accelerator>-<stack>`

Every repository is named by the two axes a user selects on:

```
<accelerator>-<stack>[:<versions>]

accelerator ∈ cpu | maca | cuda
stack       ∈ base | pytorch | tensorflow
```

| token | meaning |
|---|---|
| `cpu` | no accelerator; select it by omitting `spec.resources.gpu` |
| `maca` | Metax / MACA |
| `cuda` | NVIDIA |
| `base` | the vendor runtime plus the platform layer, **no ML framework** |
| `pytorch` / `tensorflow` | that framework, on the family's base |

Rules that follow:

1. **`base` means the same thing in every family**: the family with no framework. It is not "the
   family's default stack" — which is what the CPU image was called before it carried PyTorch.
2. **The framework is chosen by image**, not at runtime and not by tag. The mode was merged into
   runtime because splitting on it repeated a whole base for a 0.003–44.8 MiB delta; a framework is
   gigabytes, and two frameworks constrain each other's numpy/protobuf/torch pins, so one image
   cannot carry both.
3. **The matrix is sparse**, not a cartesian product. A cell exists only if it can be built and
   tested: `cpu-pytorch`, `maca-pytorch` and `cuda-pytorch` ship today; `cpu-base`, `maca-base`,
   `cuda-base`, `cpu-tensorflow`, `maca-tensorflow` and `cuda-tensorflow` are reserved names, not
   images. An absent cell is covered by bring-your-own `spec.image`.
4. **Names carry no versions, no mode, no OS and no accelerator model.** Versions go in the tag
   (§5.2), the mode in `CUBSTACK_TYPE` at runtime, the model in a node label. The base's distro is a
   build input too: a distro bump moves the tag, not the repository.

### 5.2 Project and tags

- **Project name**: `suanova` - our images publish as `harbor.isuanova.com/suanova/`
  `{cpu-pytorch,maca-pytorch,cuda-pytorch}`. That is the project CI already publishes operator and
  portal to (`suanova/cubestack-{operator,ui}`), so every CubeStack image lives under one project on
  the one host. **The repository names the axes a user selects on and that change slowly; the tag
  carries what changes per build.** Each repository is what the user picks on — omit
  `spec.resources.gpu` for `cpu-pytorch`, or name the vendor for one of the other two — and each
  moves on its own cadence (an Ubuntu LTS, an NGC release, a MACA package). The history is why the
  names were worth getting right: the CPU family was `minimal` in the original design, a name that
  described the image's size; it became `cpu-base` when the six images were merged, and
  `cpu-pytorch` once it carried PyTorch, so every name now states the stack it bakes. The vendor
  families likewise moved from `maca-base` / `cube-base` to `maca-pytorch` / `cuda-pytorch`.
  `suanova/minimal` and `suanova/cpu-base` keep the tags they were published under, as do the old
  vendor repositories.
  **The mode is not an axis.** It used to be a second repository per family
  (`ssh-maca-pytorch` next to `jupyter-maca-pytorch`, and so on), which is what the six-image set
  was. It is now selected at runtime: the controller injects `spec.type` to the image (Gap D), so a
  mode is a property of the **environment**, not of what the registry stores. Offline installs
  surface the same three images at `harbor.local`; only the host is swapped, by
  packaging/rewriting.
- **Tags**: content-locked and reproducible. Examples:
  - `cuda-pytorch:<ngc-release>-<sha>`, e.g. `26.08-<sha>`. Here the release *is* the
    compatibility contract: NGC pins python, torch and CUDA together in one tag rather than naming
    them as separable axes, so there is one axis and not three - there is no torch
    version to state separately, and repeating the python field the release also encodes (`-py3`)
    would restate what it already fixes.
  - `maca-pytorch:<maca-version>-py<python>-torch<ver>-<sha>`, e.g.
    `3.9.0.12-py310-torch2.4-<sha>`. The same axes the base is built on: the vendor package version
    is the compatibility contract of the whole stack, and it is what a user picks between. It moves
    on the vendor's cadence, not ours, so it stays in the tag while the repository keeps the stack
    identity.
  - `cpu-pytorch:py<python>-torch<ver>-<sha>`, e.g. `py310-torch2.4-<sha>`. No vendor release fixes
    the stack, so the tag states the two build inputs that do — `CPU_PYTHON` (ubuntu:22.04's
    python3) and `TORCH_VERSION` — and the Makefile reads both out of those rather than expecting
    them typed twice. The Ubuntu release stays out, as the MACA package's distro field does: it is a
    build input, not an axis a user picks between, and the digest a deployment pins fixes it.
  - `make push` defaults `TAG` to the short commit SHA, so a bare command yields a traceable,
    non-floating reference; pass an explicit tag from the schemes above to publish a release. The
    SHA names the last commit rather than the working tree, so publishing expects a committed
    tree. No image waits for that explicit tag: `CPU_TAG` reads `CPU_PYTHON` and `TORCH_VERSION`,
    `MACA_TAG` reads the three axes out of `MACA_PACKAGE`, and `CUDA_TAG` reads `CUDA_PACKAGE` for
    its one axis — all derived, not written twice, so a tag cannot name a stack the image was not
    built from. The SHA still ends each one, so a re-build of the overlay on an unchanged stack
    moves the reference rather than redefining it. Each derivation is guarded: an unreadable
    version stops the build rather than publishing a name with an empty field.
  - CI adds a second kind of pinned tag on a `vX.Y.Z` release: the platform release version, e.g.
    `cpu-pytorch:1.0.0`. The schemes above say what the image *is*; this says which CubeStack release it
    shipped with. A release publishes it instead of `:latest`, which stays a main-only tag.
  - Both forms of reference are published: the pinned tag above *and* a moving `:latest` that the
    push re-points at the image it just built, so a deployment may track the newest publish or pin
    exactly. Re-publishing an older commit therefore moves `:latest` backwards, which is inherent to
    the tag - the pinned tag is what a reproducible deployment should reference.
- The brand marker requires the image name to contain the accelerator's token, `cuda` or `maca`
  (§2 #1). The family names carry it, so the gate needs no exception beyond the token itself.

---

## 6. Image inventory and composition

Three images, one per **(accelerator, stack) cell** — each is the `pytorch` cell of its accelerator —
each serving both runtime modes:

| image | base | modes | platforms | compressed |
|---|---|---|---|---|
| `cpu-pytorch` | `ubuntu:22.04` (self-authored overlay) | jupyter, ssh | amd64, arm64 | 0.32 GiB (measured) |
| `cuda-pytorch` | `nvcr.io/nvidia/pytorch:<release>-py3` (mirrored) | jupyter, ssh | amd64 | 10.56 GiB |
| `maca-pytorch` | `public-library/maca-pytorch:<ver>-<os>-<arch>` (mirrored) | jupyter, ssh | amd64 | 10.57 GiB |

The six images this replaced cost **42.80 GiB** compressed as a naive per-image sum; the three
cost **21.4 GiB** by the same sum (the CPU image measured 0.32 GiB compressed on 2026-10-20), and
they share no layers, so that sum is also the union of their unique blobs. The vendor pairs had
been repeating their base byte for byte, differing only by the Jupyter-only layer - 0.003 MiB
(NVIDIA) and 44.8 MiB (MACA, `pip install jupyterlab`); the CPU family replaces the 0.53 GiB
docker-stacks image plus the 0.03 GiB ssh image with one 0.32 GiB image. The old repositories
(`jupyter-minimal`, `ssh-ubuntu22.04`, `jupyter-{cuda,maca}-pytorch`, `ssh-{cuda,maca}-pytorch`)
keep their published tags - pinned `spec.image` values keep pulling - but nothing publishes to
them any more. Deduplicating the shared base layers *inside an offline bundle* is still #128;
this merge removes the repetition, not the need for it.

### 6.1 `cuda-pytorch` (NVIDIA)

Shipped as `images/cuda-pytorch/`. This section was written as `base-cuda` on a `nvidia/cuda`
**runtime** base with "bake torch or not" and "runtime or devel" both open; what ships answers both
at once and not separately, because the base is NVIDIA's own NGC **PyTorch** image
(`nvcr.io/nvidia/pytorch:<release>-py3`) - the vendor's torch+CUDA stack rather than a bare runtime
the platform would assemble torch onto. A `nvidia/cuda` base would have meant owning the wheel
manifest and the CUDA/torch compatibility matrix; this one makes the vendor release the
compatibility contract, and it is also the image a user of this stack already knows. The name
follows §5.1: `cuda` names the accelerator and `pytorch` the stack it carries (it was `cube-base`
before the rename).

- **Base**: the NGC PyTorch release, **mirrored verbatim** into
  `harbor.isuanova.com/mirrors/nvcr.io/nvidia/…` and pinned by digest - the same delivery the Metax
  package gets, and for the same reason: a vendor artifact the platform serves rather than republishes,
  so it has no `BASE_MIRRORS` entry in `operator/Makefile` and needs none. It is **amd64-only** (the
  mirror carries one `linux/amd64` manifest), so the image is single-platform like `maca-pytorch`.
- **Unlike the MACA base, it is not bare.** It ships the account - uid/gid 1000 `ubuntu` at
  `/home/ubuntu`, which is the family layout exactly, so the overlay **inherits** it and must not
  `useradd` over it - plus one python 3.12 with torch in its dist-packages (no second interpreter,
  so no PATH correction), JupyterLab bound to that interpreter as a bare-`python` kernelspec, an
  `ENTRYPOINT`, and the PATH / `LD_LIBRARY_PATH` / `LIBRARY_PATH` that put the CUDA stack on the
  account's search path.
- **Overlay**: the platform layer (§4) minus what the base already provides - `openssh-server`, `tini`,
  the shared entrypoint and sshd drop-in, the shared jupyter launcher, the `ssh-copy-id` target
  `/home/ubuntu/.ssh`, `/run/sshd`, and the baked `CUBESTACK_IMAGE` default. Nothing is installed
  from pip: this base's JupyterLab is the one the notebook runs on. The base's `nvidia_entrypoint.sh`
  is displaced - it prints the vendor's banner and runs hardware diagnostics, which is not what a
  DevEnvironment pod log is for, and the entrypoint that decides what a container runs is the
  platform's.
- **Both modes in one image.** The base ships JupyterLab regardless of what runs, so the mode decides
  what *runs* rather than what is installed: `CUBSTACK_TYPE=ssh` (injected from `spec.type`, Gap D)
  execs sshd alone, and the smoke asserts the process tree - no notebook process and nothing
  listening on 8888 - instead of the absence of a binary. `EXPOSE` names both `8888` and `2222` and
  the `CMD` is the shared launcher; the ssh branch execs sshd and never reaches it. The retired ssh
  sibling differed in nothing but its baked mode, `EXPOSE`, `CMD` and comments.
- **Acceptance mapping**: `python3` on the account imports the vendor torch and prints the release's
  version, the notebook kernel resolves to that same interpreter, jupyter 8888 behind token +
  `base_url`, the ssh session carries the CUDA stack's paths, and ssh 2222 key-auth login as `ubuntu`
  in both modes. `nvidia-smi` is **not** asserted - it comes from driver injection at container start
  (§3.A), so it is a check of the node rather than of the image.
- **Decision**: self-authored platform layer on the **mirrored vendor base**, with the account
  inherited from it. What stays open is on-node: the node's driver has to be at least the CUDA
  version this release requires, and whether the vendor stack works for uid 1000 once a device is
  present is untested locally.

### 6.2 `maca-pytorch` (Metax)

Shipped as `images/maca-pytorch/`; the name follows §5.1 — `maca` names the accelerator and
`pytorch` the stack it carries. This section was written as `base-maca`, and the repository kept
that `base` vocabulary until the whole set was renamed.

- **Gate: cleared, differently than expected.** Metax still has no anonymous public registry (§3.C),
  but the platform does not have to build a MACA base from the commercial package: the upstream vendor
  image (`public-library/maca-pytorch:<ver>-<os>-<arch>`) is **mirrored verbatim** into
  `harbor.isuanova.com/mirrors/cr.metax-tech.com/public-library/…`, and that mirror is the build base.
  What remains unconfirmed is the **injection model** - whether `container-runtime` injects MACA on
  demand for non-root uid-1000 containers. This image bakes the stack regardless, so it does not depend
  on injection being available; if injection does apply, the two may overlap.
- **Base**: the mirrored vendor package, pinned by digest. It is a **bare SDK image**, not a distro:
  no `config.User` (so it runs as root), no `ENTRYPOINT` at all (`Cmd: ["/bin/bash"]`, which exits
  immediately), no sshd, no jupyter, no non-root account - stock `ubuntu:22.04` plus MACA at
  `/opt/maca` and a baked `/opt/mxdriver`. It therefore cannot back a DevEnvironment as it stands, and
  the overlay is the whole platform layer rather than a delta - account `ubuntu` (1000:1000,
  `$HOME=/home/ubuntu`), `openssh-server`, `tini`, the shared entrypoint and sshd drop-in and the
  shared jupyter launcher, plus `jupyterlab` installed into the vendor's own python. It is also
  **single-arch** (the `-amd64` suffix is part of the package tag, not a multi-arch index), so the
  published image is amd64-only - see `images/README.md`.
- **Software stack**: the vendor's own python and `torch+metax` build, inherited untouched - jupyterlab
  is installed into that interpreter rather than beside it; stock CUDA wheels remain unusable
  (cu-bridge recompile).
- **Both modes in one image**, on the same terms as §6.1: `CUBSTACK_TYPE` picks sshd or the shared
  launcher at runtime, the ssh mode runs no notebook process, and the retired ssh sibling differed
  only in its baked mode and `EXPOSE`/`CMD`. Its one real difference is that this overlay *does* carry
  the JupyterLab pip step, where the sibling omitted it - from a 44.8 MiB layer to nothing, and it is
  what the single image's jupyter mode needs.
- **Acceptance mapping**: `mx-smi` visible and `metax-tech.com/gpu` satisfiable - on a Metax node only.
  The local smoke covers everything that does not need one: non-root 1000, `/home/ubuntu`, jupyter
  8888 behind token + `base_url`, ssh 2222 key-auth login in both modes, and that `/opt/maca` is
  readable by the account that runs. The session environment named in the sshd drop-in is what keeps
  the vendor toolchain (`/opt/maca/*/bin`, `/opt/mxdriver/bin`) reachable from an ssh session, which
  is the whole point of this image; the smoke asserts the session environment matches the container's
  rather than naming tools, since the vendor also symlinks some of them into `/usr/bin`.
- **Decision**: self-authored platform layer on the **mirrored vendor base**. Two risks stay open and
  are both on-node: the **baked driver** (`/opt/mxdriver` in the base vs. whatever the node injects -
  which wins is untested), and whether the vendor stack works for uid 1000 once a device is present.

### 6.3 `cpu-pytorch` (CPU)

Shipped as `images/cpu-pytorch/`, built on **`ubuntu:22.04`** and carrying the CPU build of
PyTorch. The name follows §5.1 — `cpu` says there is no accelerator, `pytorch` the stack — after a
spell as `cpu-base` (and `minimal` in the original design). This section was written as two
candidate CPU images - a thin overlay on docker-stacks' `minimal-notebook`, and a self-build - with
Option A recommended. The merge reverses that: the self-build is what ships, for reasons the
six-image set did not have.

- **Why self-build, not the stock overlay.** Docker-stacks ships `jovyan` (uid 1000, gid **100** at
  `/home/jovyan`), so keeping it stock would leave the CPU family as the one layout that differs from
  both vendor images - a `runAsGroup: 100` override on every CPU environment whose identity is named,
  and a catalog where one of three images needs different fields. Merging the families into three also
  removes the reason to keep the stock launcher: one shared launcher serves all three now, and the
  docker-stacks runtime (its `start.sh` user remapping, `NB_UID`/`NB_GID`/`NB_USER`) has no place in
  an image whose account is fixed and named by the spec. The image is also the smallest of the three
  by an order of magnitude, so the overlay costs little against what the offline set already ships.
- **Overlay**: `ca-certificates`, `openssh-server`, `python3`, `python3-pip` and `tini` from the
  Ubuntu mirror (`APT_MIRROR`), the **CPU build of PyTorch**, `numpy` (torch's array bridge, which
  torch does not pull in itself, held below 2 because torch 2.4.0 predates its NumPy 2 support)
  and `jupyterlab` from pip into the
  **system interpreter** (no venv, no conda), account `ubuntu` uid/gid 1000 at `/home/ubuntu`,
  `/run/sshd` at 0700, and the shared entrypoint, launcher and sshd drop-in (session environment:
  `PATH`). Torch comes from PyTorch's own `download.pytorch.org/whl/cpu` index rather than from
  PyPI, whose linux wheel is the CUDA build this family does not have; `TORCH_INDEX_URL` overrides
  the index for an offline mirror, and `TORCH_VERSION` is a required build arg because the
  published tag is derived from it (§5.2). `tini` is PID 1, the baked default is
  `CUBESTACK_IMAGE=jupyter`, `EXPOSE 8888 2222`, and the `CMD` is the shared launcher - the same
  structure as the vendor images, on a base the platform owns outright.
- **Platforms**: the `ubuntu:22.04` base is multi-arch, and everything added (the apt packages,
  JupyterLab and its pure-python dependencies, and the CPU torch wheel) has arm64 builds, so this
  is the one image published as a multi-arch index (amd64, arm64).
- **Acceptance mapping**: in both modes - non-root 1000, `/home/ubuntu` writable, jupyter 8888 behind
  token + `base_url` with no-token access rejected, ssh 2222 key-auth login with the mounted host key,
  and an ssh-mode container with nothing on 8888; the session's `python3` imports torch and the
  notebook kernel resolves to that same interpreter. Key material is mounted from the Secret, never
  staged (§2 #5).

---

## 7. Where the Dockerfiles live (decided: monorepo `images/`)

- **Decided**: a top-level **`images/`** workspace in this monorepo, alongside `operator/` and `web/`.
  It landed with the build work and holds the shared platform layer (`images/common/`), the per-image
  Dockerfiles, and the `Makefile` + `hack/smoke.sh` build and acceptance-smoke scripts.
- Rationale: the operator contract and the e2e suite evolve in the same repo; layered builds (§4) need
  same-repo references to the shared base; consistent with the existing operator/web two-stack layout.
- Alternative: a separate Installer/image repo — not recommended (splits contract evolution from builds).
- **CI**: two workflows, split by what they may do, mirroring how operator and portal are handled.
  `ci-operator.yml`'s `images-smoke` job builds and smokes the images a change reaches, on any change
  under `images/**` that is not markdown, on **pull requests** — that is what validates them, and it
  needs neither a cluster nor registry credentials. Which images those are is answered by
  `images/hack/changed-images.sh`, the rule the operator workflow asks; `make -C images check-deps
  check-select` asserts the convention that answer is derived from, and runs its fixtures. Publishing
  is `ci-images.yml`, on a push to `main` that changes `images/**` or the CI that selects what a
  change reaches — the publish workflow and the action it delegates to — as **one job per image**,
  selected by that same rule — the selection *is* the job matrix, so an image the merge did not
  reach has no job at all rather than a skipped one. Each leg smokes the image it is about to
  publish, pushes the short-SHA tag with `PUSH_LATEST=0`, and moves its own mutable `:latest` only if
  `main`'s copy of the paths that decide that image still matches that commit. Three properties hold
  that together, and each is load-bearing: an image's trigger paths, its gate pathspec and its
  `retag-latest` set are all the same set — the latter two read from `changed-images.sh paths <image>`
  rather than restated, so any later commit that could fail its gate has itself started a run that
  would move the tag; an image's `:latest` is moved only by a run that published it; and each image
  carries its own concurrency group, so only a run that would redo the same work can cancel one in
  flight. The granularity is what keeps a merge touching only the CPU image from pulling a 10.5 GiB
  vendor base on its way to publishing images it could not have changed, and the vendor legs' disk
  reclaim and long timeout are theirs alone — a CPU image is a fraction of that base. A `vX.Y.Z` tag
  publishes every image at the version it names and moves no `:latest` (§5).
- **Still open**: the offline export script (§3.D) — nothing in the repo produces the bundle yet, so
  an offline install is assembled by hand from the published images.

---

## 8. Platform-side changes to close (not image-side)

| Item | Owner | Recommendation | Blocks |
|---|---|---|---|
| A workspace writability check (uid 1000 writing the home mount: `/home/ubuntu` on all three family images) | workspace storage (cephfs-ephemeral) | **Closed controller-side**: an init container sets the claim root's mode and chowns it — recursively, but only when the owner does not already match — to the container's own identity on the way in, measured on `cephfs-ephemeral`, so the storage class needs no change (Gap A) | — |
| B non-root sshd binding :22 | controller | **Closed image-side**: sshd listens on 2222 and the Service publishes it as 22, so no capability is ever granted. Retargeting `targetPort`/probe is #173 | base image ssh acceptance |
| C injecting jupyter `base_url` | controller | **Closed controller-side**: `::withNotebookBaseURL` injects `NOTEBOOK_ARGS=--ServerApp.base_url=/dev/<ns>/<env>/` (replaces a `base_url` the environment declares, keeps its other flags; a `valueFrom`-fed `NOTEBOOK_ARGS` is refused) — the shared launcher expands it, and all three family images carry that launcher (`images/common/jupyter/start-jupyter.sh`, §4). An image with a launcher of its own has to expand the variable itself | — |
| D mode env | controller | **Closed in #332**: `::desiredPodSpec` injects `CUBSTACK_TYPE` (jupyter or ssh) from `spec.type` as a controller-owned variable (a user-declared value is dropped), and the entrypoint reads it before the baked default; the value participates in the template hash, so one operator upgrade rolls every jupyter/ssh environment once. `vscode` injects nothing | — (vscode hook remains unused) |

---

## 9. Decision summary and items to confirm

| Item | Conclusion | Status |
|---|---|---|
| Three-cell model, one image per (accelerator, stack) cell (`cpu-pytorch`, `cuda-pytorch`, `maca-pytorch`), each serving both runtime modes - shared entrypoint, sshd drop-in and jupyter launcher; uniform account `ubuntu`/1000:1000/`$HOME=/home/ubuntu`, named per environment (`spec.runtime`, `spec.storage.mountPath`). The name grammar is §5.1 | §4, §5.1 | ✅ decided and shipped in #332; the six-image, per-mode set is retired (old repositories keep their tags) |
| GPU image = self-authored platform + vendor base (layered reuse) | §4 | ✅ decided |
| Project `suanova`, host `harbor.isuanova.com` (online) / `harbor.local` (offline) | §5 | ✅ decided |
| Dockerfiles live in monorepo `images/` | §7 | ✅ decided — landed, with CI on both sides (smoke per PR, publish on merge); the offline export script is still open |
| NVIDIA image: self-authored platform layer on the **mirrored** NGC PyTorch vendor base, which already supplies the account, the interpreter, torch and JupyterLab — so the "bake torch or not" and "runtime or devel" questions this row used to leave open are answered together by the base choice — plus the shared launcher; amd64-only, both modes in one `cuda-pytorch` image | §6.1 | ✅ shipped in `images/` (the earlier `base-cuda` on a bare `nvidia/cuda` runtime is superseded); ⚠️ **to confirm on an NVIDIA node**: the node's driver against the release's CUDA requirement, and the vendor stack under uid 1000 once a device is present |
| Metax image: self-authored platform layer on the **mirrored** vendor base, plus the shared launcher (`common/jupyter/` — the vendor base ships none), amd64-only — both modes in one `maca-pytorch` image | §6.2 | ✅ shipped in `images/`; ⚠️ **to confirm on a Metax node**: driver model (the base's baked `/opt/mxdriver` vs. what the node injects) and `mx-smi`/`metax-tech.com/gpu` |
| CPU image: self-build on `ubuntu:22.04` with `python3`/pip, the CPU build of PyTorch and JupyterLab on the system interpreter, account `ubuntu`/`$HOME=/home/ubuntu`; multi-arch (amd64, arm64); both modes in one `cpu-pytorch` image. The stock docker-stacks overlay (`jovyan`, gid 100) is retired: it was the one layout that needed a `runAsGroup` override | §6.3 | ✅ shipped in `images/` in #332; PyTorch and the `cpu-pytorch` name added in #343; replaces both the earlier `jupyter-minimal` and `ssh-ubuntu22.04` |
| Non-root elevation: `spec.runtime.sudo` (default `false`) grants the container's uid passwordless sudo through a controller-written sudoers drop-in. The images ship `sudo` and grant nothing; a root environment needs no grant; the field adds no Pod Security requirement | Gap E | ✅ decided and implemented (issue #330) |
| Gaps A/B/C/D/E closure | §8, Gap E | ✅ all five closed: A and C controller-side, B and D image-side (D by #332), E by `spec.runtime.sudo` — the images ship sudo and grant nothing, and the controller writes the rule only when the spec asks (issue #330) |

