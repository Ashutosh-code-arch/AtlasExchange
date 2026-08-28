# ADR-038 — Candle Projection and Historical Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-038

## Context

ADR-030 defines candles as UTC-aligned aggregates of committed Atlas trades. Open and close use
execution order, prices and volumes remain exact, and trade-free intervals do not produce synthetic
or forward-filled candles.

Atlas now needs a durable candle projection plus a stable historical response contract. The design
must settle supported intervals, open-candle treatment, sparse history, pagination, persistence,
checkpoint isolation, and eventual-consistency metadata before worker, reader, HTTP, and web-chart
implementation proceeds.

## Decision Drivers

The design should:

1. derive every value only from committed Trading execution facts;
2. preserve exact integer storage and exact decimal public values;
3. make every interval boundary deterministic across processes and time zones;
4. keep candle failure and rebuild state independent from the book and ticker;
5. expose useful bounded history without offset pagination;
6. represent the currently open interval honestly;
7. omit trade-free intervals instead of fabricating price continuity; and
8. remain practical for a solo-developer MVP while preserving rebuild and retention options.

# Decision

Atlas will maintain a generation-aware `candles` projection with its own checkpoint. Migration 0013
creates one active candle generation and the `market_data.candles` aggregate table.

## 1. Supported intervals and UTC alignment

The MVP intervals are:

~~~text
1m, 5m, 15m, 1h, 4h, 1d
~~~

Every bucket is the half-open interval `[start, end)`. Boundaries align to the Unix epoch in UTC:

~~~text
start = floor(executedAt / interval duration) × interval duration
end   = start + interval duration
~~~

This means daily candles begin at `00:00:00Z`; four-hour candles begin at `00:00Z`, `04:00Z`, and
so on. Local time zones and daylight-saving changes never affect a bucket.

## 2. Exact OHLCV semantics

For every bucket containing at least one committed trade:

- open is the price with the lowest execution sequence;
- close is the price with the highest execution sequence;
- high and low are the exact maximum and minimum execution prices;
- base volume is the exact sum of executed lots;
- quote volume is the exact sum of `price ticks × quantity lots`;
- trade count is the number of committed executions; and
- last sequence is the greatest applied Market Data fact sequence contributing to the row.

Execution sequence, not timestamp or arrival order, resolves open and close. Internal values remain
integer ticks, lots, and tick-lots. Public conversion later uses the authoritative Trading market
definition and never floating-point arithmetic.

An interval with no trades has no row and no public candle. Atlas does not forward-fill the prior
close, create zero-volume candles, or infer prices from orders or external venues.

## 3. Independent atomic projection

The candle projector consumes Trading's bounded ascending fact reader. It checkpoints every
contiguous supported fact, including order-state facts that do not change candle rows. A trade
updates all six supported interval rows.

Candle updates and checkpoint advancement commit in one PostgreSQL transaction under a
transaction-scoped per-market candle advisory lock. A sequence gap, market mismatch, checkpoint
conflict, invalid interval, or invalid exact value rolls back the batch. Replayed facts at or below
the durable checkpoint are harmless.

The candle generation and checkpoint are independent from `level_two_order_book` and
`trade_ticker`. A candle failure cannot corrupt those views or falsely claim their progress, and a
candle rebuild can use a new generation without replacing their data.

## 4. Historical request contract

The planned anonymous route is:

~~~text
GET /api/v1/market-data/markets/:marketCode/candles
  ?interval=1m
  &limit=200
  &before=2026-08-28T12:00:00.000Z
~~~

`interval` is required. `limit` defaults to 200 and is bounded from 1 through 500. `before` is an
optional ISO-8601 UTC timestamp and is an exclusive bucket-start cursor. Unknown query fields,
unsupported intervals, malformed cursors, and noncanonical limits are invalid.

Responses return candles in strict ascending start-time order for chart consumption. `nextBefore`
is the earliest returned start when another backward request may be attempted; it is `null` when
the returned page is known to be terminal. Empty successful history is valid.

The response also carries market, interval, requested limit, applied sequence, observed published
sequence, exact lag, freshness, latest-applied-fact `asOf`, and response generation time. Projection
generation IDs, checkpoints, ticks, lots, tick-lots, execution sequences, trade IDs, order IDs, and
owners remain private.

## 5. Open candle treatment

A bucket that contains committed trades may be returned before its end. Every candle includes:

~~~text
closed = bucket end <= generatedAt
~~~

An open candle is a truthful point-in-time aggregate through the response's applied sequence, not a
prediction or final value. It may change as later trades are projected. Once the authoritative
generation time reaches the bucket end, it is closed; later executions cannot legitimately belong
to that half-open interval.

## 6. Initial retention

The MVP retains all projected candle rows. Public reads remain bounded by interval, cursor, and
limit. Automated expiry, archive tiers, and aggregate-only long-term storage are deferred until
actual data volume, recovery objectives, and product history requirements justify a retention job.
Rebuilds use the durable Trading fact history and generation replacement protocol.

## Alternatives Considered

### Store only one-minute candles and derive larger intervals at read time

Rejected initially because every larger read would repeat aggregation, open-candle semantics would
be harder to keep coherent, and six exact upserts per trade are acceptable at the MVP scale.

### Store individual candle trades and aggregate every request

Rejected because ticker observations already preserve trade-level projection data and candle reads
should use their own bounded aggregate model rather than repeatedly scan executions.

### Fill missing intervals with the previous close

Rejected because it fabricates a traded price and volume observation. Chart clients may choose a
visual gap policy without changing Atlas's factual API.

### Return only closed candles

Rejected because the active interval is useful for an exchange workspace when explicitly marked as
mutable. The `closed` flag prevents clients from mistaking it for a final aggregate.

### Use offset pagination

Rejected because concurrent open-candle changes and growing history make offsets unstable and
increasingly expensive. An exclusive time cursor matches the ordered data model.

## Consequences

### Positive Consequences

- Candle values are exact, deterministic, sparse, and rebuildable.
- Common exchange intervals are available without request-time reaggregation.
- An independent checkpoint preserves honest per-view progress and failure isolation.
- The public schema supports bounded chart history and explicitly mutable open candles.
- Database constraints enforce interval, alignment, OHLC, volume, count, and sequence invariants.

### Negative Consequences

- Each trade performs six aggregate upserts and increases projection write amplification.
- Retaining all buckets requires a later measured retention decision.
- Open-candle responses may change between requests even when older candles are stable.
- The response contract exists before its reader and HTTP route are wired.

## Reconsider When

Review this decision when write amplification becomes material, history volume requires tiered
retention, additional intervals are requested, late-dated execution correction is introduced,
external market data enters scope, or WebSocket candle delivery needs a revision protocol.

## Related Decisions

- [ADR-030 — Market Data Projection and Sequencing Foundation](ADR-030-market-data-projection-and-sequencing-foundation.md)
- [ADR-031 — Trading Market Data Fact Persistence and Publication Contract](ADR-031-trading-market-data-fact-persistence-and-publication-contract.md)
- [ADR-032 — Market Data Checkpoint and Level-Two Projection Persistence](ADR-032-market-data-checkpoint-and-level-two-projection-persistence.md)
- [ADR-035 — Trade Ticker Projection Persistence and Window Semantics](ADR-035-trade-ticker-projection-persistence-and-window-semantics.md)
- [ADR-037 — Public Trade Ticker HTTP Contract](ADR-037-public-trade-ticker-http-contract.md)
