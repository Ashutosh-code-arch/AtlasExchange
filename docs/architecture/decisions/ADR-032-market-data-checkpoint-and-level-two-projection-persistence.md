# ADR-032 — Market Data Checkpoint and Level-Two Projection Persistence

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-032

## Context

ADR-030 establishes Market Data as a rebuildable asynchronous projection, and ADR-031 implements
the immutable, private-safe Trading fact stream that feeds it. Atlas now needs the first
Market Data-owned persistence boundary: a deterministic level-two order book that can restart from
a durable checkpoint, tolerate at-least-once delivery, and stop rather than invent state when a
sequence is missing.

This decision does not expose a public snapshot or start a background worker. It defines and
implements the projection behavior those later adapters will use.

## Decision Drivers

The first projection should:

1. depend only on Trading's public fact-reader interface;
2. aggregate exact integer lots and ticks without floating-point arithmetic;
3. replace prior order state safely across partial fills and terminal transitions;
4. apply a fact and advance its checkpoint in one database transaction;
5. make replay harmless and reject sequence gaps explicitly;
6. serialize competing projectors without a separate coordination service;
7. preserve a generation boundary for later rebuilds;
8. omit private Trading, Identity, and Financial information;
9. expose deterministic best-price ordering to later application adapters;
10. remain independently testable before polling and public delivery are introduced.

# Decision

Atlas will persist the initial Market Data level-two projection under a dedicated `market_data`
schema in migration 0011.

~~~text
TradingPublicationFactReader
             │ bounded ascending facts
             ↓
ProjectLevelTwoOrderBook
├── lock active generation + market
├── validate contiguous sequence
├── replace private active-order state
├── update exact aggregate price levels
└── advance checkpoint in the same transaction
             ↓
LevelTwoOrderBookReader
~~~

## 1. Generation-aware ownership

`market_data.projection_generations` identifies rebuildable generations of the
`level_two_order_book` projection. Exactly one generation may be active. Additional building and
retired generations are structurally possible so a later rebuild workflow does not need to mix new
rows irreversibly into the readable generation.

The initial migration provisions one active generation. Activation orchestration and online
generation switching remain deferred. Projection rows are disposable derived state and never become
Trading authority.

Market Data owns all tables in its schema. It copies the market code supplied by a validated Trading
fact but does not query Trading tables or import Trading repositories.

## 2. Durable per-market checkpoint

`market_data.projection_checkpoints` stores the last completely applied market sequence and the
occurrence time of that fact for each generation and market. A checkpoint begins logically at
sequence zero with no occurrence time and is created lazily inside the first projection transaction.

The checkpoint means every supported fact for that market through the stored sequence has been
applied to the same generation. It advances only after all derived writes for the batch succeed.
Rollback removes both writes and checkpoint movement.

## 3. Private active-order state

`market_data.level_two_projected_orders` stores only active order state required to replace a
previous contribution:

- generation and market;
- internal order identifier;
- side and exact price ticks;
- exact positive remaining lots;
- last applied sequence and occurrence timestamp.

Open and partially filled facts create or replace this row. Filled, owner-cancelled, and
self-trade-prevention-cancelled facts remove it after subtracting its prior contribution. The table
does not contain owner identity, priority, original quantity, idempotency, reservation, account,
journal, settlement, or counterparty fields.

## 4. Exact aggregate levels

`market_data.level_two_order_book_levels` stores one row per generation, market, side, and exact
price. Each row contains positive aggregate remaining lots and a positive order count.

When an order-state fact arrives, the projector first subtracts any prior active contribution and
then adds the final active contribution, if one exists. Quantity and order count must become empty
together; an empty level is deleted. Negative or internally inconsistent aggregates are invariant
failures.

Trade facts do not change depth because their corresponding final order-state facts already describe
remaining liquidity. They still advance the checkpoint and `asOf` value so a snapshot sequence
covers the complete Trading fact stream.

The snapshot reader returns bids in descending price and asks in ascending price. It never exposes
the private projected-order rows.

## 5. Batch, replay, and gap protocol

The application projector observes its current checkpoint, requests a positive bounded page from
Trading, and applies that page inside a Market Data transaction. The initial default page size is 250
and the maximum is 1,000, matching the Trading reader boundary.

Inside the transaction:

1. a PostgreSQL transaction-scoped advisory lock serializes the projection name and market;
2. the active generation is locked against concurrent activation changes;
3. the checkpoint row is created if absent and locked;
4. facts at or below the durable sequence are skipped as already applied;
5. every new fact must equal the preceding sequence plus one;
6. order or trade projection behavior is applied;
7. one compare-and-set checkpoint update records the final sequence and occurrence time;
8. all work commits or rolls back together.

A fact from another market, a missing sequence, or an impossible aggregate stops the batch. The
projector does not skip forward, synthesize a fact, edit Trading history, or partially advance its
checkpoint. Unsupported versions and malformed fact payloads remain rejected by Trading's public
reader before entering Market Data.

At-least-once delivery is therefore safe: replayed facts at or below the locked checkpoint produce
no additional aggregate effect. Concurrent projectors may read the same page, but only one applies
it; the follower observes the advanced checkpoint and skips the duplicate sequences.

## 6. Failure and freshness boundary

Projection failure does not roll back an already committed Trading command. It leaves the previous
Market Data generation and checkpoint readable and stops progress for the affected market until the
cause is corrected or the projection is rebuilt.

This slice provides sequence and authoritative `asOf` state. It does not yet define maximum lag,
readiness impact, structured worker retry, public stale-state behavior, or operational alerts.

## 7. Deterministic evidence

Database-independent tests cover exact aggregation, replacement, terminal removal, trade-only
checkpoint movement, replay, market isolation, batch validation, and gap rollback. Real-PostgreSQL
tests cover migration constraints, one-active-generation enforcement, transaction rollback,
advisory-lock serialization, concurrent replay, restart from checkpoint, and deterministic bid/ask
ordering.

# Alternatives Considered

## Recompute the book from Trading orders on every read

Rejected because it violates module ownership and couples public read cost and availability to the
command model.

## Store only aggregate levels

Rejected because a later order-state fact could not safely subtract an order's previous price and
quantity contribution.

## Store every historical projected order

Rejected initially because terminal history is already retained in immutable Trading facts. The
private projection needs only current active contributions.

## Advance checkpoints separately from projection writes

Rejected because a crash could either duplicate an aggregate mutation or skip unapplied facts.

## Use an in-memory mutex

Rejected because it cannot coordinate multiple processes and disappears on restart. A PostgreSQL
transaction-scoped advisory lock fits the existing deployment without new infrastructure.

# Consequences

## Positive Consequences

- Level-two state is exact, deterministic, restartable, and independent of command tables.
- Replay and competing projectors cannot double-count liquidity.
- Gaps fail closed without corrupting later state.
- Generation identity preserves a path to safe rebuilds.
- Public snapshots can later read bounded aggregate rows without leaking order ownership.

## Negative Consequences

- Every order change requires private-order and aggregate-level persistence work.
- A hot market has one serialized projector transaction at a time.
- PostgreSQL advisory-lock identity must remain stable across projector versions.
- Generation activation and cleanup require a later operational workflow.
- Market Data remains eventually consistent and is not yet updated by a running worker.

# Deferred Decisions

This ADR does not decide:

1. projector polling, retry/backoff, lifecycle shutdown, and observability configuration;
2. offline or online rebuild commands and generation activation protocol;
3. public level-two REST schema, depth limits, caching, freshness, or errors;
4. ticker and candle projection persistence;
5. WebSocket snapshot/delta delivery and recovery;
6. fact retention, archival, or compaction.

# Reconsider When

Review this decision when PostgreSQL projection throughput becomes a measured bottleneck, multiple
projection algorithms require independent checkpoints, online rebuild availability becomes
necessary, or Market Data moves to a separately deployed service or storage engine.

# Relationship to Other Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-030 — Market Data Projection and Sequencing Foundation](ADR-030-market-data-projection-and-sequencing-foundation.md)
- [ADR-031 — Trading Market Data Fact Persistence and Publication Contract](ADR-031-trading-market-data-fact-persistence-and-publication-contract.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

Migration 0011, the generation-aware projection schema, atomic level-two projector, durable
checkpoint, and private snapshot reader may be implemented. Worker lifecycle and public adapters
remain separately gated.
