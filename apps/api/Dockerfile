# syntax=docker/dockerfile:1.7

FROM node:24.19.0-bookworm-slim AS build

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

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /deploy/api/package.json ./package.json
COPY --from=build --chown=node:node /deploy/api/node_modules ./node_modules
COPY --from=build --chown=node:node /deploy/api/dist ./dist
COPY --from=build --chown=node:node /deploy/api/migrations ./migrations
COPY --from=build --chown=node:node /deploy/api/resources ./resources

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/server.js"]
