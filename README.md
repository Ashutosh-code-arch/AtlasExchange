# Atlas Exchange

Atlas Exchange is a production-inspired centralized-exchange learning platform. The repository is
being delivered incrementally so every phase leaves behind a runnable, tested system.

## Current phase: Engineering foundation

This phase provides:

- a pnpm TypeScript monorepo;
- a React/Vite operations console;
- an Express API with structured logging and request correlation;
- PostgreSQL migration and readiness checks;
- shared runtime contracts;
- lint, formatting, type-check, test, build, Docker Compose, and CI quality gates.

Domain functionality such as identity, wallets, ledger, and trading is intentionally introduced in
later phases.

## Prerequisites

- Node.js `24.19.0` (the exact version is enforced by `package.json`)
- pnpm `11.20.0`
- Docker with Compose

## Start locally

```bash
corepack enable
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm db:up
pnpm mail:up
pnpm db:migrate
pnpm dev
```

The web application runs at `http://localhost:5173`, the API at `http://localhost:3000`, and the
Mailpit inbox at `http://localhost:8025`.
Set `ATLAS_POSTGRES_PORT` before `pnpm db:up` when host port `5432` is already in use.

## Commands

```bash
pnpm dev            # run API and web development servers
pnpm db:up          # start the local PostgreSQL container
pnpm mail:up        # start the local SMTP capture inbox
pnpm db:migrate     # apply committed migrations
pnpm verify         # typecheck, lint, format-check, and test
pnpm build          # create production artifacts
```

See [Phase delivery](docs/engineering/phase-delivery.md) for scope and completion criteria.
