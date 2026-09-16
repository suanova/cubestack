# Images workspace Makefile — build, smoke & publish the DevEnvironment base images.
# Build context is this directory (see AGENTS.md). Each image has one name: a build is
# tagged at the reference it publishes under, and the push targets add :latest to — never
# rebuild — the image the smoke just accepted.

CONTAINER_TOOL ?= docker

# The architecture every published image must run on: the cluster's nodes are amd64, and the
# machine building them may not be. Both Dockerfiles start from a multi-arch base (ubuntu,
# quay.io/jupyter), and without --platform `docker build` resolves that base to the *host*
# architecture — so a build on an arm64 host publishes an arm64-only image and every amd64 node
# then fails to pull it ("no match for platform in manifest"). Naming the platform makes the
# build independent of the host; PLATFORM=linux/arm64 is the explicit opt-in to build for
# another one. `docker buildx imagetools inspect --raw <ref>` shows what a registry received.
PLATFORM ?= linux/amd64

# Optional mirror overrides for CN/offline builds (empty = upstream).
APT_MIRROR    ?=
PIP_INDEX_URL ?=

# Base release of the self-authored ssh image. It selects the build base AND names the
# published repository (decision doc §5), so the name cannot outlive the base.
UBUNTU_VERSION ?= 22.04

APT_MIRROR_ARG    = $(if $(APT_MIRROR),--build-arg APT_MIRROR=$(APT_MIRROR))
PIP_INDEX_URL_ARG = $(if $(PIP_INDEX_URL),--build-arg PIP_INDEX_URL=$(PIP_INDEX_URL))

# Publishing coordinates (decision doc §5). One name per image: a build is tagged at the
# reference it will be published under, so the image `make smoke` accepts is the image
# `make push` ships — push adds :latest to that image rather than rebuilding it.
# TAG defaults to the short commit SHA, so a bare `make build` yields a traceable,
# non-floating reference. It names the last commit, not the working tree, and is resolved
# per make invocation — keep build/smoke/push in one go (`make push` does all three) or
# pass an explicit TAG (§5 schemes). Publishing an older commit moves :latest backwards.
# Authenticate first: docker login $(REGISTRY).
#
# TAG has no fallback: a build must name a real commit, so there is nothing to
# substitute when git metadata is missing (a source tarball). git rev-parse then
# yields nothing and every reference would end at the ':'; check-tag fails with
# that reason instead, rather than inventing a non-reproducible tag.
REGISTRY ?= harbor.isuanova.com
PROJECT  ?= suanova
TAG      ?= $(shell git rev-parse --short HEAD 2>/dev/null)

SSH_REPO     = $(REGISTRY)/$(PROJECT)/ssh-ubuntu$(UBUNTU_VERSION)
# -minimal is the docker-stacks stack variant this overlay is built on (decision doc §5); unlike
# UBUNTU_VERSION it is not a build arg, so the name is a literal here and the base stays pinned in
# jupyter/Dockerfile.
JUPYTER_REPO = $(REGISTRY)/$(PROJECT)/jupyter-minimal

IMG_SSH     ?= $(SSH_REPO):$(TAG)
IMG_JUPYTER ?= $(JUPYTER_REPO):$(TAG)

# The moving publish tag: added by `make push`, never produced by `make build`, so a
# local :latest means it came from a publish.
LATEST_SSH     = $(SSH_REPO):latest
LATEST_JUPYTER = $(JUPYTER_REPO):latest

.PHONY: help check-tag check-platform build build-ssh build-jupyter smoke smoke-ssh \
	smoke-jupyter push push-ssh push-jupyter

.DEFAULT_GOAL := help

# Every build/smoke/push target funnels through build-ssh or build-jupyter, so this
# is the one place a missing TAG has to be caught.
check-tag:
	@test -n "$(TAG)" || { \
		echo "make -C images: TAG is empty - 'git rev-parse --short HEAD' returned nothing" >&2; \
		echo "                (not a git checkout?); pass TAG=<tag> explicitly." >&2; \
		exit 1; }

# `docker build` takes exactly one platform, so a list would surface as an opaque BuildKit error
# about the driver. Multi-platform would need `docker buildx build --push`, which this Makefile
# deliberately does not use: `--push` publishes straight from the build, leaving nothing local
# for the smoke to accept.
check-platform:
	@test -n "$(PLATFORM)" || { \
		echo "make -C images: PLATFORM is empty - name the platform the images run on (e.g. linux/amd64)." >&2; \
		exit 1; }
	@case "$(PLATFORM)" in \
		*,*) echo "make -C images: PLATFORM takes one platform, not a list (got '$(PLATFORM)')." >&2; \
		     echo "                Build each platform separately, or use 'docker buildx build --platform <list> --push'." >&2; \
		     exit 1;; \
	esac

build: build-ssh build-jupyter ## Build both images

build-ssh: check-tag check-platform ## Build the self-authored ssh image
	$(CONTAINER_TOOL) build --platform "$(PLATFORM)" $(APT_MIRROR_ARG) --build-arg UBUNTU_VERSION=$(UBUNTU_VERSION) \
		-f ssh-ubuntu-server/Dockerfile -t $(IMG_SSH) .

build-jupyter: check-tag check-platform ## Build the jupyter image
	$(CONTAINER_TOOL) build --platform "$(PLATFORM)" $(APT_MIRROR_ARG) $(PIP_INDEX_URL_ARG) \
		-f jupyter/Dockerfile -t $(IMG_JUPYTER) .

smoke: build ## Build and run the full local Docker smoke
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) hack/smoke.sh

smoke-ssh: build-ssh ## Build and smoke only the self-authored ssh image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) hack/smoke.sh --ssh

smoke-jupyter: build-jupyter ## Build and smoke only the jupyter image
	IMG_SSH=$(IMG_SSH) IMG_JUPYTER=$(IMG_JUPYTER) hack/smoke.sh --jupyter

push: push-ssh push-jupyter ## Build then publish both images ($(TAG) + :latest)

push-ssh: build-ssh ## Build, then publish the self-authored ssh image (adds :latest)
	$(CONTAINER_TOOL) tag $(IMG_SSH) $(LATEST_SSH)
	$(CONTAINER_TOOL) push $(IMG_SSH)
	$(CONTAINER_TOOL) push $(LATEST_SSH)

push-jupyter: build-jupyter ## Build, then publish the jupyter image (adds :latest)
	$(CONTAINER_TOOL) tag $(IMG_JUPYTER) $(LATEST_JUPYTER)
	$(CONTAINER_TOOL) push $(IMG_JUPYTER)
	$(CONTAINER_TOOL) push $(LATEST_JUPYTER)

help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
