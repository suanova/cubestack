# Images workspace Makefile — build, smoke & publish the DevEnvironment base images.
# Build context is this directory (see AGENTS.md). Each image has one name: build and
# smoke work on one platform in the local store, and push publishes that name plus
# :latest as a single multi-arch index (PLATFORMS); PUSH_LATEST=0 withholds :latest,
# and retag-latest moves it afterwards for a caller that has to decide later. buildx
# cannot load locally and push in one step, so the published layers are a fresh build
# of the same source rather than the very image the local smoke accepted.

CONTAINER_TOOL ?= docker

# The architecture every published image must run on: the cluster's nodes are amd64, and the
# machine building them may not be. Both Dockerfiles start from a multi-arch base (ubuntu,
# quay.io/jupyter), and without --platform `docker build` resolves that base to the *host*
# architecture — so a build on an arm64 host publishes an arm64-only image and every amd64 node
# then fails to pull it ("no match for platform in manifest"). Naming the platform makes the
# build independent of the host; PLATFORM=linux/arm64 is the explicit opt-in to build for
# another one. `docker buildx imagetools inspect --raw <ref>` shows what a registry received.
PLATFORM ?= linux/amd64

# What `make push` publishes, as one multi-arch index per image: a node then pulls the
# manifest for its own architecture rather than the builder's, which is the difference
# between an amd64-only publish and one an arm64 laptop can run. `make push
# PLATFORMS=linux/amd64` narrows it back to a single platform.
#
# Needs a builder that can build more than one platform — Docker Desktop's can; on a
# plain docker install run `docker buildx create --use` first (and install QEMU, e.g.
# the docker/setup-qemu-action in CI) or the build fails on the non-native platform.
PLATFORMS ?= linux/amd64 linux/arm64

# One --platform flag per entry. Derives nothing from PLATFORM: build/smoke and publish
# are separate flows and neither should quietly change the other's targets.
PLATFORMS_ARG = $(foreach p,$(PLATFORMS),--platform $(p))

# The MACA image is single-platform by construction, not by preference: its vendor base is
# published per architecture (`-amd64` is part of the package tag, not a multi-arch index), so
# there is no arm64 layer to build an arm64 manifest from and asking buildx for one could only
# fail. It is therefore kept out of PLATFORMS and named here — publishing it is a one-platform
# push, which buildx supports.
MACA_PLATFORM ?= linux/amd64

# The CUDA image is single-platform for the same reason and by the same mechanism: its vendor base
# is published per architecture too — the mirror serves one linux/amd64 manifest — so there is no
# arm64 layer to build an arm64 manifest from either. Kept out of PLATFORMS and named here.
CUDA_PLATFORM ?= linux/amd64

# Buildkit's provenance and SBOM attestations are off. Harbor rejects an index carrying
# them with a 404 on the manifest PUT — "artifact ... not found" — even when every
# manifest it references resolves on its own (seen 2026-09-21 publishing
# suanova/jupyter-minimal, where the same index without them pushed fine). They are
# metadata a customer does not pull, so dropping them costs nothing.
BUILDX_ATTEST = --provenance=false --sbom=false

# Optional mirror overrides for CN/offline builds (empty = upstream).
APT_MIRROR    ?=
PIP_INDEX_URL ?=

# Base-image build args, defaulting to the platform registry's mirrored copies of the upstream
# bases. Building from the platform's copy is what keeps the published image descended from
# the base the platform serves, and it is the only copy that resolves where upstream is
# unreachable. They live in the shared MIRROR_PROJECT, each under its upstream reference with
# the upstream host as the first path segment — the same rule hack/mirror-e2e-images.sh
# mirrors under, and the same refs operator/Makefile's BASE_MIRRORS names. Each is named by
# tag *and* digest, and the digest is what the build resolves:
# the mirrored tag is movable — operator/hack/mirror-e2e-images.sh repoints it when someone
# here re-mirrors — so on the tag alone one commit could publish different base layers on two
# days under the same TAG, which is the reproducibility that TAG is supposed to carry. The
# digest is the mirror's index digest, so each platform still resolves its own manifest and
# PLATFORMS is not narrowed. Bumping a base is deliberate: read the new digest, update it here
# and in operator/Makefile's BASE_MIRRORS (the map the e2e's own builds and the mirror script
# read — the two must name the same bases), then re-run the mirror script, which fails if a
# mirrored tag no longer hashes to the digest it is listed under. Pass `BASE_ARGS=` to resolve
# FROM upstream instead, unpinned — which covers the CPU bases only: neither vendor base has an
# upstream a build here reaches, so a MACA or CUDA build needs an explicit
# `--build-arg MACA_BASE=<ref>` / `--build-arg CUDA_BASE=<ref>` in its place. The jupyter date
# tracks the base in jupyter/Dockerfile; bump both together.
BASE_ARGS ?= \
	--build-arg JUPYTER_BASE=$(REGISTRY)/$(MIRROR_PROJECT)/quay.io/jupyter/minimal-notebook:2026-09-07@sha256:f6dc79ec57e05d28fa8f08dbd457c0d46f79e3677083e2eed9fb2d892942d810 \
	--build-arg UBUNTU_BASE=$(UBUNTU_BASE) \
	--build-arg MACA_BASE=$(MACA_BASE) \
	--build-arg CUDA_BASE=$(CUDA_BASE)

# Base release of the self-authored ssh image. It selects the build base AND names the
# published repository (decision doc §5), so the name cannot outlive the base. The release is
# one axis for both: it is looked up in UBUNTU_BASE_DIGESTS below, and nothing else selects
# the base, so a release and its digest can never be chosen apart.
UBUNTU_VERSION ?= 22.04

# The pinned base, one entry per supported Ubuntu release, as <version>=<digest of the
# platform registry's copy>. A release with no entry has no base to build from: its tag would
# carry another release's digest, which the build resolves — so it would either fail the pull
# or build a release the published name does not claim. `make build-ssh UBUNTU_VERSION=24.04`
# stops in check-ubuntu-base instead, until 24.04 is mirrored and pinned here.
UBUNTU_BASE_DIGESTS = 22.04=sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02

UBUNTU_BASE_DIGEST = $(patsubst $(UBUNTU_VERSION)=%,%,$(filter $(UBUNTU_VERSION)=%,$(UBUNTU_BASE_DIGESTS)))
UBUNTU_BASE = $(REGISTRY)/$(MIRROR_PROJECT)/docker.io/library/ubuntu:$(UBUNTU_VERSION)@$(UBUNTU_BASE_DIGEST)

# The MACA base, pinned the same way and for the same reason: the mirrored tag is movable and
# the package is rebuilt upstream, so the digest is what the build resolves. It differs from the
# bases above in one respect — it is not under $(PROJECT). The Metax package was mirrored as it
# stands, into MIRROR_PROJECT, so there is no suanova/ copy to name; the vendor package keeps
# its upstream path and the platform owns only the host serving it. Spelled out rather than
# derived from $(PROJECT) so that stays visible.
#
# A table rather than an inline digest, for the reason UBUNTU_BASE_DIGESTS gives: MACA_PACKAGE
# selects the base *and* is read for the tag, so a package bumped on its own would carry its name
# onto the previous package's digest — and the digest is what the build resolves, so the published
# reference would claim a package its layers do not come from. One entry per mirrored package; a
# package with no entry stops in check-maca-base instead. Nothing mirrors the vendor bases, so the
# entry is added by hand.
MACA_PACKAGE = maca-pytorch:3.9.0.12-torch2.4-py310-ubuntu22.04-amd64
MACA_BASE_DIGESTS = maca-pytorch:3.9.0.12-torch2.4-py310-ubuntu22.04-amd64=sha256:da5065e441290224914e5643f6cd39e46a927d58eb2d97c865263ddd87c37a49
MACA_BASE_DIGEST = $(patsubst $(MACA_PACKAGE)=%,%,$(filter $(MACA_PACKAGE)=%,$(MACA_BASE_DIGESTS)))
MACA_BASE = $(REGISTRY)/$(MIRROR_PROJECT)/cr.metax-tech.com/public-library/$(MACA_PACKAGE)@$(MACA_BASE_DIGEST)

# The CUDA base, pinned the same way and outside $(PROJECT) for the same reason: NVIDIA's PyTorch
# package was mirrored as it stands. It differs from MACA_PACKAGE in shape — the upstream host is
# the first path segment of the *upstream* reference and the tag is nvcr.io's own release name,
# not a vendor package rebuilt per architecture.
#
# A table rather than an inline digest, the way UBUNTU_VERSION is looked up in UBUNTU_BASE_DIGESTS:
# CUDA_PACKAGE selects the base *and* is read for the tag, so a release bumped on its own would
# carry its name onto the previous release's digest — and the digest is what the build resolves,
# so the published reference would claim a release its layers do not come from. One entry per
# mirrored release; a release with no entry stops in check-cuda-base instead. Nothing mirrors the
# vendor bases, so the entry is added by hand.
CUDA_PACKAGE = pytorch:26.08-py3
CUDA_BASE_DIGESTS = pytorch:26.08-py3=sha256:ee619c9e16df23c5a7f6f79ff9a41ce3c6ea9f23a92a4833b59825bb056002cc
CUDA_BASE_DIGEST = $(patsubst $(CUDA_PACKAGE)=%,%,$(filter $(CUDA_PACKAGE)=%,$(CUDA_BASE_DIGESTS)))
CUDA_BASE = $(REGISTRY)/$(MIRROR_PROJECT)/nvcr.io/nvidia/$(CUDA_PACKAGE)@$(CUDA_BASE_DIGEST)

APT_MIRROR_ARG    = $(if $(APT_MIRROR),--build-arg APT_MIRROR=$(APT_MIRROR))
PIP_INDEX_URL_ARG = $(if $(PIP_INDEX_URL),--build-arg PIP_INDEX_URL=$(PIP_INDEX_URL))

# Publishing coordinates (decision doc §5). One name per image: a build is tagged at the
# reference it will be published under, and push publishes that same name plus :latest as
# one multi-arch index. TAG defaults to the short commit SHA, so a bare `make build` yields a
# traceable, non-floating reference. It names the last commit, not the working tree, and is
# resolved per make invocation — pass an explicit TAG if a commit lands between build and
# push (§5 schemes). Publishing an older commit moves :latest backwards.
# Authenticate first: docker login $(REGISTRY).
#
# TAG has no fallback: a build must name a real commit, so there is nothing to
# substitute when git metadata is missing (a source tarball). git rev-parse then
# yields nothing and every reference would end at the ':'; check-tag fails with
# that reason instead, rather than inventing a non-reproducible tag.
REGISTRY ?= harbor.isuanova.com
PROJECT  ?= suanova
# Where the third-party bases the images are built FROM are mirrored. A project of its
# own rather than PROJECT, which names the images this workspace publishes: the bases are
# shared platform-wide — the e2e's builds and this one resolve the same refs — and the
# project is not this workspace's to own.
MIRROR_PROJECT ?= mirrors
TAG      ?= $(shell git rev-parse --short HEAD 2>/dev/null)

SSH_REPO     = $(REGISTRY)/$(PROJECT)/ssh-ubuntu$(UBUNTU_VERSION)
# -minimal is the docker-stacks stack variant this overlay is built on (decision doc §5); unlike
# UBUNTU_VERSION it does not name the published repository, so the variant is a literal here and
# the base stays pinned in jupyter/Dockerfile.
JUPYTER_REPO = $(REGISTRY)/$(PROJECT)/jupyter-minimal
# The repository is named for the vendor stack it carries, not for its base image: several MACA
# packages (maca, maca-pytorch, maca-tensorflow) can share one overlay, and the base is the one
# thing that moves between them — so the name stays and MACA_BASE is what changes.
MACA_REPO    = $(REGISTRY)/$(PROJECT)/jupyter-maca-pytorch
# The same vendor base and the same platform layer, split by mode: CUBESTACK_IMAGE is baked at
# build time, so an ssh-type GPU environment needs its own image rather than a flag on this one.
# Shares MACA_BASE and MACA_PLATFORM with MACA_REPO above — the pair moves together, since the
# base is the one thing they have in common.
SSH_MACA_REPO = $(REGISTRY)/$(PROJECT)/ssh-maca-pytorch

# The NVIDIA twin of the MACA pair, named by the same rule: the vendor stack it carries, not its
# base image. The mode split is the same one and for the same reason — CUBESTACK_IMAGE is baked at
# build time, so an ssh-type GPU environment needs its own repository rather than a flag.
CUDA_REPO     = $(REGISTRY)/$(PROJECT)/jupyter-cuda-pytorch
SSH_CUDA_REPO = $(REGISTRY)/$(PROJECT)/ssh-cuda-pytorch

# The MACA pair's tag carries the vendor axes a user picks between (decision doc §5), not only the
# commit: this is the one base the platform does not choose, and the vendor package version is the
# compatibility contract of the whole stack, so a deployment naming it should say what it is. Read
# out of MACA_PACKAGE rather than written twice, the way UBUNTU_VERSION is looked up in
# UBUNTU_BASE_DIGESTS: 'maca-pytorch:3.9.0.12-torch2.4-py310-ubuntu22.04-amd64' becomes
# '3.9.0.12-py310-torch2.4', so the tag cannot name a base the image was not built from. The
# vendor's field order is its own — §5 puts the python axis first — and the distro/arch fields are
# dropped: the vendor's Ubuntu release is not our pin, and the package is amd64-only, which
# MACA_PLATFORM already states. The commit still ends the tag, so re-building this overlay on an
# unchanged base moves the reference instead of redefining it.
MACA_PKG_FIELDS  = $(subst -, ,$(lastword $(subst :, ,$(MACA_PACKAGE))))
MACA_PKG_VERSION = $(word 1,$(MACA_PKG_FIELDS))
MACA_PKG_PY      = $(filter py%,$(MACA_PKG_FIELDS))
MACA_PKG_TORCH   = $(filter torch%,$(MACA_PKG_FIELDS))
MACA_TAG_AXES    = $(MACA_PKG_VERSION)-$(MACA_PKG_PY)-$(MACA_PKG_TORCH)
MACA_TAG        ?= $(MACA_TAG_AXES)-$(TAG)

# The CUDA pair's tag carries its vendor release for the same reason, and is derived the same way —
# but the NGC tag has a different shape, so the derivation is not the same one. `pytorch:26.08-py3`
# encodes no torch axis: the release *is* the combination of python, torch and CUDA, pinned
# together upstream, which is why the whole compatibility contract is the release. What is read out
# of CUDA_PACKAGE is therefore just its version field, '26.08', giving '<release>-<sha>'. The
# remaining field is dropped rather than appended: '-py3' names a python the release already
# fixes, with one interpreter in the image for it to be ambiguous about.
CUDA_PKG_VERSION = $(firstword $(subst -, ,$(lastword $(subst :, ,$(CUDA_PACKAGE)))))
CUDA_TAG        ?= $(CUDA_PKG_VERSION)-$(TAG)

IMG_SSH      ?= $(SSH_REPO):$(TAG)
IMG_JUPYTER  ?= $(JUPYTER_REPO):$(TAG)
IMG_MACA     ?= $(MACA_REPO):$(MACA_TAG)
IMG_SSH_MACA ?= $(SSH_MACA_REPO):$(MACA_TAG)
IMG_CUDA     ?= $(CUDA_REPO):$(CUDA_TAG)
IMG_SSH_CUDA ?= $(SSH_CUDA_REPO):$(CUDA_TAG)

# The moving publish tag: added by `make push`, never produced by `make build`, so a
# local :latest means it came from a publish.
LATEST_SSH      = $(SSH_REPO):latest
LATEST_JUPYTER  = $(JUPYTER_REPO):latest
LATEST_MACA     = $(MACA_REPO):latest
LATEST_SSH_MACA = $(SSH_MACA_REPO):latest
LATEST_CUDA     = $(CUDA_REPO):latest
LATEST_SSH_CUDA = $(SSH_CUDA_REPO):latest

# Whether `make push` also moves :latest. A caller that may not move it — CI, which
# only moves :latest when the run's commit is still the head of main — passes
# PUSH_LATEST=0 and calls `make retag-latest` once it knows: buildx cannot load
# locally and push in one step, so asking this Makefile for both would rebuild the
# whole index a second time. See .github/workflows/ci-images.yml.
PUSH_LATEST ?= 1

LATEST_ARG_SSH      = $(if $(filter 1,$(PUSH_LATEST)),-t $(LATEST_SSH))
LATEST_ARG_JUPYTER  = $(if $(filter 1,$(PUSH_LATEST)),-t $(LATEST_JUPYTER))
LATEST_ARG_MACA     = $(if $(filter 1,$(PUSH_LATEST)),-t $(LATEST_MACA))
LATEST_ARG_SSH_MACA = $(if $(filter 1,$(PUSH_LATEST)),-t $(LATEST_SSH_MACA))
LATEST_ARG_CUDA     = $(if $(filter 1,$(PUSH_LATEST)),-t $(LATEST_CUDA))
LATEST_ARG_SSH_CUDA = $(if $(filter 1,$(PUSH_LATEST)),-t $(LATEST_SSH_CUDA))

.PHONY: help check-tag check-platform check-platforms check-push-latest check-ubuntu-base check-maca-base check-cuda-base build build-ssh build-jupyter build-maca build-ssh-maca build-cuda build-ssh-cuda \
	smoke smoke-ssh smoke-jupyter smoke-maca smoke-ssh-maca smoke-cuda smoke-ssh-cuda push push-ssh push-jupyter push-maca push-ssh-maca push-cuda push-ssh-cuda retag-latest \
	retag-latest-ssh retag-latest-jupyter retag-latest-maca retag-latest-ssh-maca retag-latest-cuda retag-latest-ssh-cuda

.DEFAULT_GOAL := help

# Every build/smoke/push target funnels through build-ssh or build-jupyter, so this
# is the one place a missing TAG has to be caught.
check-tag:
	@test -n "$(TAG)" || { \
		echo "make -C images: TAG is empty - 'git rev-parse --short HEAD' returned nothing" >&2; \
		echo "                (not a git checkout?); pass TAG=<tag> explicitly." >&2; \
		exit 1; }

# `docker build` loads what it builds into the local store, so it takes exactly one
# platform, and a list would surface as an opaque BuildKit error about the driver. That
# is what build/smoke want: one image they can run. Publishing several is a different
# flow with its own guard below.
check-platform:
	@test -n "$(PLATFORM)" || { \
		echo "make -C images: PLATFORM is empty - name the platform the images run on (e.g. linux/amd64)." >&2; \
		exit 1; }
	@case "$(PLATFORM)" in \
		*,*) echo "make -C images: PLATFORM takes one platform, not a list (got '$(PLATFORM)')." >&2; \
		     echo "                To publish several at once, use 'make push PLATFORMS=<list>'." >&2; \
		     exit 1;; \
	esac

check-platforms:
	@test -n "$(PLATFORMS)" || { \
		echo "make -C images: PLATFORMS is empty - name what to publish (e.g. linux/amd64 linux/arm64)." >&2; \
		exit 1; }
	@for p in $(PLATFORMS); do \
		case "$$p" in \
			*/*) ;; \
			*) echo "make -C images: PLATFORMS entry '$$p' is not <os>/<arch> (e.g. linux/amd64)." >&2; exit 1;; \
		esac; \
	done

# LATEST_ARG_* read any value other than 1 as "do not move :latest", which is the
# wrong answer for the one a human reaches for: PUSH_LATEST=true would publish and
# silently leave :latest behind. Name the two accepted values instead.
check-push-latest:
	@case "$(PUSH_LATEST)" in \
		1 | 0) ;; \
		*) echo "make -C images: PUSH_LATEST is '$(PUSH_LATEST)' - expected 1 (also move :latest) or 0 (leave it)." >&2; \
		   exit 1;; \
	esac

# UBUNTU_VERSION reaches this repository's name *and* the base it is built from, so a release
# misspelled or not yet pinned would be published under a name claiming a release it does not
# contain. Only the defaulted BASE_ARGS is guarded — that one is this file's own pin, and the
# lookup is what has to answer. A caller-supplied BASE_ARGS is the caller's own base, pinned or
# upstream (`BASE_ARGS=`) as they chose, and this file has nothing to check it against.
check-ubuntu-base:
	@test "$(origin BASE_ARGS)" != file || test -n "$(UBUNTU_BASE_DIGEST)" || { \
		echo "make -C images: UBUNTU_VERSION=$(UBUNTU_VERSION) has no pinned base in UBUNTU_BASE_DIGESTS." >&2; \
		echo "                Add '<version>=sha256:<digest>' for the mirror's copy of that release, and" >&2; \
		echo "                re-run operator/hack/mirror-e2e-images.sh if it is not mirrored yet." >&2; \
		echo "                Or pass BASE_ARGS= to build FROM upstream, unpinned." >&2; \
		exit 1; }

# MACA_TAG is read out of MACA_PACKAGE, so a vendor package whose tag carries only one of the two
# axes would publish a name with an empty field — '4.0--torch2.5-<sha>' — claiming less than the
# image is (and a vendor rename is the one thing a base bump can bring). Stop instead of publishing
# it; the fix is the derivation above.
#
# The package also selects the base, so that lookup is checked too — and likewise only for the
# defaulted BASE_ARGS, since a caller who passed their own chose their own base.
check-maca-base:
	@test -n "$(MACA_PKG_VERSION)" && test -n "$(MACA_PKG_PY)" && test -n "$(MACA_PKG_TORCH)" || { \
		echo "make -C images: cannot read the vendor axes out of MACA_PACKAGE=$(MACA_PACKAGE)." >&2; \
		echo "                Expected <version>-torch<ver>-py<python>-<distro>-<arch>." >&2; \
		exit 1; }
	@test "$(origin BASE_ARGS)" != file || test -n "$(MACA_BASE_DIGEST)" || { \
		echo "make -C images: MACA_PACKAGE=$(MACA_PACKAGE) has no pinned base in MACA_BASE_DIGESTS." >&2; \
		echo "                Add '<package>=sha256:<digest>' for the mirror's copy of that package," >&2; \
		echo "                then verify the digest against the mirror rather than the tag." >&2; \
		echo "                Or pass BASE_ARGS= to build FROM upstream, unpinned." >&2; \
		exit 1; }

# CUDA_TAG is read out of CUDA_PACKAGE too, and its derivation reads only the first field of the
# tag — so a re-tagged or renamed release whose version cannot be picked out would publish
# '-<sha>', a name with no vendor release in it at all. Stop instead; the fix is the derivation
# above.
#
# The package also selects the base, so that lookup is checked the way check-ubuntu-base checks
# its release — and likewise only for the defaulted BASE_ARGS: a caller who passed their own chose
# their own base, and this file has nothing to check it against.
check-cuda-base:
	@test -n "$(CUDA_PKG_VERSION)" || { \
		echo "make -C images: cannot read the vendor release out of CUDA_PACKAGE=$(CUDA_PACKAGE)." >&2; \
		echo "                Expected <release>-py<python>, e.g. pytorch:26.08-py3." >&2; \
		exit 1; }
	@test "$(origin BASE_ARGS)" != file || test -n "$(CUDA_BASE_DIGEST)" || { \
		echo "make -C images: CUDA_PACKAGE=$(CUDA_PACKAGE) has no pinned base in CUDA_BASE_DIGESTS." >&2; \
		echo "                Add '<package>=sha256:<digest>' for the mirror's copy of that release," >&2; \
		echo "                then verify the digest against the mirror rather than the tag." >&2; \
		echo "                Or pass BASE_ARGS= to build FROM upstream, unpinned." >&2; \
		exit 1; }

build: build-ssh build-jupyter build-maca build-ssh-maca build-cuda build-ssh-cuda ## Build every image

build-ssh: check-tag check-platform check-ubuntu-base ## Build the self-authored ssh image
	$(CONTAINER_TOOL) build --platform "$(PLATFORM)" $(BASE_ARGS) $(APT_MIRROR_ARG) --build-arg UBUNTU_VERSION=$(UBUNTU_VERSION) \
		-f ssh-ubuntu-server/Dockerfile -t $(IMG_SSH) .

build-jupyter: check-tag check-platform ## Build the jupyter image
	$(CONTAINER_TOOL) build --platform "$(PLATFORM)" $(BASE_ARGS) $(APT_MIRROR_ARG) $(PIP_INDEX_URL_ARG) \
		-f jupyter/Dockerfile -t $(IMG_JUPYTER) .

# MACA_PLATFORM, not PLATFORM: the MACA images have no arm64 base to build from, so they stay
# amd64 on every host rather than following the platform the other two build for.
build-maca: check-tag check-maca-base ## Build the metax MACA image (linux/amd64 only)
	$(CONTAINER_TOOL) build --platform "$(MACA_PLATFORM)" $(BASE_ARGS) $(APT_MIRROR_ARG) $(PIP_INDEX_URL_ARG) \
		-f jupyter-maca-pytorch/Dockerfile -t $(IMG_MACA) .

# No PIP_INDEX_URL_ARG: this image installs nothing from pip, and the vendor base ships no pip.
build-ssh-maca: check-tag check-maca-base ## Build the metax MACA ssh image (linux/amd64 only)
	$(CONTAINER_TOOL) build --platform "$(MACA_PLATFORM)" $(BASE_ARGS) $(APT_MIRROR_ARG) \
		-f ssh-maca-pytorch/Dockerfile -t $(IMG_SSH_MACA) .

# CUDA_PLATFORM, for the same reason the MACA pair does not use PLATFORM.
#
# No PIP_INDEX_URL_ARG on either: this overlay installs nothing from pip — the NGC base carries
# its own jupyter stack, and the ssh sibling carries none.
build-cuda: check-tag check-cuda-base ## Build the NVIDIA CUDA image (linux/amd64 only)
	$(CONTAINER_TOOL) build --platform "$(CUDA_PLATFORM)" $(BASE_ARGS) $(APT_MIRROR_ARG) \
		-f jupyter-cuda-pytorch/Dockerfile -t $(IMG_CUDA) .

build-ssh-cuda: check-tag check-cuda-base ## Build the NVIDIA CUDA ssh image (linux/amd64 only)
	$(CONTAINER_TOOL) build --platform "$(CUDA_PLATFORM)" $(BASE_ARGS) $(APT_MIRROR_ARG) \
		-f ssh-cuda-pytorch/Dockerfile -t $(IMG_SSH_CUDA) .

smoke: build ## Build and run the full local Docker smoke
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) IMG_MACA=$(IMG_MACA) IMG_SSH_MACA=$(IMG_SSH_MACA) IMG_CUDA=$(IMG_CUDA) IMG_SSH_CUDA=$(IMG_SSH_CUDA) hack/smoke.sh

smoke-ssh: build-ssh ## Build and smoke only the self-authored ssh image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) IMG_MACA=$(IMG_MACA) IMG_SSH_MACA=$(IMG_SSH_MACA) IMG_CUDA=$(IMG_CUDA) IMG_SSH_CUDA=$(IMG_SSH_CUDA) hack/smoke.sh --ssh

smoke-jupyter: build-jupyter ## Build and smoke only the jupyter image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) IMG_MACA=$(IMG_MACA) IMG_SSH_MACA=$(IMG_SSH_MACA) IMG_CUDA=$(IMG_CUDA) IMG_SSH_CUDA=$(IMG_SSH_CUDA) hack/smoke.sh --jupyter

smoke-maca: build-maca ## Build and smoke only the metax MACA image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) IMG_MACA=$(IMG_MACA) IMG_SSH_MACA=$(IMG_SSH_MACA) IMG_CUDA=$(IMG_CUDA) IMG_SSH_CUDA=$(IMG_SSH_CUDA) hack/smoke.sh --maca

smoke-ssh-maca: build-ssh-maca ## Build and smoke only the metax MACA ssh image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) IMG_MACA=$(IMG_MACA) IMG_SSH_MACA=$(IMG_SSH_MACA) IMG_CUDA=$(IMG_CUDA) IMG_SSH_CUDA=$(IMG_SSH_CUDA) hack/smoke.sh --ssh-maca

smoke-cuda: build-cuda ## Build and smoke only the NVIDIA CUDA image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) IMG_MACA=$(IMG_MACA) IMG_SSH_MACA=$(IMG_SSH_MACA) IMG_CUDA=$(IMG_CUDA) IMG_SSH_CUDA=$(IMG_SSH_CUDA) hack/smoke.sh --cuda

smoke-ssh-cuda: build-ssh-cuda ## Build and smoke only the NVIDIA CUDA ssh image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) IMG_MACA=$(IMG_MACA) IMG_SSH_MACA=$(IMG_SSH_MACA) IMG_CUDA=$(IMG_CUDA) IMG_SSH_CUDA=$(IMG_SSH_CUDA) hack/smoke.sh --ssh-cuda

push: push-ssh push-jupyter push-maca push-ssh-maca push-cuda push-ssh-cuda ## Publish every image (TAG + :latest)

push-ssh: check-tag check-platforms check-push-latest check-ubuntu-base ## Publish the ssh image as a multi-arch index (TAG, and :latest unless PUSH_LATEST=0)
	$(CONTAINER_TOOL) buildx build $(PLATFORMS_ARG) $(BUILDX_ATTEST) $(BASE_ARGS) $(APT_MIRROR_ARG) \
		--build-arg UBUNTU_VERSION=$(UBUNTU_VERSION) \
		-f ssh-ubuntu-server/Dockerfile -t $(IMG_SSH) $(LATEST_ARG_SSH) --push .

push-jupyter: check-tag check-platforms check-push-latest ## Publish the jupyter image as a multi-arch index (TAG, and :latest unless PUSH_LATEST=0)
	$(CONTAINER_TOOL) buildx build $(PLATFORMS_ARG) $(BUILDX_ATTEST) $(BASE_ARGS) $(APT_MIRROR_ARG) $(PIP_INDEX_URL_ARG) \
		-f jupyter/Dockerfile -t $(IMG_JUPYTER) $(LATEST_ARG_JUPYTER) --push .

# check-platforms would be checking PLATFORMS, which this target deliberately does not read;
# MACA_PLATFORM is the whole of what it publishes, and PLATFORMS_ARG is what would break it.
push-maca: check-tag check-maca-base check-push-latest ## Publish the metax MACA image (linux/amd64 only, TAG and :latest unless PUSH_LATEST=0)
	$(CONTAINER_TOOL) buildx build --platform "$(MACA_PLATFORM)" $(BUILDX_ATTEST) $(BASE_ARGS) $(APT_MIRROR_ARG) $(PIP_INDEX_URL_ARG) \
		-f jupyter-maca-pytorch/Dockerfile -t $(IMG_MACA) $(LATEST_ARG_MACA) --push .

push-ssh-maca: check-tag check-maca-base check-push-latest ## Publish the metax MACA ssh image (linux/amd64 only, TAG and :latest unless PUSH_LATEST=0)
	$(CONTAINER_TOOL) buildx build --platform "$(MACA_PLATFORM)" $(BUILDX_ATTEST) $(BASE_ARGS) $(APT_MIRROR_ARG) \
		-f ssh-maca-pytorch/Dockerfile -t $(IMG_SSH_MACA) $(LATEST_ARG_SSH_MACA) --push .

push-cuda: check-tag check-cuda-base check-push-latest ## Publish the NVIDIA CUDA image (linux/amd64 only, TAG and :latest unless PUSH_LATEST=0)
	$(CONTAINER_TOOL) buildx build --platform "$(CUDA_PLATFORM)" $(BUILDX_ATTEST) $(BASE_ARGS) $(APT_MIRROR_ARG) \
		-f jupyter-cuda-pytorch/Dockerfile -t $(IMG_CUDA) $(LATEST_ARG_CUDA) --push .

push-ssh-cuda: check-tag check-cuda-base check-push-latest ## Publish the NVIDIA CUDA ssh image (linux/amd64 only, TAG and :latest unless PUSH_LATEST=0)
	$(CONTAINER_TOOL) buildx build --platform "$(CUDA_PLATFORM)" $(BUILDX_ATTEST) $(BASE_ARGS) $(APT_MIRROR_ARG) \
		-f ssh-cuda-pytorch/Dockerfile -t $(IMG_SSH_CUDA) $(LATEST_ARG_SSH_CUDA) --push .

# Repoint :latest at a TAG already in the registry rather than rebuilding: imagetools
# writes an index naming the same manifests, so this cannot publish anything the build
# did not produce. It is how a caller that withheld :latest from `push` moves it after
# deciding to. Needs no PLATFORMS: nothing is built.
#
# RETAG names the images to move. A caller that published only some of them must not move
# the rest: the ref a skipped image would name is one this run never pushed, so its retag
# would fail on a missing manifest, and a tag that another run published is that run's to
# move. Defaults to every image, which is what a human means.
RETAG ?= ssh jupyter maca ssh-maca cuda ssh-cuda

retag-latest: $(addprefix retag-latest-,$(RETAG)) ## Repoint :latest at an already-published TAG (no rebuild; RETAG names the images)
retag-latest-ssh: check-tag
	$(CONTAINER_TOOL) buildx imagetools create -t $(LATEST_SSH) $(IMG_SSH)
retag-latest-jupyter: check-tag
	$(CONTAINER_TOOL) buildx imagetools create -t $(LATEST_JUPYTER) $(IMG_JUPYTER)
retag-latest-maca: check-tag
	$(CONTAINER_TOOL) buildx imagetools create -t $(LATEST_MACA) $(IMG_MACA)
retag-latest-ssh-maca: check-tag
	$(CONTAINER_TOOL) buildx imagetools create -t $(LATEST_SSH_MACA) $(IMG_SSH_MACA)
retag-latest-cuda: check-tag
	$(CONTAINER_TOOL) buildx imagetools create -t $(LATEST_CUDA) $(IMG_CUDA)
retag-latest-ssh-cuda: check-tag
	$(CONTAINER_TOOL) buildx imagetools create -t $(LATEST_SSH_CUDA) $(IMG_SSH_CUDA)

help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
