# ADR-040 — Public Candle History HTTP Delivery

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-040

## Context

ADR-038 accepts the candle history contract: six intervals, exact sparse OHLCV, an exclusive
backward cursor, bounded pages, open-candle state, and full initial retention. ADR-039 composes the
candle projector into the managed worker and proves a repeatable-read internal history model.

Atlas can now expose candle history to anonymous clients. The delivery boundary must convert
internal exact units through the canonical Trading market, combine the snapshot with observed
publication progress, enforce the accepted request contract before resource admission, and retain
the established Market Data caching, limiting, privacy, and safe-error policy.

## Decision Drivers

The route should:

1. implement the shared ADR-038 contract without adding transport-only semantics;
2. convert ticks, lots, and tick-lots without floating point;
3. return coherent projection sequence and point-in-time publication lag;
4. distinguish mutable open candles from closed buckets;
5. preserve sparse gaps and stable backward pagination;
6. reject malformed input before rate-limit capacity is consumed;
7. share anonymous snapshot protection with book and ticker routes; and
8. expose no projection, execution, order, owner, or settlement internals.

# Decision

Atlas will expose:

~~~text
GET /api/v1/market-data/markets/:marketCode/candles
  ?interval=1m
  &limit=200
  &before=2026-08-28T12:00:00.000Z
~~~

The endpoint is anonymous. `interval` is required and accepts `1m`, `5m`, `15m`, `1h`, `4h`, or
`1d`. `limit` is a canonical integer string from 1 through 500 and defaults to 200. `before` is an
optional interval-aligned ISO-8601 UTC bucket-start cursor and is exclusive.

Unknown query fields, malformed market codes, unsupported intervals, noncanonical limits,
unaligned cursors, and request bodies return `VALIDATION_FAILED` before limiter admission.

## 1. Exact public conversion

Market Data resolves the canonical Trading market before reading history. Every internal candle is
converted as follows:

- price ticks use the market limit-price definition;
- base-volume lots use the market base-lot definition; and
- quote-volume tick-lots use exact integer conversion:

~~~text
quote atomic units =
  quote-volume tick-lots
  × base atomic units per lot
  × quote atomic units per price tick
  ÷ base atomic units per whole unit
~~~

The division must be exact. Inexact market definitions, invalid values, or overflow are internal
invariant failures and become the generic safe 500 response. Prices and volumes cross HTTP as
canonical decimal strings; trade count and sequence values are canonical integer strings.

## 2. Public page and privacy

A successful page returns market, interval, effective limit, applied sequence, observed published
sequence, lag, freshness, `asOf`, generation time, ascending candles, and `nextBefore`.

Each candle contains start, end, open, high, low, close, base volume, quote volume, trade count, and
`closed`. A sparse empty page is valid. Gaps remain absent rather than becoming zero-volume or
forward-filled candles.

Generation IDs, checkpoint rows, ticks, lots, tick-lots, market/execution sequences per candle,
trade IDs, order IDs, owners, counterparties, and financial movements are private.

## 3. Open candle semantics

The public adapter derives:

~~~text
closed = candle end <= generatedAt
~~~

An open candle is an exact aggregate through the page's applied sequence and may change as new
committed executions are projected. `generatedAt` comes from the internal use case's single injected
clock evaluation. The public layer does not independently sample time.

## 4. Sequence and freshness

The candle snapshot and Trading publication high-water mark are read concurrently after market
resolution:

~~~text
lag = published sequence - candle checkpoint sequence
lag = 0  -> current
lag > 0  -> behind
~~~

A checkpoint ahead of Trading is an invariant failure. `current` means caught up to the observed
high-water mark, not permanently current. A behind history page remains readable with honest lag.

## 5. Caching, limiting, and errors

Successful responses use:

~~~text
Cache-Control: public, max-age=1, must-revalidate
~~~

Book, ticker, and candle requests share the process-local Market Data limiter: 120 admissions per
client network identity per 60 seconds. Rejections return `RATE_LIMITED` with `Retry-After`.

The route uses the existing safe vocabulary:

- `VALIDATION_FAILED` — 400;
- `MARKET_NOT_FOUND` — 404;
- `RATE_LIMITED` — 429; and
- `INTERNAL_SERVER_ERROR` — 500.

Unexpected persistence, generation, conversion, and invariant details do not cross the central
error boundary.

## Alternatives Considered

### Return internal ticks and lots

Rejected because they are projection units, not the stable public market representation.

### Accept arbitrary timestamps as cursors

Rejected because the accepted history key is an interval bucket start. Alignment catches client
errors and keeps page boundaries reproducible.

### Give candle history a separate limiter

Rejected initially because all three routes are anonymous Market Data snapshots under one
process-local protection budget. Endpoint-specific or distributed quotas require measured demand.

### Cache closed and open candles identically for longer periods

Rejected initially because a page may include a mutable open candle and current lag metadata. More
advanced conditional or bucket-aware caching can be introduced when needed.

### Expose execution sequence to explain open and close

Rejected because it is deterministic internal ordering metadata, not a public trade-history field.

## Consequences

### Positive Consequences

- Anonymous clients can request exact, bounded, sparse chart history.
- Shared runtime validation protects both API producers and later web consumers.
- Open candles and eventual-consistency lag remain explicit.
- Exact market conversion prevents floating-point drift in financial values.
- The route reuses established caching, limiting, and safe-error behavior.

### Negative Consequences

- Every request performs market lookup, history read, and publication-sequence observation.
- One-second caching may intentionally trail a newly projected execution.
- Process-local limits are not globally exact across API replicas.
- The web requires a separate charting and polling delivery decision, resolved by ADR-041.

## Reconsider When

Review this decision when candle WebSocket updates are introduced, immutable closed-bucket caching
is valuable, ETags or conditional requests are added, multiple replicas require distributed
limiting, public retention changes, or a candle correction/version protocol is accepted.

## Related Decisions

- [ADR-034 — Public Level-Two Order-Book HTTP Contract](ADR-034-public-level-two-order-book-http-contract.md)
- [ADR-037 — Public Trade Ticker HTTP Contract](ADR-037-public-trade-ticker-http-contract.md)
- [ADR-038 — Candle Projection and Historical Contract](ADR-038-candle-projection-and-historical-contract.md)
- [ADR-039 — Managed Candle Projection and Internal History Reader](ADR-039-managed-candle-projection-and-internal-history-reader.md)
- [ADR-041 — Candlestick Chart and Polling Delivery](ADR-041-candlestick-chart-and-polling-delivery.md)
