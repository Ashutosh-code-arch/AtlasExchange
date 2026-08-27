# Atlas Exchange

Atlas Exchange is a production-inspired centralized-exchange learning platform. The repository is
being delivered incrementally so every phase leaves behind a runnable, tested system.

## Current phase: Trading

The implemented foundation, Identity, and Financial phases provide:

- a pnpm TypeScript monorepo;
- a React/Vite operations console;
- an Express API with structured logging and request correlation;
- PostgreSQL migration and readiness checks;
- shared runtime contracts;
- lint, formatting, type-check, test, build, Docker Compose, and CI quality gates;
- registration, email verification, authentication, rotating sessions, password recovery, roles,
  and account/session surfaces;
- exact asset quantities, owner-scoped wallets, append-only double-entry journals, authoritative
  balances, and retry-safe simulated deposits and withdrawals;
- an authenticated Financial web sandbox that makes no external-custody claims;
- isolated Identity, Financial, and Trading browser journeys through the web, API, PostgreSQL, and
  Mailpit.

The active phase introduces orders, balance reservation, deterministic matching, trades, atomic
settlement, owner-scoped reads, and the public Trading HTTP surface. Core Trading persistence,
commands, shared contracts, authoritative readers, and the complete public market, private
order/trade read, placement, and cancellation HTTP surface are implemented; Trading browser
delivery now includes contract-validating API functions and authenticated market, order, trade,
pagination, placement, cancellation, retry, and refresh state. A responsive exchange desk now
exposes public market rules, authenticated limit-order entry, open-order management, execution
history, and truthful Market Data deferral without inventing live prices or liquidity.
The isolated two-user Trading journey proves maker-price execution, exact wallet settlement,
persisted balances, and residual-order cancellation through the complete stack.

## Prerequisites

- Node.js `24.19.0` (the exact version is enforced by `package.json`)
- pnpm `11.20.0`
- Docker with Compose

## Start locally

```bash
corepack enable
pnpm install
pnpm --filter @atlas/e2e exec playwright install chromium
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
pnpm test:e2e       # run the isolated full-stack browser journeys
pnpm build          # create production artifacts
```

The E2E command provisions its own ephemeral PostgreSQL and Mailpit services through Docker
Compose, starts the API and web application on available ports, and removes the test services when
the run finishes. It does not reuse or modify the normal local-development database.

See [Phase delivery](docs/engineering/phase-delivery.md) for scope and completion criteria.
