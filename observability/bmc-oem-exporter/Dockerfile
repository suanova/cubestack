# Multi-stage build: compile the static binary from repo source, then ship it
# in scratch (no runtime base image, so no registry mirror needed at deploy time).
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/bmc-oem-exporter ./cmd/bmc-oem-exporter

FROM scratch
COPY --from=build /out/bmc-oem-exporter /bmc-oem-exporter
EXPOSE 9622
ENTRYPOINT ["/bmc-oem-exporter"]
