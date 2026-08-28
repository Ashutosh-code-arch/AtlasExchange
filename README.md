# Atlas Exchange

Atlas Exchange is a production-inspired centralized-exchange learning platform. The repository is
being delivered incrementally so every phase leaves behind a runnable, tested system.

## Latest completed phase: Market Data

The implemented foundation, Identity, Financial, and Trading phases provide:

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
  Mailpit;
- exact spot limit orders, durable reservation, deterministic price-time matching, immutable trades,
  atomic four-wallet settlement, owner-scoped history, and a responsive exchange-style Trading desk.

The completed Market Data phase derives truthful views from committed Atlas Trading facts. It provides
sequence-aware public level-two order-book and rolling 24-hour ticker views plus responsive web
depth, ticker, and candlestick panels. An independently checkpointed candle projection adds exact
sparse UTC OHLCV for six accepted intervals and runs under the managed projection worker with a
coherent cursor-based internal history reader and anonymous bounded REST history. Its responsive SVG
chart preserves real time gaps, distinguishes open candles, exposes freshness, and safely refreshes
the active market and interval. A strict versioned WebSocket gateway now delivers bounded full
replacement snapshots for book, ticker, and candles with grouped refreshes, heartbeat detection,
backpressure, and graceful shutdown. The Trading workspace multiplexes all three views over one
browser connection, pauses it while hidden, resubscribes after bounded reconnect, rejects mismatched
snapshots, and retains last-valid data as visibly stale during interruption. Market Data is never part of
matching or settlement authority, and external prices and fabricated liquidity remain out of scope.
The Trading boundary publishes private-safe, versioned final-state facts under a durable per-market
sequence. Market Data now consumes that boundary into generation-aware checkpoints, private active
order state, and exact deterministic level-two aggregates with replay and gap protection. A managed
per-market worker continuously advances those projections with bounded polling, retry/backoff,
graceful shutdown, and structured sequence-lag diagnostics.
The public REST snapshots remain bounded diagnostic and direct-consumer boundaries with exact
decimal depth, committed-trade ticker values, sparse candle history, sequence freshness, short
caching, and rate limiting. Phase 6 has begun with an exact read-only portfolio snapshot foundation.
It composes Financial balances, direct USD Trading markets, and committed Atlas ticker prices without
creating a second balance authority, fabricating missing values, or using floating-point valuation.
Authenticated delivery and the Portfolio UI are the next increment; notifications and administration
follow later in the phase.

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
