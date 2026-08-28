# ADR-039 — Managed Candle Projection and Internal History Reader

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-039

## Context

ADR-038 established the independently checkpointed candle projection, six UTC-aligned intervals,
exact sparse OHLCV, bounded backward history, and open-candle semantics. The projector and
PostgreSQL persistence exist, but the API process does not yet run that projection automatically
and no coherent internal history read model exists.

Atlas must compose candles without weakening the failure isolation accepted for level two and the
ticker. It must also prove stable cursor pagination, exact integer reads, current-time bounds, and
checkpoint coherence before exposing the accepted public route.

## Decision Drivers

The implementation should:

1. reuse the managed per-market worker lifecycle and polling budget;
2. preserve independent transactions, locks, generations, and checkpoints;
3. prevent worker status from concealing a stale candle projection;
4. await all sibling projections when one or more fail;
5. return exact sparse history in chart-friendly ascending order;
6. use bounded keyset pagination instead of offsets;
7. read candle rows and checkpoint metadata from one coherent database snapshot; and
8. prevent future-dated projected buckets from leaking into an initial current-time query.

# Decision

Atlas will add the candle projector to the existing `ProjectMarketData` coordinator and introduce a
Market Data-owned `GetCandles` use case backed by a repeatable-read PostgreSQL history reader.

## 1. Three-projection worker cycle

Every managed batch starts level-two, ticker, and candle projection with the same market and batch
limit. The coordinator uses all-settled behavior and awaits all three outcomes before returning or
throwing. Each projector continues to own its database transaction and may commit independently.

One failure preserves its original error. Multiple failures produce one aggregate error containing
every cause. A successful sibling resumes from its committed checkpoint on the next cycle rather
than repeating accepted work.

## 2. Overall progress and lag

Worker-level progress is the slowest required projection:

~~~text
overall projected sequence = min(level-two, ticker, candle checkpoints)
overall lag = observed Trading publication sequence - overall projected sequence
overall caught up = level-two caught up AND ticker caught up AND candles caught up
~~~

Read and applied counts remain the maximum work reported by any sibling in that batch. This keeps
the existing worker control loop bounded while ensuring a stale candle checkpoint cannot be hidden
behind a current order book or ticker.

## 3. Internal history query

`GetCandles` accepts typed market identity, one supported interval, an optional aligned `before`
cursor, and an optional limit from 1 through 500. The default limit is 200. It evaluates one
injected clock value as `generatedAt`; invalid clocks, limits, and non-aligned cursors fail before
persistence access.

For an initial query, or a cursor beyond the current interval, the use case supplies the current
UTC bucket end as the exclusive upper bound. This includes the currently open bucket while
preventing rows from later buckets from entering the snapshot.

An older valid cursor is preserved exactly:

~~~text
bucket_start < before
~~~

The reader must return the requested market and interval. Identity drift is an internal invariant
failure.

## 4. Repeatable-read PostgreSQL page

The PostgreSQL reader resolves the active candle generation, reads its market checkpoint, and reads
history inside one repeatable-read transaction. It requests the newest `limit + 1` rows in descending
bucket order so it can detect another page without a separate count query.

The returned page contains at most `limit` rows reversed into strict ascending start-time order. If
an extra row exists, `nextBefore` is the earliest returned bucket start; otherwise it is `null`.
The next request therefore continues strictly before the current page without duplicates. Sparse
gaps remain gaps and require no special pagination behavior.

Every internal candle contains exact bigint price ticks, volume lots, quote-volume tick-lots, and
trade count. It also contains exact bucket boundaries. The page carries the candle checkpoint
sequence and latest-applied-fact time. Public decimal conversion, observed publication sequence,
freshness, and `closed` derivation remain the responsibility of the next public application slice.

## 5. Scope Boundary

This decision does not add the HTTP route, public conversion, caching, rate limiting, web API
client, chart library, polling, or WebSocket delivery. The shared contract from ADR-038 remains the
target representation for the next slice.

## Alternatives Considered

### Run candles in a separate worker

Rejected initially because market discovery, process lifecycle, retry, and polling objectives are
still shared. Independent projection transactions preserve isolation without another control loop.

### Report the median or fastest checkpoint

Rejected because it could claim a market is current while one required public view is stale.

### Read history and checkpoint in separate transactions

Rejected because a response could pair rows from one projection state with metadata from another.

### Query exactly the requested limit and infer pagination

Rejected because the reader could not distinguish a terminal full page from one with older data.
Reading one bounded extra row is simpler than a separate count.

### Let the database return ascending rows directly

Rejected because the endpoint needs the newest bounded page. A descending index scan selects that
page efficiently; reversing only the bounded result produces chart order.

## Consequences

### Positive Consequences

- The production worker now maintains all three required Market Data projections.
- Overall lag truthfully reflects the slowest durable checkpoint.
- Internal candle pages are coherent, exact, sparse, bounded, and stable across backward requests.
- The injected clock makes current-bucket behavior deterministic in tests.
- The public route can build on a narrow tested reader boundary.

### Negative Consequences

- Every worker batch now performs three independent fact reads and projection transactions.
- A candle-only failure marks the market-level worker failed even if book and ticker are current.
- Process status still does not expose each projection checkpoint separately.
- The reader reverses each bounded page in application memory.

## Reconsider When

Review this decision when projections need distinct polling objectives, fact fan-out removes
repeated reads, per-projection metrics become necessary, cursor direction changes, history is
served from archive storage, or candle correction/version semantics are introduced.

## Related Decisions

- [ADR-033 — Market Data Projection Worker Lifecycle and Lag Observability](ADR-033-market-data-projection-worker-lifecycle-and-lag-observability.md)
- [ADR-036 — Multi-Projection Worker and Internal Ticker Read Model](ADR-036-multi-projection-worker-and-internal-ticker-read-model.md)
- [ADR-038 — Candle Projection and Historical Contract](ADR-038-candle-projection-and-historical-contract.md)
