# ADR-030 — Market Data Projection and Sequencing Foundation

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-030

## Context

Atlas now has a durable synchronous Trading authority. Orders are accepted and matched under a
per-market lock, trades are immutable, and order, reservation, settlement, and Financial effects
commit atomically. The public Trading API deliberately exposes market reference data and
owner-scoped activity without claiming to provide a live order book, ticker, candles, or stream.

Phase 5 needs those public market views. They are derived information with different ownership,
freshness, caching, recovery, and delivery requirements from command-side Trading. Building them by
querying Trading tables from another module would violate Atlas's module boundaries. Updating them
as a required part of order placement would instead make non-authoritative read models capable of
blocking authoritative trading.

Atlas therefore needs a durable boundary between committed Trading facts and rebuildable Market
Data projections before choosing REST payloads or a WebSocket protocol.

## Decision Drivers

The Market Data foundation should:

1. preserve Trading as the sole authority for orders, matching, and trades;
2. publish no order, execution, or balance state before its transaction commits;
3. preserve exact quantities, prices, notionals, timestamps, and deterministic ordering;
4. recover from process interruption without missing or applying a fact twice;
5. support sequence-aware snapshots and later streaming recovery;
6. keep projection failure from rolling back an accepted Trading command;
7. avoid direct cross-module repository or table access;
8. remain operable in the existing modular monolith and PostgreSQL deployment;
9. produce deterministic tests without external or live market feeds;
10. defer Kafka, separate services, and distributed-stream infrastructure until justified.

# Decision

Atlas will implement Market Data as an **asynchronous, rebuildable projection of committed Trading
facts**. Trading will persist projection facts transactionally with its authoritative changes.
Market Data will consume those facts at least once, apply them idempotently, and publish only state
covered by its durable checkpoint.

~~~text
Trading transaction
├── authoritative order and trade changes
├── atomic Financial settlement
└── immutable projection facts
                 │ commit
                 ↓
Market Data projector
├── consume in sequence
├── update private projection state
└── advance durable checkpoint atomically
                 ↓
Public snapshots and future streams
~~~

## 1. Ownership Boundary

Trading owns:

- market and order authority;
- matching and immutable executions;
- per-market publication sequence allocation;
- the immutable fact records written by Trading transactions;
- the public application interface through which facts are read.

Market Data owns:

- its consumer checkpoints;
- private projected order state needed to maintain aggregates;
- level-two order-book aggregates;
- trade-derived ticker and candle projections;
- snapshot freshness and sequence metadata;
- later public snapshot and streaming adapters.

Market Data must not query or mutate Trading repositories or tables directly. Trading facts are an
explicit public module contract. Market Data cannot place, cancel, match, settle, or reinterpret an
order and cannot become a fallback command authority.

Projection rows are disposable derived state. Deleting and rebuilding them does not delete or
change an order, trade, reservation, journal, or wallet balance.

## 2. Durable Trading Fact Stream

Every Trading transaction that changes public market state writes immutable facts in the same
PostgreSQL transaction as the authoritative changes. A committed fact contains at least:

- immutable fact ID;
- market code;
- monotonically increasing market sequence;
- fact kind and schema version;
- authoritative occurrence timestamp;
- exact payload using integer lots/ticks or canonical decimals;
- creation timestamp.

The initial fact kinds describe:

- the current public state of an order after acceptance, fill, cancellation, or self-trade
  prevention; and
- an immutable trade execution.

Order-state facts may carry an internal order identifier so the projector can replace its prior
state idempotently. Public Market Data must never expose that identifier, owner identity, acceptance
priority, reservation identity, idempotency key, or counterparty relationship.

The market sequence is allocated while Trading holds its existing per-market serialization lock.
It defines publication order independently of wall-clock resolution, process scheduling, or fact
IDs. A transaction may publish several consecutive facts; none become consumable before commit.

The immutable fact stream is initially retained so every Market Data projection can be rebuilt.
Retention or archival may change only after Atlas has a separately proven snapshot-and-recovery
mechanism.

## 3. Delivery and Checkpoint Semantics

The initial projector runs as a lifecycle-managed worker in the API deployment and polls committed
facts through Trading's public fact-reader capability. A separate process or service is not required
for Phase 5.

Delivery is **at least once**. Market Data applies a fact and advances its durable checkpoint in one
database transaction. Reprocessing the same fact or sequence has no additional effect. A projector
must never advance its checkpoint if projection writes fail.

Only one active projector may own a given projection name initially. PostgreSQL advisory locking or
an equivalent database-backed lease prevents concurrent workers from applying the same sequence as
independent leaders. Process shutdown stops intake, permits the current projection transaction to
finish or roll back, and releases worker resources through the existing application lifecycle.

A sequence gap, unsupported schema version, or invalid exact value is a projection failure. The
projector must stop advancing the affected market, report structured diagnostics, and recover or
rebuild; it must not guess the missing state.

## 4. Initial Projection Set

The initial Market Data capability will build three public concepts.

### Level-two order book

The book aggregates currently matchable remaining quantity by market, side, and exact price level.
Each level contains exact aggregate base quantity and an order count. Bids sort by descending price;
asks sort by ascending price. Filled, cancelled, and self-trade-prevention-cancelled residuals do
not contribute.

The projector may maintain a private per-order projection to calculate replacements safely, but the
public book exposes levels rather than individual orders. It does not expose owner identity,
priority, order IDs, or a promise that displayed liquidity will still exist when a command arrives.

### Ticker

Ticker values come only from committed Atlas trades. The initial ticker contains last trade price
and quantity plus exact rolling 24-hour high, low, base volume, and quote volume. If the window has
no trades, price-derived fields are absent and volumes are zero; Atlas must not invent a price from
an order, external exchange, or configured market value.

Window evaluation uses an injected authoritative clock in application code and execution sequence
to break equal-timestamp ties. Percentage-change presentation and its rounding policy require the
public-contract decision.

### Candles

Candles aggregate committed trades into UTC-aligned intervals. Open and close use the first and last
execution sequence in the interval; high and low use exact execution price; base and quote volume
sum exact executed values. An interval with no trades produces no synthetic candle and no forward-
filled price.

The first supported intervals, historical retention, pagination, and treatment of the currently
open candle require a focused public-contract decision.

## 5. Consistency, Freshness, and Sequence

Market Data is eventually consistent with Trading. Successful order placement or cancellation does
not promise that a subsequent Market Data request in another transaction already includes the
change.

Every public snapshot will include at least:

- market code;
- greatest applied market sequence;
- authoritative `asOf` timestamp derived from the latest applied fact;
- projection generation timestamp where useful.

The sequence means “all supported committed facts for this market through this value have been
applied.” It is not an order priority, trade identifier, database offset, or wall-clock timestamp.
Clients may compare sequences from the same market and projection protocol version only.

Freshness objectives, maximum acceptable lag, readiness effects, and public stale-state behavior
must be set before production use. Initially, projector lag is observable but does not make the
command API unready or roll back Trading.

## 6. Snapshot and Rebuild Rules

A rebuild uses an empty generation of Market Data-owned projection tables and replays retained
Trading facts in market-sequence order. The old readable generation remains available until the new
generation reaches a verified checkpoint, after which activation changes atomically.

The initial implementation may use a simpler offline rebuild command while there is no production
availability requirement, but the schema must not make projection rows authoritative or
irreversibly mix generations.

Recovery rules are:

1. resume from the last committed checkpoint after ordinary restart;
2. ignore an already applied sequence idempotently;
3. stop on a gap or incompatible fact schema;
4. rebuild when projection logic changes cannot be migrated safely;
5. never repair projections by changing authoritative Trading history.

## 7. Public and Streaming Boundaries

This ADR does not authorize a public endpoint or WebSocket yet. A follow-up contract must define:

- REST routes, depth limits, candle intervals, time ranges, and response schemas;
- cache controls, rate limits, validation, and error behavior;
- snapshot sequence and freshness semantics;
- WebSocket connection, subscription, heartbeat, backpressure, and shutdown behavior;
- snapshot-plus-delta recovery and gap handling;
- browser state ownership and rendering policy.

Public adapters read only Market Data-owned projections. They do not reconstruct a book from
Trading tables per request.

## 8. Deterministic Testing

Tests use controlled Trading facts and clocks. They must not call a live exchange or depend on the
current market price.

Required evidence includes:

- exact order-level aggregation and removal across partial fills and cancellation;
- deterministic bid, ask, and execution ordering;
- idempotent replay and atomic checkpoint advancement;
- restart from checkpoint and explicit sequence-gap failure;
- exact ticker windows at their time boundaries;
- exact candle OHLCV and UTC bucket boundaries;
- rebuild equivalence with uninterrupted projection;
- omission of private Trading and Identity fields;
- real-PostgreSQL integration for locking, transactions, checkpoints, and rebuild behavior.

# Alternatives Considered

## Query Trading tables directly

Rejected because it violates module ownership, couples public query cost to command tables, and
makes later projection or storage changes difficult.

## Update Market Data synchronously inside every Trading command

Rejected because a disposable read-model failure would block authoritative matching and settlement.
Trading persists only the durable publication fact synchronously.

## Publish only an in-memory event after commit

Rejected because a crash between commit and publication would permanently lose a visible market
change, and restart could not recover deterministically.

## Introduce Kafka or a separate Market Data service immediately

Rejected because PostgreSQL can provide the durability, ordering, checkpoint, and recovery needed
at Atlas's current scale without another deployed system.

## Treat an external exchange as the price authority

Rejected because Atlas's order book and executions must describe Atlas liquidity and Atlas trades.
External reference pricing, if introduced, is a different data product with explicit provenance.

# Consequences

## Positive Consequences

- Trading remains authoritative and independent of projection availability.
- Committed facts cannot be lost between transaction commit and projection delivery.
- Sequence-aware snapshots create a sound recovery foundation for WebSockets.
- Projection logic can be replayed and tested deterministically.
- Exact values and the absence of synthetic prices preserve truthful exchange semantics.
- PostgreSQL and the modular monolith remain sufficient for the initial implementation.

## Negative Consequences

- Public Market Data is eventually rather than immediately consistent.
- Trading must persist a versioned publication contract and sequence.
- The worker needs checkpoint, leadership, lag, failure, and rebuild operations.
- Retaining facts and private projected order state consumes additional storage.
- Ticker windows and open candles change with time and require deliberate cache behavior.
- A later separate service will need a compatible transport for the existing fact contract.

# Deferred Decisions

This ADR does not decide:

1. concrete PostgreSQL table and index design;
2. public REST schemas, routes, caching, rate limits, and error taxonomy;
3. supported book depths, candle intervals, retention, and historical pagination;
4. WebSocket protocol, authentication, subscriptions, deltas, and backpressure;
5. exact freshness service objectives and alert thresholds;
6. worker polling interval, batch size, lease mechanism, and shutdown timeout;
7. percentage-change precision and presentation;
8. external reference data, index prices, mark prices, or provider reconciliation;
9. cross-region delivery, Kafka, separate services, or dedicated analytical storage.

# Reconsider When

Review this decision when PostgreSQL polling or retained facts become a measured bottleneck, Market
Data requires independent scaling or availability, multiple regions need ordered dissemination,
projection lag exceeds accepted objectives, retention cost becomes material, or an external data
product enters scope.

# Relationship to Other Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [ADR-027 — MVP Trading Market Catalog and Persistence Strategy](ADR-027-mvp-trading-market-catalog-and-persistence-strategy.md)
- [ADR-029 — Public Trading HTTP API and Read Contract](ADR-029-public-trading-http-api-and-read-contract.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

Implementation may begin with the versioned Trading fact contract, per-market sequence, durable fact
persistence, and idempotent Market Data checkpoint boundary. Public snapshots and WebSocket
delivery remain gated by focused follow-up decisions.
