# REQ-INT-001 REQ-INT-002 — one image recipe for every Node service (api, scheduler, reconciler,
# bsm-engine). Build: docker build -f deploy/docker/node-service.Dockerfile --build-arg APP=api -t openmap/api .
# The build stage compiles the workspace once; `pnpm deploy` then copies only the service, its
# production dependencies and the workspace packages it imports into the runtime image.
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
RUN test -n "$APP" || (echo "build-arg APP is required (api|scheduler|reconciler|bsm-engine)" && exit 1)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @openmap/db exec prisma generate
RUN pnpm --filter "@openmap/${APP}..." build
RUN pnpm --filter "@openmap/${APP}" deploy --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="openmap-${APP}" \
      org.opencontainers.image.source="https://github.com/openmap/openmap" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
