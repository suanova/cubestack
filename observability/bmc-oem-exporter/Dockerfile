# Build: CGO_ENABLED=0 go build -o bmc-oem-exporter ./cmd/bmc-oem-exporter
# then copy the static binary next to this Dockerfile and run buildah bud.
# FROM scratch avoids any base image pull (test env has no usable registry mirror).
FROM scratch
COPY bmc-oem-exporter /bmc-oem-exporter
EXPOSE 9622
ENTRYPOINT ["/bmc-oem-exporter"]
