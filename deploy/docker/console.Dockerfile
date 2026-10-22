# REQ-INT-001 REQ-INT-002 REQ-UI-003 — the console image. Next.js inlines the browser-facing settings
# (API origin, Keycloak origin, realm, client id) into the bundle at build time, so one image could only
# ever serve one deployment. The build therefore inlines unmistakable sentinel values, and
# console-entrypoint.sh rewrites them to the container's PUBLIC_API_URL, PUBLIC_KEYCLOAK_URL,
# KEYCLOAK_REALM and KEYCLOAK_CLIENT_ID on every start: the same image serves compose, Helm and the
# air-gapped bundle. Build: docker build -f deploy/docker/console.Dockerfile -t openmap/console .
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV TURBO_TELEMETRY_DISABLED=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
# Sentinels the entrypoint replaces at start; `.invalid` is reserved by RFC 2606 so they can never collide with a
# real origin, and the realm and client values are never valid identifiers in a realm export.
ENV PUBLIC_API_URL=http://openmap-public-api.invalid \
    PUBLIC_KEYCLOAK_URL=http://openmap-public-keycloak.invalid \
    KEYCLOAK_REALM=openmap-realm-set-at-start \
    KEYCLOAK_CLIENT_ID=openmap-client-set-at-start \
    DEFAULT_LOCALE=en
RUN pnpm exec turbo run build --filter="@openmap/console..."
# Next's standalone tracer keeps only the files the server needs; static assets and public files are copied beside it.
RUN cp -R apps/console/.next/static apps/console/.next/standalone/apps/console/.next/static \
    && if [ -d apps/console/public ]; then cp -R apps/console/public apps/console/.next/standalone/apps/console/public; fi

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
LABEL org.opencontainers.image.title="openmap-console" \
      org.opencontainers.image.source="https://github.com/openmap/openmap" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/console/.next/standalone ./
COPY --chown=node:node deploy/docker/console-entrypoint.sh /app/console-entrypoint.sh
RUN chmod +x /app/console-entrypoint.sh
USER node
ENTRYPOINT ["/app/console-entrypoint.sh"]
