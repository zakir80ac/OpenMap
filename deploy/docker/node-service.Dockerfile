# REQ-INT-001 REQ-INT-002 — one image recipe for every Node service (api, scheduler, reconciler,
# bsm-engine). Build: docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=api -t openmap/api .
# The build stage compiles the workspace once; `pnpm deploy` then copies only the service, its
# production dependencies and the workspace packages it imports into the runtime image.
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# openssl: Prisma's query engine links against libssl and detects the version at generate time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
RUN test -n "$APP" || (echo "build-arg APP is required (api|scheduler|reconciler|bsm-engine)" && exit 1)
ENV TURBO_TELEMETRY_DISABLED=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @openmap/db exec prisma generate
# Turbo builds the dependency closure in graph order (dependsOn ^build), the same pipeline as CI.
RUN pnpm exec turbo run build --filter="@openmap/${APP}..."
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter "@openmap/${APP}" deploy --prod --legacy --ignore-scripts /out
# pnpm deploy copies packages from the store, so the Prisma client generated into the workspace's
# virtual store is carried over by hand into the deployed virtual store (same versioned folder).
RUN set -e; for d in /out/node_modules/.pnpm/@prisma+client@*/node_modules; do \
      src="/repo/node_modules/.pnpm/$(basename "$(dirname "$d")")/node_modules/.prisma"; \
      test -d "$src" && cp -R "$src" "$d/"; \
    done; test -d /out/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="openmap-${APP}" \
      org.opencontainers.image.source="https://github.com/openmap/openmap" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /etc/openmap/pki /var/lib/openmap/evidence && chown -R node:node /etc/openmap /var/lib/openmap
# Volumes mounted on these paths inherit the node ownership on first use (scheduler PKI, evidence).
VOLUME ["/etc/openmap/pki", "/var/lib/openmap/evidence"]
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
