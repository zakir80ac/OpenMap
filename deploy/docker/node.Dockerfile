# REQ-DISC-028 REQ-DISC-031 — Discovery Node image: the Go Node binary plus every collector binary,
# statically linked, on a distroless base with no shell. Build from the repository root:
#   docker build -f deploy/docker/node.Dockerfile -t openmap/node .
# Run with the PKI volume and the environment documented in apps/node/internal/config/config.go.
# syntax=docker/dockerfile:1.7
ARG GO_VERSION=1.27

FROM golang:${GO_VERSION}-bookworm AS build
ENV CGO_ENABLED=0
WORKDIR /src
COPY go.work go.work.sum ./
COPY apps/collectors ./apps/collectors
COPY apps/node ./apps/node
RUN --mount=type=cache,target=/go/pkg/mod cd apps/collectors && go mod download && cd ../node && go mod download
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    mkdir -p /out/collectors && cd apps/collectors && \
    for d in cmd/*/; do n=$(basename "$d"); go build -trimpath -ldflags="-s -w" -o "/out/collectors/$n" "./cmd/$n"; done && \
    cd ../node && go build -trimpath -ldflags="-s -w" -o /out/openmap-node ./cmd/openmap-node
# Empty directories copied with nonroot ownership: volumes mounted there inherit it (distroless has no shell to chown).
RUN mkdir -p /out/pki /out/evidence

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
LABEL org.opencontainers.image.title="openmap-node" \
      org.opencontainers.image.source="https://github.com/openmap/openmap" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/openmap-node /usr/local/bin/openmap-node
COPY --from=build /out/collectors /opt/openmap/collectors
COPY --from=build --chown=nonroot:nonroot /out/pki /etc/openmap/pki
COPY --from=build --chown=nonroot:nonroot /out/evidence /var/lib/openmap/evidence
ENV OPENMAP_COLLECTORS_DIR=/opt/openmap/collectors
ENV OPENMAP_EVIDENCE_DIR=/var/lib/openmap/evidence
VOLUME ["/var/lib/openmap/evidence", "/etc/openmap/pki"]
ENTRYPOINT ["/usr/local/bin/openmap-node"]
CMD ["run"]
