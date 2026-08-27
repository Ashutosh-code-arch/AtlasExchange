# Atlas Exchange Phase Delivery

**Status:** Active  
**Last reviewed:** 2026-08-28

This document translates the canonical product and sprint documents into small, demonstrable
delivery increments. A phase is complete only after its acceptance checks pass.

| Phase                     | Outcome                                                          | Status      |
| ------------------------- | ---------------------------------------------------------------- | ----------- |
| 1. Engineering foundation | Reproducible monorepo, web/API shells, PostgreSQL, quality gates | Implemented |
| 2. Identity               | Registration, login, session rotation, roles, account profile    | Implemented |
| 3. Financial foundation   | Assets, wallets, double-entry ledger, deposits, withdrawals      | Implemented |
| 4. Trading                | Orders, reservation, matching, trades, atomic settlement         | Active      |
| 5. Market data            | Order-book views, tickers, candles, WebSocket streams            | Planned     |
| 6. Product surfaces       | Portfolio, notifications, administration                         | Planned     |
| 7. Production readiness   | Security hardening, metrics, rate limits, performance            | Planned     |
| 8. Deployment             | Deployment, runbooks, monitoring, interview evidence             | Planned     |

## Phase 1 acceptance criteria

- A clean install is reproducible from one root lockfile.
- Each workspace can type-check, test, and build independently.
- `GET /health/live` proves only process liveness.
- `GET /health/ready` reports `503` until lifecycle and PostgreSQL checks pass.
- Configuration is validated once at the application boundary and secrets are not logged.
- PostgreSQL starts from an explicitly versioned Compose service and migrations are repeatable.
- `pnpm verify` and `pnpm build` provide the local/CI quality contract.

## Phase 2 acceptance criteria

- Registration, email verification, login, logout, session listing/revocation, refresh rotation,
  and password recovery are exposed through the accepted Identity HTTP contract.
- Enumeration-resistant responses, account-state checks, compromised-password checks, exact-origin
  validation, CSRF protection, and guarded cookie policies enforce the accepted security boundaries.
- Opaque access and rotating refresh credentials are persisted server-side; replay revokes the
  affected session family.
- The current-user contract exposes the authenticated account profile and assigned roles without
  leaking persistence representations.
- Identity unit and real-PostgreSQL integration tests cover lifecycle, rollback, replay, expiry, and
  security-sensitive failure behavior.
- The isolated browser journey proves registration, captured-email verification, and authenticated
  session bootstrap through the real web, API, PostgreSQL, and Mailpit stack.

## Phase 3 entry criteria

- [ADR-020 — Financial Accounting Foundation](../architecture/decisions/ADR-020-financial-accounting-foundation.md)
  defines asset quantities, wallets, ledger accounts, journal authority, idempotency, and concurrency.
- Deposit, withdrawal, and public Financial API behavior remain gated by focused follow-up decisions.
- The first implementation increment is the independently testable asset-quantity and accounting
  domain core; persistence follows only with its invariant-preserving migration and integration tests.

## Phase 3 acceptance criteria

- Asset quantities are represented exactly at domain, persistence, and transport boundaries; no
  authoritative Financial calculation depends on JavaScript floating-point numbers.
- Wallet creation is owner-scoped and idempotent, provisions one available and one reserved account,
  and enforces one wallet per owner and asset.
- Every balance is derived from immutable, balanced journal postings rather than stored as a mutable
  wallet field.
- Simulated deposits and withdrawals are atomic, retry-safe, operationally controllable, and cannot
  violate cross-ledger balance or available-funds invariants under concurrent execution.
- Strict shared contracts and authenticated HTTP routes enforce owner derivation, CSRF, idempotency,
  safe public errors, cache controls, and retry-preserving rate limits.
- The authenticated web sandbox confirms server-authoritative wallet, deposit, withdrawal, and
  balance behavior without implying external custody or optimistic financial success.
- Unit, contract, real-PostgreSQL integration, HTTP, frontend, and isolated browser tests demonstrate
  the Financial lifecycle, concurrency boundaries, ownership isolation, and exact final balances.
- `pnpm verify`, `pnpm build`, and `pnpm test:e2e` pass at the phase boundary.

## Phase 3 completion evidence

- Exact asset quantities, wallet ownership, available/reserved accounts, append-only journals,
  idempotent posting, concurrency protection, and authoritative balance reads are implemented.
- [ADR-021 — MVP Asset Catalog and System-Account Provisioning](../architecture/decisions/ADR-021-mvp-asset-catalog-and-system-account-provisioning.md)
  defines the implemented catalog and system-account authority.
- [ADR-022 — Simulated Deposit Lifecycle and Custody Boundary](../architecture/decisions/ADR-022-simulated-deposit-lifecycle-and-custody-boundary.md)
  defines the deposit lifecycle; its persistence schema, cross-ledger invariants, atomic application
  capability, retry semantics, and concurrency controls are implemented.
- [ADR-023 — Financial HTTP API and Error Contract](../architecture/decisions/ADR-023-financial-http-api-and-error-contract.md)
  defines the Financial transport boundary; shared asset, wallet, balance, deposit, idempotency, and
  error schemas, PostgreSQL-backed read models, public and authenticated endpoints, owner derivation,
  session-bound CSRF, retry-preserving rate limiting, and HTTP contract/integration tests are
  implemented.
- [ADR-024 — Simulated Withdrawal Lifecycle and Custody Boundary](../architecture/decisions/ADR-024-simulated-withdrawal-lifecycle-and-custody-boundary.md)
  defines the accepted withdrawal lifecycle, available-balance spending rule, zero-fee accounting,
  retry ordering, concurrency boundary, and truthful simulation contract. Its immutable persistence
  schema, journal-shape constraints, exact domain record, atomic application capability, retry
  semantics, reserved-fund rejection, and concurrent-overdraft protection are implemented. Public
  HTTP exposure is defined by
  [ADR-025 — Simulated Withdrawal HTTP API and Error Contract](../architecture/decisions/ADR-025-simulated-withdrawal-http-api-and-error-contract.md),
  whose strict request, header, parameter, resource, response, and public-error contracts are
  implemented in `@atlas/contracts`. Its PostgreSQL-backed owner-scoped lookup, authenticated create
  and lookup routes, operational control, independent retry-preserving limiter, controller tests,
  real-PostgreSQL HTTP evidence, authenticated Financial web sandbox, and full-stack browser journey
  are implemented.

## Phase 4 entry criteria

- [ADR-026 — Trading Market, Order, and Matching Foundation](../architecture/decisions/ADR-026-trading-market-order-and-matching-foundation.md)
  defines exact lots and ticks, limit-order scope, order lifecycle, price-time priority, maker-price
  execution, self-trade prevention, reservation, atomic settlement, idempotency, and concurrency.
- The first implementation increment is the independently testable market-value, order-lifecycle,
  and deterministic-matching domain core.
- [ADR-027 — MVP Trading Market Catalog and Persistence Strategy](../architecture/decisions/ADR-027-mvp-trading-market-catalog-and-persistence-strategy.md)
  defines the initial BTC-USD and ETH-USD catalog, exact settlement-compatible increments, Trading
  schema ownership, durable lifecycle constraints, immutable executions, indexes, idempotency, and
  locking protocol.
- [ADR-028 — Financial Reservation, Release, and Trade Settlement Capabilities](../architecture/decisions/ADR-028-financial-reservation-release-and-trade-settlement-capabilities.md)
  defines the complete-placement Financial plan, transaction-bound module capability, reservation
  resource and movement history, exact journal shapes, price-improvement calculation, release
  behavior, idempotency, and deterministic cross-market account locking.
- [ADR-029 — Public Trading HTTP API and Read Contract](../architecture/decisions/ADR-029-public-trading-http-api-and-read-contract.md)
  defines the public market catalog, authenticated placement and cancellation commands,
  owner-scoped order and trade reads, canonical decimal representations, bounded pagination,
  transport idempotency, security controls, cache policy, rate limits, and public error taxonomy.
- Trading persistence, Financial reservation persistence, and atomic placement and cancellation
  orchestration are implemented. ADR-029 accepts the public transport and owner-read contract.
- Public cached market routes, authenticated owner-scoped order/trade reads, and authenticated
  placement and cancellation commands are implemented. Contract-validating browser API functions
  and authenticated Trading query/mutation state are implemented. The responsive Trading desk
  composes market selection, exact market rules, limit-order entry, order cancellation, cursor-based
  private history, retry guidance, and safe state transitions from that foundation. Market Data
  projections remain separately gated and do not enter the matching authority implicitly.

## Phase 4 delivery state

- Exact market-code, lot, price-tick, quantity, and quote-notional primitives are implemented using
  Financial's public asset and atomic-value boundaries without floating-point arithmetic or hidden
  settlement rounding.
- Immutable order snapshots enforce the accepted open, partially filled, filled, and cancelled
  lifecycle while preserving original intent, residual quantity, terminal reason, and version.
- The database-independent matcher implements crossing rules, maker-price execution, best-price then
  acceptance-priority ordering, deterministic ID tie-breaking, partial fills, and cancel-taker
  self-trade prevention without mutating caller state.
- Focused domain tests cover exact conversion, bounds, overflow, lifecycle transitions, price-time
  ordering, buy and sell execution roles, terminal behavior, market isolation, and self-trade cases.
- ADR-027 accepts the initial BTC-USD and ETH-USD market catalog and the durable markets, orders,
  trades, priority, lifecycle, idempotency, indexing, immutability, and per-market locking model.
- ADR-028 accepts the transaction-bound Trading funds capability, complete placement-effect plan,
  Financial-owned reservation resource and movement history, one settlement journal per trade,
  exact price-improvement posting, residual release, and deterministic account-lock protocol.
- Committed migrations provision the exact BTC-USD and ETH-USD catalog, durable markets, monotonic
  orders, append-only trades, matching indexes, Financial-owned reservations, and immutable
  reservation movements. Deferred PostgreSQL constraints reconcile market state, order and trade
  roles, reservation lifecycles, and exact reservation, release, and settlement journal shapes.
- Kysely schema ownership and runtime compatibility advance through schema version 9. Focused
  real-PostgreSQL evidence covers catalog exactness, lifecycle constraints, matching order, market
  state, trade roles, reservation reconciliation, residual release, and price-improved settlement.
- The transaction-bound Financial capability, Trading repositories, and composite unit of work are
  implemented. Place-order orchestration now performs exact validation, durable retry resolution,
  deterministic matching, trade persistence, and Financial reservation and settlement in one
  transaction. Cancellation now locks market before order, releases the exact Financial residual,
  supports identical retries, and serializes correctly against concurrent matching. Public Trading
  transport is accepted by ADR-029. Shared Trading contracts now enforce strict market, placement,
  order, cancellation, trade-history, pagination, and public-error shapes; canonical decimals;
  coherent lifecycle and quantity state; deterministic collection ordering; and omission of owner,
  counterparty, reservation, settlement, and persistence internals. Authoritative PostgreSQL market,
  owner-order, and owner-trade readers now reconstruct exact public decimals and enforce owner-safe,
  filter-bound keyset pagination across concurrent inserts without exposing matching priority or
  execution sequence. Public cached market catalog routes and authenticated no-store order and trade
  routes now enforce strict path, query, and GET-body validation, derive ownership exclusively from
  trusted authentication context, preserve identical missing and cross-owner order responses, and
  emit only the accepted shared contracts. Placement and cancellation routes now enforce exact
  origin and session-bound CSRF, JSON and idempotency contracts, owner derivation, retry-preserving
  independent rate limits, stable public failure mapping, and authoritative post-commit resource
  projection. Real-PostgreSQL HTTP evidence covers placement replay, maker-price matching, exact
  four-wallet settlement, idempotency conflict, reservation, cancellation replay, exact release,
  cross-owner concealment, and non-cancellable terminal orders. The web client now validates every
  Trading command, filter, path parameter, and response against shared contracts before crossing
  the React boundary. Authenticated workspace state owns market selection, private order/trade
  loading, bounded cursor pagination with duplicate suppression, mutation serialization,
  ambiguous-outcome idempotency reuse, and authoritative refresh after placement and cancellation;
  logout clears all private Trading state. Focused frontend tests cover request construction,
  response rejection, authentication transitions, pagination, retries, invalidation, and command
  coalescing. The responsive visual workspace now provides a compact exchange-style market rail,
  buy/sell limit-order ticket, open-order cancellation, execution tabs, loading/error/empty states,
  and mobile reflow. It deliberately labels simulated execution and the Phase 5 price-feed boundary
  instead of fabricating live prices, charts, spreads, or depth. Component tests exercise anonymous
  privacy gates, server-confirmed placement, ambiguous-outcome retry, activity switching, and
  cancellation. Market Data projections remain separately gated.
- The isolated two-user browser journey proves registration and captured-email verification,
  wallet provisioning and funding, maker-price matching, taker/maker execution visibility, exact
  four-wallet settlement, residual cancellation and release, and persisted balances through the
  real web, API, PostgreSQL, and Mailpit stack.

## Phase transition rule

Do not begin a later phase merely because folders can be scaffolded. Begin it when the preceding
phase passes its automated checks and its business rules, API contract, data design, and acceptance
criteria have been reviewed.
