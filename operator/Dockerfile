# Build the manager binary
#
# Both bases are build args defaulting to upstream. The e2e overrides them with
# the platform registry's copies (see BASE_MIRRORS in the Makefile) so its pulls
# do not go to Docker Hub and GCR; leaving them as the defaults keeps a bare
# `make docker-build` — and any build outside the platform's network — working.
#
# Both must be declared before the first FROM. An ARG declared after one is
# scoped to that stage, and the second FROM then expands to a blank base name —
# "base name (${DISTROLESS_BASE}) should not be blank".
# The golang base is pinned to a patch version, not to the 1.27 line: go.mod
# requires go 1.27.1 (envoyproxy/ai-gateway v1.2.0), and a base older than that
# makes the build download a toolchain at build time.
ARG GOLANG_BASE=golang:1.27.1
ARG DISTROLESS_BASE=gcr.io/distroless/static:nonroot
FROM ${GOLANG_BASE} AS builder
ARG TARGETOS
ARG TARGETARCH
# The activity-agent reference this manager should ask for. Empty means "name
# none", and the build then keeps internal/controller/assets.go's own default —
# a local build has no better answer than the latest published agent. CI names
# the commit-addressed tag it publishes, so the manager and the sidecar it
# creates are always the pair built from one commit; see the Makefile's
# ACTIVITY_AGENT_IMAGE.
ARG ACTIVITY_AGENT_IMAGE
# Use the goproxy.cn module mirror (the default proxy.golang.org is
# unreachable from this network without a proxy). Override with
# --build-arg GOPROXY=... if needed.
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}

WORKDIR /workspace
# Copy the Go Modules manifests
COPY go.mod go.mod
COPY go.sum go.sum
# cache deps before building and copying source so that we don't need to re-download as much
# and so that source changes don't invalidate our downloaded layer
RUN go mod download

# Copy the Go source (relies on .dockerignore to filter)
COPY . .

# Build
# the GOARCH has no default value to allow the binary to be built according to the host where the command
# was called. For example, if we call make docker-build in a local env which has the Apple Silicon M1 SO
# the docker BUILDPLATFORM arg will be linux/arm64 when for Apple x86 it will be linux/amd64. Therefore,
# by leaving it empty we can ensure that the container and binary shipped on it will have the same platform.
#
# The sidecar reference is only overridden when the build names one: -X with an
# empty value would set the variable to the empty string and leave the manager
# asking for an image called "", which is worse than the default it would
# otherwise keep.
RUN ldflags=""; \
    if [ -n "${ACTIVITY_AGENT_IMAGE}" ]; then \
        ldflags="-X github.com/suanova/cubestack/internal/controller.activityAgentImage=${ACTIVITY_AGENT_IMAGE}"; \
    fi; \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -a -ldflags "${ldflags}" -o manager cmd/main.go

# Use distroless as minimal base image to package the manager binary
# Refer to https://github.com/GoogleContainerTools/distroless for more details
FROM ${DISTROLESS_BASE}
WORKDIR /
COPY --from=builder /workspace/manager .
USER 65532:65532

ENTRYPOINT ["/manager"]
