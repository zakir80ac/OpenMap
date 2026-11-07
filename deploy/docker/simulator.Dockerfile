# REQ-QA-005 (ADR-042) — simulated mode: vendor API simulators rendered from a synthetic estate, for the compose
# profile "simulated". Never part of a production or air-gap bundle. Build from the repository root:
#   docker build -f deploy/docker/simulator.Dockerfile -t openmap/simulator .
# syntax=docker/dockerfile:1.7
ARG GO_VERSION=1.27

FROM golang:${GO_VERSION}-bookworm AS build
ENV CGO_ENABLED=0
WORKDIR /src
COPY go.work go.work.sum ./
COPY apps/collectors ./apps/collectors
COPY apps/node ./apps/node
COPY tools/simulator ./tools/simulator
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    cd tools/simulator && go build -trimpath -ldflags="-s -w" -o /out/simulator ./cmd/simulator
RUN mkdir -p /out/plan

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
LABEL org.opencontainers.image.title="openmap-simulator" \
      org.opencontainers.image.description="OpenMap simulated mode (provenance: simulated)" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /out/simulator /usr/local/bin/simulator
COPY --from=build --chown=nonroot:nonroot /out/plan /plan
# verify needs a Go toolchain and the repository; the image only serves.
ENTRYPOINT ["/usr/local/bin/simulator"]
CMD ["serve", "--estate", "/estate", "--plan", "/plan/sim-plan.json", "--bind", "0.0.0.0", "--advertise", "simulator"]
