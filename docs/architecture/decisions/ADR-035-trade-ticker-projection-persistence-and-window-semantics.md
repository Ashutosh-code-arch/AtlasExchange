# ADR-035 — Trade Ticker Projection Persistence and Window Semantics

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-035

## Context

ADR-030 defines a trade-derived ticker containing the last committed Atlas trade and exact rolling
24-hour high, low, base volume, and quote volume. ADR-031 provides immutable, contiguously sequenced
Trading facts, while ADR-032 establishes generation-aware projection persistence and atomic
checkpoints for the level-two book.

The ticker must now gain an independent durable foundation. Its data has different retention,
query, and rebuild behavior from order-book depth. It must preserve exact financial values, remain
deterministic when trades share a timestamp, and never infer market activity from orders, external
prices, or uncommitted matching state.

## Decision Drivers

The design should:

1. derive every ticker value only from committed Atlas trade facts;
2. retain exact prices and quantities without JavaScript floating-point conversion;
3. preserve the common per-market sequence and gap-detection contract;
4. isolate ticker rebuilds and failures from the level-two projection;
5. make rolling-window boundaries and equal-time ordering deterministic;
6. commit trade observations and their checkpoint atomically;
7. support replay and process restart without duplicate observations; and
8. defer public transport and UI choices until their contracts are explicit.

# Decision

Atlas will maintain a generation-aware `trade_ticker` projection. Migration 0012 creates one active
ticker generation, a checkpoint in the existing generic checkpoint table when each market is first
projected, and a `market_data.ticker_trades` observation table.

## 1. Independent projection ownership

The ticker and level-two order book use separate generation IDs and checkpoints. They consume the
same ordered Trading fact stream but can be rebuilt, activated, or diagnosed independently. A
ticker failure cannot corrupt or redefine the book checkpoint, and vice versa.

The ticker projector advances across every contiguous fact. An `order_state` fact changes no ticker
observation but still advances the checkpoint and its authoritative `lastOccurredAt`. A
`trade_executed` fact stores one observation and advances the same checkpoint. Any sequence gap or
market mismatch rejects the batch.

## 2. Durable observation shape

Each projected trade stores only:

- generation and market identity;
- public trade identity;
- market sequence and execution sequence;
- exact positive price ticks and quantity lots;
- authoritative fact occurrence time; and
- managed projection time.

It does not store owners, orders, reservations, settlement details, idempotency material, or other
private Trading state. Trade identity, market sequence, and execution sequence are unique within a
generation and market. PostgreSQL `NUMERIC(38, 0)` preserves exact integer ticks and lots.

## 3. Atomicity, replay, and restart

For one market and ticker generation, the projector acquires a transaction-scoped PostgreSQL
advisory lock, locks or creates the checkpoint, validates the next contiguous sequences, inserts
trade observations, and compare-and-set advances the checkpoint in one database transaction.

An error rolls back both observations and checkpoint movement. A restarted projector reads the
durable checkpoint. Already applied sequences returned by a stale or replaying reader are harmless;
uniqueness constraints remain the final corruption defense.

## 4. Rolling 24-hour semantics

The later ticker read use case will evaluate an exact rolling interval against an injected clock:

~~~text
[now - 24 hours, now]
~~~

Both boundaries are inclusive. Only observations whose authoritative execution time is inside that
interval participate in high, low, base volume, and quote volume. The last trade is the greatest
ordered pair `(executedAt, executionSequence)` in the window, so equal timestamps are deterministic.

When the window contains no trades, last price, last quantity, high, and low are absent. Base and
quote volume are exact zero values. Percentage change is not part of the initial ticker because a
reference-price and rounding contract has not yet been accepted.

Quote volume is derived exactly from price ticks and quantity lots using the public Trading market
definition. The read model must not use `number` for authoritative arithmetic. Canonical decimal
conversion remains an application-boundary concern, as it is for the public order book.

## 5. Retention and rebuilds

Projected trade observations are retained initially. Pruning is deferred until Atlas defines a
retention margin that cannot remove data required by the rolling window, delayed projection,
incident recovery, or generation rebuild. Applied migrations remain authoritative; replacing or
rebuilding a generation must not mutate historical Trading facts.

## 6. Deferred composition and delivery

This decision establishes schema and projection semantics. It does not yet:

- compose the ticker projector into the managed worker;
- expose a ticker query/read model or HTTP route;
- define caching, public rate limiting, or polling behavior;
- render ticker values in the web application;
- define candles or WebSocket delivery; or
- implement pruning or generation-administration commands.

Those capabilities will build on this durable boundary in later slices.

## Alternatives Considered

### Add ticker columns to the level-two projection

Rejected because book depth and rolling trade data have different persistence, retention, query,
failure, and rebuild behavior. Sharing one checkpoint would create unnecessary coupling.

### Calculate the ticker directly from Trading tables

Rejected because it violates module ownership, bypasses the accepted publication contract, and
couples public read load to authoritative command persistence.

### Store only pre-aggregated 24-hour totals

Rejected because a rolling window must remove observations at exact time boundaries. Retaining the
initial trade observations makes the result reproducible and allows later aggregation choices.

### Use timestamps alone for the last trade

Rejected because PostgreSQL timestamps can be equal. The immutable execution sequence supplies a
deterministic tie-break.

### Use floating-point prices or volumes

Rejected because financial values must remain exact across persistence, calculation, and transport.

## Consequences

### Positive Consequences

- Ticker data has an independently rebuildable, durable projection boundary.
- Exact trade observations support deterministic rolling-window queries.
- Every projected checkpoint remains comparable to the shared Trading sequence.
- Atomic writes, locking, and uniqueness protect restart and replay behavior.
- Private execution and settlement details remain outside Market Data.

### Negative Consequences

- The ticker stores trade-level observations and therefore grows with execution volume.
- Two projections consume the same fact stream and maintain separate checkpoints.
- The public ticker is not useful until worker composition and a read contract are implemented.
- Retention and efficient long-term aggregation still require later operational decisions.

## Reconsider When

Revisit this decision when execution volume makes trade-level window queries or storage expensive,
Atlas introduces generation rebuild tooling, the acceptable projection delay exceeds the retention
margin, candles can share a proven aggregation primitive, or market-data processing moves to a
separate service or event log.
