# syntax=docker/dockerfile:1.7

FROM node:26.8.1-alpine3.23@sha256:871eb674ad6e692c91330a8959f1ce2f80ba3f445cdc54e306869d2ea265e42d AS secured-node

RUN apk add --no-cache --upgrade libcrypto3=3.5.8-r0 libssl3=3.5.8-r0

FROM secured-node AS build

ENV HUSKY=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN --mount=type=cache,id=atlas-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter atlas-exchange --filter @atlas/api...

COPY tsconfig.base.json ./
COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations
COPY apps/api/resources apps/api/resources
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json packages/contracts/

RUN pnpm --filter @atlas/api build
RUN --mount=type=cache,id=atlas-pnpm,target=/pnpm/store \
    pnpm --filter @atlas/api deploy --prod /deploy/api

FROM secured-node AS runtime

ARG ATLAS_IMAGE_VERSION=0.2.5-local
ARG ATLAS_IMAGE_REVISION=unknown
ARG ATLAS_IMAGE_CREATED=1970-01-01T00:00:00.000Z
ARG ATLAS_IMAGE_SOURCE=https://github.com/Ashutosh-code-arch/AtlasExchange

LABEL org.opencontainers.image.title="Atlas API" \
      org.opencontainers.image.description="Atlas Exchange HTTP API and managed market-data runtime" \
      org.opencontainers.image.source="${ATLAS_IMAGE_SOURCE}" \
      org.opencontainers.image.version="${ATLAS_IMAGE_VERSION}" \
      org.opencontainers.image.revision="${ATLAS_IMAGE_REVISION}" \
      org.opencontainers.image.created="${ATLAS_IMAGE_CREATED}"

ENV NODE_ENV=production \
    ATLAS_APPLICATION_VERSION="${ATLAS_IMAGE_VERSION}"

WORKDIR /app

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=node:node /deploy/api/package.json ./package.json
COPY --from=build --chown=node:node /deploy/api/node_modules ./node_modules
COPY --from=build --chown=node:node /deploy/api/dist ./dist
COPY --from=build --chown=node:node /deploy/api/migrations ./migrations
COPY --from=build --chown=node:node /deploy/api/resources ./resources

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port = process.env.PORT ?? process.env.API_PORT ?? '3000'; fetch(`http://127.0.0.1:${port}/health/live`).then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/server.js"]
