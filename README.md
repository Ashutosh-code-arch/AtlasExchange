# Atlas Exchange

A full-stack exchange simulator with a light trading interface, a price-time matching engine,
simulated wallets, double-entry accounting, and live reference market data.

Atlas is built for learning and private demonstration. **All funds and trades are simulated.**
It does not hold real money or cryptocurrency, send orders to an external exchange, or provide
brokerage services. Coinbase reference prices are separate from Atlas order execution.

## Features

- Local registration, email verification, authentication, rotating sessions, and account security.
- BTC, ETH, and USD wallets with simulated deposits and withdrawals.
- BTC-USD and ETH-USD spot limit orders, cancellation, price-time matching, and atomic settlement.
- Simulated order books, executions, tickers, and candlestick history.
- Separately labeled Coinbase reference prices and candles when the feed is enabled.
- Light/grey Dashboard, Trade, Orders, Portfolio, Funds, and Profile pages.
- Notifications and role-protected, audited administration tools.

There is no automatic liquidity provider: a fill requires a compatible order from another Atlas
account. Market orders, real deposits/withdrawals, and external order routing are not supported.

## Architecture

Atlas is a pnpm monorepo. The API is a modular monolith with business-owned modules and explicit
public interfaces; sharing a repository does not make applications one deployment.

| Area                  | Technology                                                     |
| --------------------- | -------------------------------------------------------------- |
| Web                   | React, TypeScript, Vite                                        |
| API                   | Node.js, Express, TypeScript                                   |
| Persistence           | PostgreSQL, Kysely, `pg`, committed migrations                 |
| Contracts             | Shared TypeScript and Zod schemas                              |
| Market updates        | REST snapshots and WebSockets                                  |
| Tests                 | Vitest, React Testing Library, Supertest, Playwright           |
| Local services        | Docker Compose, PostgreSQL, Mailpit                            |
| Demo hosting topology | Cloudflare Worker + Static Assets, Render API, Neon PostgreSQL |

```text
apps/
  web/                 React application
  api/                 API, business modules, and database migrations
  gateway/             Cloudflare Worker and static-asset gateway
packages/
  contracts/           Shared runtime schemas and transport types
infra/                 Local services and deployment configuration
tests/e2e/             Cross-application browser journeys
scripts/               Repository automation and validation
docs/                  Architecture decisions and engineering runbooks
```

## Run locally

### 1. Prerequisites

- Node.js **24.19.0**, matching `.node-version`, `.nvmrc`, and `package.json`.
- pnpm **11.20.0**, matching the root `packageManager` field.
- Docker with Docker Compose available and running.

Select the pinned Node runtime before installing dependencies. Browser-test dependencies are only
needed when running E2E tests.

### 2. Clone and configure

```bash
git clone https://github.com/Ashutosh-code-arch/AtlasExchange.git
cd AtlasExchange
pnpm install --frozen-lockfile
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

The copy commands are for a fresh checkout. Preserve existing `.env` files and compare them with
the examples instead of overwriting them. Never commit credentials or operator environment files.
The example database credentials are for disposable local development only.

### 3. Start services

```bash
docker compose -f infra/compose.yaml up -d --wait postgres mailpit
pnpm db:migrate
pnpm dev
```

Keep the development command running. It builds shared contracts and starts the development tasks.

| Service                             | Local address                           |
| ----------------------------------- | --------------------------------------- |
| Atlas UI                            | [localhost:5173](http://localhost:5173) |
| API                                 | [localhost:3000](http://localhost:3000) |
| Mailpit verification/recovery inbox | [localhost:8025](http://localhost:8025) |

If PostgreSQL port `5432` is occupied, set `ATLAS_POSTGRES_PORT` before starting Compose and change
the port in `apps/api/.env` → `DATABASE_URL` to match. If you change the API or web port, also update
`VITE_API_BASE_URL` or `WEB_ORIGIN`, respectively. Restart the servers after environment changes.

### 4. Create a local account

1. Open the UI and choose **Create account**.
2. Enter an email address and a password meeting the displayed requirements.
3. Open Mailpit and follow the verification link in the captured message.
4. Return to Atlas and sign in.

Local messages stay in Mailpit; they are not delivered to a real email inbox. There are no default
user or administrator credentials. Local registration is separate from the restricted hosted demo.

## Simulate buying and selling

Use two distinct verified accounts. Sign out and switch accounts, or use separate browser profiles
so their session cookies remain independent. Two ordinary tabs in one profile share an account.

This walkthrough assumes fresh wallets and an empty BTC-USD book. Existing matching orders can
change the fill sequence and result.

### Seller

1. Sign in as the seller and open **Funds**.
2. Select BTC, open the BTC wallet, and **Add simulated funds** of `1` BTC.
3. Select USD and open a USD wallet to receive proceeds.
4. Open **Trade**, select BTC-USD, and submit a **Sell** limit order for `0.5` BTC at `50000` USD.
5. Without a matching buyer, the order stays open and `0.5` BTC is reserved.

### Buyer

1. Sign in as the other account and open **Funds**.
2. Open both USD and BTC wallets; add `60000` simulated USD to the USD wallet.
3. Open **Trade**, select BTC-USD, and submit a **Buy** limit order for `0.5` BTC at `51000` USD.
4. Inspect **Orders**, executions, and **Funds** for both accounts.

The buy limit crosses the resting sell order. Execution occurs at the resting order's price:
`50000` USD per BTC, so `0.5` BTC costs `25000` simulated USD.

| Account | BTC after settlement | USD after settlement |
| ------- | -------------------- | -------------------- |
| Seller  | `0.5`                | `25000`              |
| Buyer   | `0.5`                | `35000`              |

Financial quantities are handled exactly, not with authoritative floating-point money values.
Reservation, execution, and ledger settlement are coordinated transactionally.

- Orders can stay open or fill partially when matching liquidity is insufficient.
- A limit is a price constraint, not a promise of execution.
- Self-trading is prevented: when an incoming order encounters its owner's matching resting order,
  its remaining quantity is cancelled rather than traded with itself.
- Cancelling an open order releases the unfilled reservation; it does not reverse completed trades.
- Simulated withdrawals only change Atlas ledger state. They never transfer funds externally.

This flow is covered by the [trading browser journey](tests/e2e/specs/trading-journey.spec.ts).

## Real reference prices and charts

In `apps/api/.env`, set:

```dotenv
REFERENCE_MARKET_DATA_ENABLED=true
```

Restart the API. The configured adapter connects to Coinbase's public market-data WebSocket for
BTC-USD and ETH-USD without a trading API key. Outbound network access and provider availability
are required.

The Trade page labels this as **reference** data. It is not Atlas liquidity, does not execute
orders, and does not determine simulated settlement or portfolio valuation. Atlas's own candles
and ticker derive from committed simulated trades, so a fresh exchange may have no trade history.
An unavailable external feed is reported as unavailable rather than replaced with an invented price.

## Commands and tests

Run commands from the repository root:

| Command                       | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `pnpm dev`                    | Run API, web, and contract development tasks                     |
| `pnpm db:up` / `pnpm mail:up` | Start the normal local database / mail service                   |
| `pnpm db:migrate`             | Apply committed API-owned migrations                             |
| `pnpm test`                   | Run repository and workspace tests, excluding browser E2E        |
| `pnpm verify`                 | Type-check, lint, check boundaries/formatting, and run tests     |
| `pnpm test:e2e`               | Run isolated full-stack browser journeys                         |
| `pnpm build`                  | Build contracts, API, web, and gateway artifacts                 |
| `pnpm security:secrets`       | Scan source-control candidates for likely secrets                |
| `pnpm db:down`                | Stop/remove local Compose containers; retain the database volume |

API integration tests use real PostgreSQL and create/drop uniquely named test databases. Keep local
PostgreSQL running for `pnpm test`, `pnpm verify`, and API tests. The default connection matches
Compose; export a custom `DATABASE_URL` to the test process if needed. Its database role must be able
to create test databases. **Never point tests at a hosted, shared, or production server.**

Workspaces can be tested independently:

```bash
pnpm --filter @atlas/web test
pnpm --filter @atlas/api test
pnpm --filter @atlas/contracts test
pnpm --filter @atlas/gateway test
```

Before the first browser-test run:

```bash
pnpm --filter @atlas/e2e exec playwright install chromium
pnpm test:e2e
```

E2E provisions disposable PostgreSQL and Mailpit services, starts applications on available ports,
and cleans up its services afterward. It does not reuse the normal development database.
Security scans, performance tests, and deployed-environment checks have separate requirements;
see the [testing strategy](docs/engineering/testing-strategy.md).

## Hosted demo and deployment

The demo topology uses Cloudflare for web assets and the gateway, Render for the API, and Neon for
PostgreSQL. Hosted signup and recovery remain disabled by default. The capped-beta implementation
supports at most **20 total demo accounts**, including existing, pending, and suspended identities.
When full, signup stops while existing users can still sign in. Enabling the beta requires working
hosted email and the activation checks in the [capped-beta runbook](docs/engineering/capped-beta.md).
This is not a claim that public signup has been deployed. Use local development for the two-account
walkthrough until hosted activation is complete.

A local build, Git push, or local tunnel does not by itself update the hosted UI. Web-only changes
need a web build and deployment to the intended Worker. API changes need a new API
artifact/deployment; schema changes need explicit migrations. Migrations never run automatically
on API startup.

Follow the [demo hosting runbook](docs/engineering/free-demo-hosting.md) for secrets, environment
configuration, deployment targets, and recorded evidence. Verify the Worker name against the existing
deployment and preserve its configured variables when deploying; do not assume the checkout's
default Worker name identifies the live service.

The hosting policy is zero recurring cost, with no paid-plan or overage authorization. Free-tier
availability is not guaranteed. The application is not approved for real trading or custody.
See the [release runbook](docs/engineering/release-and-deployment.md) for image publication and promotion.

## Troubleshooting

- **Identity services cannot be reached / Offline:** inspect the API terminal first. Check PostgreSQL,
  migrations, and `apps/api/.env`. Locally, use `NODE_ENV=development` and `ATLAS_ENV=local`; ensure
  the web/API origins and ports match.
- **Database connection fails:** check Docker, port conflicts, and `DATABASE_URL`.
- **Verification email missing:** check Mailpit, `pnpm mail:logs`, and the API SMTP configuration.
- **Order does not fill:** check opposite-side liquidity, compatible prices, and distinct owners.
  An external reference price is not a counterparty.
- **Charts are empty:** simulated charts need Atlas trades; reference charts need the enabled,
  connected external feed. Check the displayed source and freshness state.
- **Hosted UI is old:** check the deployed Worker and the URL you opened. Local builds do not
  publish assets.

## Documentation

- [Architecture decisions](docs/architecture/decisions/)
- [Testing strategy](docs/engineering/testing-strategy.md)
- [Interface release acceptance](docs/engineering/interface-release-acceptance.md)
- [Database recovery](docs/engineering/database-recovery.md)
- [Operational readiness](docs/engineering/operational-readiness.md)
- [Phase delivery and scope](docs/engineering/phase-delivery.md)
- [Documentation governance](docs/governance/documentation-governance.md)

---

**Classification:** Reference

**Status:** Active

**Last reviewed:** 2026-09-04

**Canonical owner/source:** Accepted architecture decisions and the linked engineering runbooks.
This README is an onboarding guide, not a replacement for those decision records.
