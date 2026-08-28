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
| 4. Trading                | Orders, reservation, matching, trades, atomic settlement         | Implemented |
| 5. Market data            | Order-book views, tickers, candles, WebSocket streams            | Implemented |
| 6. Product surfaces       | Portfolio, notifications, administration                         | In progress |
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
- Kysely schema ownership and runtime compatibility advance through schema version 10. Focused
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

## Phase 4 acceptance criteria

- Exact market values, order lifecycle, price-time matching, maker-price execution, and cancel-taker
  self-trade prevention are enforced independently of transport and process memory.
- Order placement, reservation, matching, trades, four-wallet settlement, price-improvement release,
  and command idempotency commit or roll back atomically.
- Cancellation releases the exact residual reservation and remains safe across retries, ownership
  boundaries, terminal states, and concurrent matching.
- Shared contracts and the public HTTP surface enforce canonical decimals, trusted ownership, CSRF,
  idempotency, rate limits, safe errors, bounded pagination, and public/private data separation.
- The responsive Trading workspace provides market selection, exact limit-order entry, open-order
  cancellation, execution history, retry guidance, and honest Market Data deferral.
- Domain, contract, real-PostgreSQL integration, HTTP, component, and isolated browser tests prove
  matching priority, concurrency, rollback, settlement, ownership, retry, persistence, and the
  complete two-user Trading lifecycle.
- `pnpm verify`, `pnpm build`, and `pnpm test:e2e` pass at the phase boundary.

## Phase 5 entry criteria

- [ADR-030 — Market Data Projection and Sequencing Foundation](../architecture/decisions/ADR-030-market-data-projection-and-sequencing-foundation.md)
  defines the rebuildable projection boundary, durable committed Trading facts, per-market sequence,
  idempotent checkpoints, initial book/ticker/candle concepts, freshness semantics, recovery, and
  deterministic testing requirements.
- [ADR-031 — Trading Market Data Fact Persistence and Publication Contract](../architecture/decisions/ADR-031-trading-market-data-fact-persistence-and-publication-contract.md)
  defines the per-market sequence rows, immutable version-one fact envelopes, minimal private-safe
  order/trade payloads, final-state publication rules, retry and rollback behavior, and bounded
  ascending Trading fact reader.
- The first implementation increment is the independently testable versioned Trading fact contract,
  per-market publication sequence, durable fact persistence, and Market Data checkpoint boundary.
- Public REST snapshots and WebSocket delivery remain gated by focused contracts.

## Phase 5 delivery state

- Migration 0010 advances schema compatibility and provisions Trading-owned per-market publication
  sequences plus immutable, versioned Market Data facts with exact payload, privacy, uniqueness, and
  lifecycle constraints.
- Successful placement and cancellation commands allocate contiguous market sequences and publish
  only final changed-order states and immutable executions inside the authoritative transaction.
  Failed commands roll publication back, while identical retries append nothing.
- Trading exposes a bounded ascending fact reader through its public interface. Strict runtime
  parsing rejects unknown versions, malformed canonical values, lifecycle contradictions, and extra
  fields before facts can cross into Market Data.
- Unit and real-PostgreSQL integration tests cover payload versions, privacy, immutability, rollback,
  retry idempotency, maker-price execution ordering, self-trade prevention, cancellation, and paged
  sequence reads.
- [ADR-032 — Market Data Checkpoint and Level-Two Projection Persistence](../architecture/decisions/ADR-032-market-data-checkpoint-and-level-two-projection-persistence.md)
  defines the generation-aware Market Data schema, private projected-order state, exact aggregate
  levels, atomic checkpoint protocol, single-writer lock, replay behavior, and gap failure contract.
- Migration 0011 advances schema compatibility to version 11 and provisions one active level-two
  generation plus Market Data-owned checkpoints, active projected orders, and aggregate book levels.
  Projection rows deliberately contain no owner, priority, reservation, idempotency, or settlement
  fields and do not query Trading tables.
- The application projector consumes Trading's public fact reader in bounded batches. Competing
  projectors serialize per market, already applied sequences are harmless, the next sequence is
  mandatory, order replacement updates exact lots and counts, terminal states remove liquidity,
  trades advance freshness without changing book depth, and projection writes commit with the
  durable checkpoint or roll back together.
- Database-independent and real-PostgreSQL tests cover exact same-price aggregation, partial-fill
  replacement, cancellation and fill removal, deterministic bid/ask ordering, trade-only checkpoint
  advancement, restart, replay idempotency, concurrent projectors, sequence gaps, transaction
  rollback, generation uniqueness, and positive-value constraints.
- [ADR-033 — Market Data Projection Worker Lifecycle and Lag Observability](../architecture/decisions/ADR-033-market-data-projection-worker-lifecycle-and-lag-observability.md)
  defines the in-process per-market loops, bounded polling budget, validated configuration,
  independent exponential retry, exact high-watermark lag, structured diagnostics, readiness
  separation, and managed startup/shutdown order.
- The API now discovers the Trading market catalog after database readiness and continuously runs
  the level-two projector for each market. It limits work per cycle, exposes process-local projected
  and published sequences plus lag and failure state, logs failures and recovery without fact
  payloads, and waits for in-flight projection work before closing PostgreSQL.
- Deterministic worker tests cover discovery, immediate projection, exact lag, bounded catch-up,
  retry, recovery, graceful stop, invalid configuration, and lifecycle cleanup. Real-PostgreSQL
  evidence proves automatic consumption of committed facts and later cancellation while the worker
  is running.
- [ADR-034 — Public Level-Two Order-Book HTTP Contract](../architecture/decisions/ADR-034-public-level-two-order-book-http-contract.md)
  defines the anonymous depth-bounded snapshot route, exact decimal and integer-string values,
  point-in-time sequence and lag semantics, short public caching, process-local client limiting,
  strict validation, privacy, and safe errors.
- The composed API now serves top 1–100 bid and ask levels from Market Data's active generation,
  bounds the underlying PostgreSQL reads, converts ticks and lots through the public Trading market
  definition, and distinguishes `current` from `behind` without exposing orders or projection
  internals. Shared-contract, application, limiter, HTTP, and real-PostgreSQL tests prove the public
  boundary.
- The web application now consumes that public contract through a separate Market Data feature. The
  Trading workspace renders responsive depth with exact price, aggregate quantity, order count,
  best bid/ask, sequence time, and honest current/behind state. Non-overlapping two-second polling
  pauses in hidden tabs, ignores late market-switch responses, retains the last valid snapshot on a
  refresh failure, and offers explicit recovery. API, hook, component, anonymous-access, and real
  browser tests cover the boundary from PostgreSQL projection through visible order-book updates.
- [ADR-035 — Trade Ticker Projection Persistence and Window Semantics](../architecture/decisions/ADR-035-trade-ticker-projection-persistence-and-window-semantics.md)
  defines an independent generation and checkpoint, exact durable trade observations, atomic
  replay-safe projection, deterministic equal-time ordering, and inclusive rolling 24-hour window
  semantics.
- Migration 0012 advances schema compatibility to version 12 and provisions the ticker generation
  plus exact trade-observation persistence. The new application projector checkpoints every
  contiguous market fact while storing only committed executions; order facts therefore preserve
  comparable freshness without affecting ticker values. Unit and real-PostgreSQL tests cover exact
  values, mixed-fact checkpointing, restart, replay idempotency, sequence-gap rollback, generation
  uniqueness, and positive-value constraints.
- [ADR-036 — Multi-Projection Worker and Internal Ticker Read Model](../architecture/decisions/ADR-036-multi-projection-worker-and-internal-ticker-read-model.md)
  refines the managed worker behind a generic combined-projector boundary. Level-two and ticker
  execute independently and are both awaited, while overall progress and lag use the slower durable
  checkpoint so caught-up state cannot conceal a stale required view.
- The production worker factory now starts both projections for every discovered market. An internal
  repeatable-read ticker query evaluates the injected-clock interval `[now - 24h, now]`, selects
  equal-time trades by execution sequence, and returns exact high, low, base-volume lots, and
  quote-volume tick-lots without floating-point arithmetic. Unit and real-PostgreSQL tests cover
  sibling failure completion, aggregate failure reporting, inclusive boundaries, exclusions,
  empty windows, exact sums, and actual managed-worker composition.
- [ADR-037 — Public Trade Ticker HTTP Contract](../architecture/decisions/ADR-037-public-trade-ticker-http-contract.md)
  defines the anonymous query-free ticker route, exact public decimals, explicit rolling-window and
  freshness metadata, empty-window representation, shared snapshot caching/rate limiting, privacy,
  safe errors, and deliberate omission of percentage change until its reference rule is accepted.
- The composed API now serves committed-trade last price and quantity, 24-hour high/low, and exact
  base/quote volumes from the active ticker projection. It converts ticks, lots, and tick-lots using
  Trading's authoritative market definition, exposes no execution or projection internals, and
  returns truthful null prices with zero volumes for trade-free windows. Shared-contract,
  application, HTTP, and real-PostgreSQL tests prove the boundary.
- The Trading workspace now presents a responsive rolling ticker above level-two depth. Its
  independent two-second REST loop is non-overlapping, pauses in hidden tabs, ignores late
  market-switch responses, retains the last valid ticker after refresh failure, and exposes manual
  recovery plus exact lag. The panel labels committed trades and base/quote units, shows no price
  when the window is empty, and renders last price/size, high/low, and both volumes without client
  arithmetic. API, hook, component, workspace, and full browser tests cover the public flow.
- [ADR-038 — Candle Projection and Historical Contract](../architecture/decisions/ADR-038-candle-projection-and-historical-contract.md)
  defines six UTC epoch-aligned intervals, exact execution-sequence OHLCV, sparse half-open
  buckets, independently checkpointed atomic projection, bounded cursor history, explicit open
  candles, and initial full retention.
- Migration 0013 advances schema compatibility to version 13 and provisions the independent candle
  generation plus constrained aggregate persistence. The application projector checkpoints every
  contiguous fact and applies each committed trade to all supported intervals without synthesizing
  empty buckets. Shared-contract, database-independent, and real-PostgreSQL tests prove alignment,
  exact volumes, execution-ordered open/close, sparse gaps, replay safety, rollback, concurrency,
  and persistence constraints. Worker composition, the historical reader, and the HTTP route remain
  the next delivery increment.
- [ADR-039 — Managed Candle Projection and Internal History Reader](../architecture/decisions/ADR-039-managed-candle-projection-and-internal-history-reader.md)
  composes candles into the existing all-settled per-market worker and defines overall progress as
  the minimum of book, ticker, and candle checkpoints. One failed view therefore cannot be hidden
  behind faster siblings, while each view retains independent transactions and replay recovery.
- The internal candle use case evaluates one injected clock, validates interval-aligned exclusive
  cursors, caps initial/future queries at the current UTC bucket end, and delegates to a
  repeatable-read PostgreSQL page. A descending `limit + 1` index read proves another page before
  returning exact sparse candles in ascending chart order. Unit and real-PostgreSQL tests cover
  limits, clocks, identity drift, current/open bounds, exact values, terminal and continuing pages,
  coherent checkpoints, worker factory composition, and truthful caught-up status.
- [ADR-040 — Public Candle History HTTP Delivery](../architecture/decisions/ADR-040-public-candle-history-http-delivery.md)
  exposes the accepted anonymous candle route with exact market conversion, point-in-time
  publication lag, open/closed state, sparse ascending pages, exclusive aligned cursors, shared
  snapshot caching/rate limiting, privacy, and safe errors.
- The composed API now serves 1-minute through 1-day history from the active candle generation. It
  validates malformed requests before limiter admission, converts ticks/lots/tick-lots without
  floating point, carries truthful checkpoint freshness, and supports stable backward pagination.
  Application, HTTP, shared-contract, and real-PostgreSQL tests cover exact decimals, open/closed
  buckets, sparse pages, cursors, unknown markets, invalid input, cache headers, limiting, and
  internal-invariant containment.
- [ADR-041 — Candlestick Chart and Polling Delivery](../architecture/decisions/ADR-041-candlestick-chart-and-polling-delivery.md)
  defines the dependency-free SVG chart, actual-time sparse geometry, display-only numeric
  conversion boundary, six interval controls, five-second bounded REST loop, selection isolation,
  stale retention, freshness states, accessibility, and responsive behavior.
- The Trading workspace now renders exact latest OHLCV values plus responsive candlesticks and volume
  from committed Atlas executions. Missing buckets remain visible as time gaps, open candles use a
  distinct dashed body, and empty history remains explicitly empty. Independent polling pauses in
  hidden tabs, prevents overlap, ignores late market/interval responses, and preserves matching stale
  history with manual recovery. API, hook, model, component, workspace, and full-stack browser tests
  cover validation, polling lifecycle, sparse positioning, open state, interval switching, freshness,
  anonymous access, and real projected history.
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](../architecture/decisions/ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
  defines the anonymous origin-restricted upgrade, strict version-one subscription protocol, full
  replacement recovery model, grouped unique-channel refresh, bounded connection and message limits,
  heartbeat/pong detection, backpressure, safe errors, and upgraded-socket shutdown order.
- The API now serves order-book, ticker, and candle subscriptions through one WebSocket endpoint.
  A subscription receives an acknowledgement plus an exact initial snapshot, identical channels
  share one refresh read before fan-out, malformed clients are bounded, and reconnect requires no
  retained server session because every snapshot is complete. Shared-contract and real-socket tests
  cover protocol validation, negotiation, snapshots, fan-out, limits, origin isolation, heartbeat,
  and graceful shutdown.
- [ADR-043 — Browser Market Data Streaming and Recovery](../architecture/decisions/ADR-043-browser-market-data-streaming-and-recovery.md)
  defines one workspace-owned connection, welcome-gated multiplexed subscriptions, strict routing,
  monotonic replacement, last-valid stale retention, bounded reconnect, heartbeat timeout,
  hidden-tab suspension, explicit retry, and Strict Mode-safe ownership.
- The Trading workspace now uses one live stream for depth, ticker, and candles and has no implicit
  production REST-polling fallback. Market and interval changes replace subscriptions without late
  callback leakage. The isolated browser journey proves all three topics share a socket, hidden-tab
  suspension retains the last snapshot, and visibility restoration creates a new socket that
  resubscribes and recovers all views.

## Phase 5 acceptance criteria

- Market Data is rebuildable from immutable private-safe Trading facts and cannot influence matching,
  reservation, settlement, or ledger authority.
- Level-two, rolling ticker, and sparse UTC candle projections advance independently with durable
  sequence checkpoints, replay safety, gap detection, exact arithmetic, and observable lag.
- Anonymous REST snapshots expose bounded exact public representations with strict validation,
  privacy, caching, rate limiting, and safe errors.
- The public WebSocket protocol provides strict versioning, origin and subprotocol enforcement,
  bounded subscriptions and payloads, grouped snapshot fan-out, heartbeat/backpressure handling,
  deterministic full-snapshot recovery, and graceful process shutdown.
- The responsive Trading workspace renders exact depth, ticker, candles, open-bucket state, sparse
  time gaps, freshness, stale retention, and explicit recovery through one resilient connection.
- Unit, contract, real-PostgreSQL integration, real-socket API, component, workspace, and isolated
  browser tests prove projection, public delivery, multiplexing, reconnect, privacy, and lifecycle
  behavior.
- `pnpm verify`, `pnpm build`, and `pnpm test:e2e` pass at the phase boundary.

## Phase 6 entry criteria

- The completed Financial, Trading, and Market Data phases expose the public module capabilities
  required to compose a portfolio without querying another module's tables.
- [ADR-044 — Portfolio Snapshot and Valuation Foundation](../architecture/decisions/ADR-044-portfolio-snapshot-and-valuation-foundation.md)
  defines Financial balance authority, direct USD committed-trade valuation, exact derived
  arithmetic, positive unpriced positions, zero-position treatment, deterministic completeness, and
  the initial exclusion of profit/loss and external prices.
- Authenticated HTTP delivery and browser presentation remain gated by focused follow-up decisions.

## Phase 6 delivery state

- A new read-only Portfolio application capability composes owner-scoped wallet balances, the asset
  catalog, eligible direct Trading markets, and committed-trade tickers exclusively through public
  module interfaces. It adds no balance authority, persistence, migration, or framework dependency.
- Exact integer-coefficient decimal multiplication and scale-aligned addition preserve derived
  precision without binary floating point or implicit USD-ledger rounding.
- Strict shared contracts reconcile sorted positions, available/reserved/total balances, direct
  valuation markets, exact totals, zero positions, unpriced assets, and completeness. Focused
  contract and application tests cover complete, incomplete, zero, precision, and upstream-invariant
  behavior.
- [ADR-045 — Authenticated Portfolio HTTP Contract](../architecture/decisions/ADR-045-authenticated-portfolio-http-contract.md)
  defines the query-free owner-derived route, strict success and safe-error representations,
  private no-store caching, per-owner limiting, incomplete-snapshot success semantics, public module
  composition, and explicit non-atomic source-read boundary.
- The composed API now serves `GET /api/v1/portfolio` from authenticated session ownership. Reusable
  Financial, Trading, and Market Data query factories preserve module boundaries, while a bounded
  process-local limiter hashes owner keys and returns `Retry-After`. HTTP unit tests cover
  authentication, validation order, privacy, limiting, response containment, and caching; a
  real-PostgreSQL integration test proves exact committed-price valuation and cross-owner isolation.
- [ADR-046 — Browser Portfolio Snapshot Experience](../architecture/decisions/ADR-046-browser-portfolio-snapshot-experience.md)
  defines server-owned presentation, complete-versus-subtotal language, exact string formatting,
  authenticated lifecycle isolation, explicit refresh, last-valid stale retention, responsive
  structure, and the deliberate omission of ungrounded performance analytics.
- The overview now presents a responsive authenticated Portfolio before the Trading desk. It renders
  exact available, reserved, and total balances; committed-price references and timestamps; exact
  USD values; truthful zero and unpriced states; excluded assets; and a server-owned complete total
  or incomplete subtotal. It does no browser valuation arithmetic, never loads for anonymous users,
  resets on user change, and retains a visibly stale last-valid snapshot after refresh failure.
  Strict API parsing, focused component state tests, app-composition coverage, and isolated browser
  journeys prove complete and incomplete snapshots through the real stack.
- [ADR-047 — Durable Notification Inbox and Event-Capture Foundation](../architecture/decisions/ADR-047-durable-notification-inbox-and-event-capture-foundation.md)
  defines an owner-scoped in-app inbox, typed versioned source facts, atomic transaction-bound
  capture, tuple idempotency, immutable content, monotonic read receipts, and the initial exclusion
  of external and realtime delivery.
- Migration 0014 advances schema compatibility to version 14 and provisions the Notifications inbox,
  owner timeline index, exact Financial completion payload constraints, source uniqueness, and
  separate immutable read receipts. The Notifications domain and PostgreSQL writer reject invalid
  facts and changed retries, return existing records for identical retries, isolate identical source
  IDs across owners, serialize concurrency, and roll back with the caller transaction. Financial
  source integration and public delivery remain the next increments.
- [ADR-048 — Atomic Financial Notification Capture](../architecture/decisions/ADR-048-atomic-financial-notification-capture.md)
  defines completed-only emission, persisted-record payload authority, same-transaction failure
  semantics, Financial-owned port direction, retry deduplication, and the explicit no-backfill
  rollout boundary.
- New simulated deposits and withdrawals now capture exact typed notification facts inside their
  existing wallet, journal, and balance transaction. The composition root binds Notifications'
  implementation to Financial's narrow application port without exposing Notifications SQL or
  records to Financial. Unit tests prove exact mapping and no retry emission; real-PostgreSQL tests
  prove exact persisted facts, one notification across retries, concurrent source idempotency, and
  complete source rollback when capture fails. The composed authenticated Financial HTTP lifecycle
  proves both kinds are captured from real commands.

## Phase transition rule

Do not begin a later phase merely because folders can be scaffolded. Begin it when the preceding
phase passes its automated checks and its business rules, API contract, data design, and acceptance
criteria have been reviewed.
