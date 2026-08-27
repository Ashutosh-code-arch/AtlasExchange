# ADR-031 — Trading Market Data Fact Persistence and Publication Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-031

## Context

ADR-030 establishes Market Data as an asynchronous rebuildable projection of committed Trading
facts. It requires versioned payloads, per-market ordering, at-least-once delivery, privacy, and an
explicit Trading public interface, while deferring the concrete persistence contract.

The first implementation must publish enough information to maintain a level-two book and
trade-derived projections without exposing owner or command internals. Publication must be atomic
with placement, matching, settlement, and cancellation, but it must describe final command state
rather than every intermediate in-transaction mutation.

## Decision Drivers

The persistence contract should:

1. allocate gap-free order only for committed facts within each market;
2. publish an unmatched, matched, self-trade-prevented, or cancelled order exactly once per command;
3. avoid transient book liquidity from intermediate matching states;
4. publish every immutable trade required for tickers and candles;
5. omit owners, idempotency values, priority, reservations, and Financial internals;
6. support bounded ascending reads after a durable checkpoint;
7. reject unknown versions and malformed payloads at the module boundary;
8. remain atomic under rollback and safe under command retry;
9. use the existing PostgreSQL transaction and market lock.

# Decision

Trading will persist publication sequence state and immutable Market Data facts under the `trading`
schema in migration 0010.

~~~text
trading.market_publication_sequences
└── one last_sequence value per market

trading.market_data_facts
├── UUIDv7 fact identity
├── market code + unique positive market sequence
├── fact kind + schema version
├── strict JSONB payload
├── authoritative occurrence time
└── persistence time
~~~

## 1. Per-market sequence allocation

Every provisioned market owns one `market_publication_sequences` row beginning at zero. A database
trigger provisions the row for future markets. The Trading command already locks its market before
changing public state; publication increments that market's sequence row by the exact fact count and
uses the returned range for one contiguous insert.

The sequence is independent for each market. It is not backed by a global PostgreSQL sequence,
because consumers recover and detect gaps per market. Rolled-back transactions consume no visible
sequence values because allocation is a transactional row update.

## 2. Version-one fact envelope

Every fact contains:

- `id` — generated UUIDv7;
- `marketCode` — the owning market;
- `marketSequence` — positive and unique within that market;
- `kind` — `order_state` or `trade_executed`;
- `schemaVersion` — exactly `1` initially;
- `payload` — the kind-specific exact JSON object;
- `occurredAt` — authoritative order update or execution time;
- `createdAt` — fact persistence time.

Facts cannot be updated or deleted. The schema rejects unsupported versions, unknown kinds,
non-object payloads, non-canonical integer strings, invalid lifecycle combinations, and explicitly
forbidden private keys. The typed reader performs strict runtime parsing as a second boundary and
rejects extra fields.

## 3. Order-state payload

Version-one `order_state` contains only:

- internal order ID used by the projector to replace prior state;
- side;
- exact positive limit-price ticks;
- exact non-negative remaining lots;
- final order status;
- nullable terminal reason.

Active states require positive remaining lots and no terminal reason. Filled requires zero remaining
lots and no terminal reason. Cancelled requires positive residual lots and an accepted cancellation
reason.

The payload deliberately omits original quantity, filled quantity, owner, priority, idempotency key,
intent hash, reservation, accounts, wallets, journals, and counterparties. A level-two projector
needs only the current remaining quantity at the order's side and price.

## 4. Trade-executed payload

Version-one `trade_executed` contains only:

- internal trade ID;
- exact positive execution quantity lots;
- exact positive execution price ticks;
- immutable positive Trading execution sequence.

The envelope supplies market and occurrence time. Maker, taker, buyer, seller, owners, orders,
settlement, and Financial identifiers are not required for public aggregate Market Data and remain
private.

## 5. Command publication rules

Publication occurs after authoritative Trading and Financial effects have succeeded but before the
shared database transaction commits.

For placement:

1. persist and settle the command as accepted by ADR-026 and ADR-028;
2. reconstruct the final persisted state of every changed maker and the incoming order;
3. order final order states by immutable acceptance priority;
4. order new trades by immutable execution sequence;
5. allocate one contiguous market-sequence range;
6. append final order-state facts followed by trade-executed facts.

An incoming order that fills synchronously publishes only its final filled state. It never publishes
an intermediate open state that could appear as resting liquidity. An unmatched order publishes its
final open state. Self-trade prevention publishes the final cancelled state.

For owner cancellation, Trading publishes the final cancelled state only after the exact Financial
release succeeds. Identical placement or cancellation retries return committed results without
appending duplicate facts. Any command rollback removes its sequence allocation and facts with the
rest of the transaction.

## 6. Trading public reader

Trading exposes a `TradingPublicationFactReader` through its public module entry point. It accepts:

- one validated market code;
- a non-negative exclusive `afterSequence` boundary;
- a positive bounded limit no greater than 1,000.

It returns facts ordered by ascending market sequence and strictly validates schema version and
payload before crossing the module boundary. Market Data will depend on this interface rather than
Trading tables or repositories.

# Alternatives Considered

## Publish from order and trade table triggers

Rejected because triggers observe intermediate per-row mutations and do not know which order states
are final for the complete business command.

## Publish the accepted incoming state before matching

Rejected because a synchronously filled taker would momentarily appear as resting liquidity during
replay or streaming.

## Use one global publication sequence

Rejected because unrelated market activity would couple recovery, contention, and gap detection
across books.

## Include owners and full order/trade records

Rejected because projection convenience does not justify expanding the cross-module privacy or data
contract.

## Use PostgreSQL notifications as the durable contract

Rejected because notifications are not a retained replay source and may be lost across disconnects.
They may later act only as a wake-up optimization over durable facts.

# Consequences

## Positive Consequences

- Projection input is atomic with Trading and Financial authority.
- Rollback and retry cannot create missing sequence ranges or duplicate facts.
- Final-state publication avoids transient false liquidity.
- Per-market ascending reads support deterministic replay and checkpoint recovery.
- Strict minimal payloads protect private command and ownership state.
- The retained fact stream supports future projector rebuilds without direct table access.

## Negative Consequences

- Trading commands perform extra sequence and fact writes before commit.
- JSONB requires both database constraints and runtime schema validation.
- Version-one payload evolution must remain backward compatible or introduce a new version.
- Projectors still observe eventual consistency after command commit.
- Permanent retention will eventually require an archival and snapshot policy.

# Deferred Decisions

This ADR does not decide:

1. Market Data projection and checkpoint table schemas;
2. worker leadership, polling batch, retry, and lifecycle configuration;
3. book-level, ticker, or candle persistence details;
4. public REST and WebSocket contracts;
5. fact archival, retention, compaction, or notification wake-ups;
6. transaction-batch metadata for atomic multi-fact streaming presentation.

# Reconsider When

Review this decision when fact-write overhead becomes material, a separate Trading service requires
an external transport, consumers require atomic batch metadata, retained history becomes too large,
or multiple writers can no longer share the PostgreSQL market lock and sequence row.

# Relationship to Other Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [ADR-028 — Financial Reservation, Release, and Trade Settlement Capabilities](ADR-028-financial-reservation-release-and-trade-settlement-capabilities.md)
- [ADR-030 — Market Data Projection and Sequencing Foundation](ADR-030-market-data-projection-and-sequencing-foundation.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

Migration 0010, the version-one fact contract, final-state command publication, and bounded Trading
fact reader may be implemented. Market Data-owned checkpoints and projections remain separately
gated.
