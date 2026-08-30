# syntax=docker/dockerfile:1.7

FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995 AS secured-node

RUN apk add --no-cache --upgrade libcrypto3=3.5.8-r0 libssl3=3.5.8-r0

FROM secured-node AS build

ENV HUSKY=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN --mount=type=cache,id=atlas-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter atlas-exchange --filter @atlas/web...

COPY tsconfig.base.json ./
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json apps/web/
COPY apps/web/src apps/web/src
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json packages/contracts/

RUN pnpm --filter @atlas/web build
RUN --mount=type=cache,id=atlas-pnpm,target=/pnpm/store \
    pnpm --filter @atlas/web deploy --prod /deploy/web

FROM secured-node AS runtime

ARG ATLAS_IMAGE_VERSION=0.1.0-local
ARG ATLAS_IMAGE_REVISION=unknown
ARG ATLAS_IMAGE_CREATED=1970-01-01T00:00:00.000Z
ARG ATLAS_IMAGE_SOURCE=https://github.com/Ashutosh-code-arch/AtlasExchange

LABEL org.opencontainers.image.title="Atlas Web" \
      org.opencontainers.image.description="Atlas Exchange browser application and production static server" \
      org.opencontainers.image.source="${ATLAS_IMAGE_SOURCE}" \
      org.opencontainers.image.version="${ATLAS_IMAGE_VERSION}" \
      org.opencontainers.image.revision="${ATLAS_IMAGE_REVISION}" \
      org.opencontainers.image.created="${ATLAS_IMAGE_CREATED}"

ENV NODE_ENV=production \
    ATLAS_APPLICATION_VERSION="${ATLAS_IMAGE_VERSION}" \
    ATLAS_WEB_PORT=8080

WORKDIR /app

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=node:node /workspace/apps/web/dist ./dist
COPY --from=build --chown=node:node /deploy/web/node_modules ./node_modules
COPY --chown=node:node apps/web/scripts/production-web-server.mjs ./scripts/production-web-server.mjs

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const port = process.env.PORT ?? process.env.ATLAS_WEB_PORT ?? '8080'; fetch(`http://127.0.0.1:${port}/health/live`).then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "scripts/production-web-server.mjs"]
