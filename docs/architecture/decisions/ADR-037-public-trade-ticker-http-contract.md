# ADR-037 — Public Trade Ticker HTTP Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-037

## Context

ADR-035 defines independently persisted committed-trade observations and exact rolling 24-hour
ticker semantics. ADR-036 composes that projection into the managed worker and implements a
repeatable-read internal ticker model using exact ticks, lots, and tick-lots.

Atlas can now expose the ticker to anonymous consumers. The public contract must convert internal
market units through the authoritative Trading market definition, preserve empty-window semantics,
make eventual-consistency lag explicit, and avoid introducing an unsupported percentage-change
claim.

## Decision Drivers

The endpoint should:

1. expose only values derived from committed Atlas trades;
2. preserve exact price, quantity, and volume values as canonical decimal strings;
3. expose the exact rolling-window boundaries used for the result;
4. represent a trade-free window without inventing a price;
5. retain the established sequence, lag, caching, validation, and error conventions;
6. reveal no projection generation, checkpoint, order, owner, or settlement internals;
7. share bounded anonymous-request protection with other Market Data snapshots; and
8. defer percentage change until its reference and rounding behavior are accepted.

# Decision

Atlas will expose:

~~~text
GET /api/v1/market-data/markets/:marketCode/ticker
~~~

The endpoint is anonymous. `marketCode` uses the canonical Trading market-code contract. The
initial route accepts no query parameters and no request body. Unknown query fields, malformed
market codes, or a body return `VALIDATION_FAILED` before consuming rate-limit capacity.

## 1. Public representation

A successful ticker contains:

- market code;
- applied sequence, observed published sequence, exact lag, and `current` or `behind` freshness;
- latest-applied-fact `asOf` time, or `null` at sequence zero;
- generation time and the inclusive 24-hour window start and end;
- optional last price, quantity, and execution time;
- optional high and low prices;
- exact base volume; and
- exact quote volume.

Sequences and lag are canonical integer strings. Prices, quantities, and volumes are canonical
decimal strings. Timestamps are ISO-8601 UTC strings. `generatedAt` equals `windowEnd`, making the
evaluation point explicit, and `windowStart` is exactly 24 hours earlier.

Internal execution sequence remains a deterministic ordering input but is not public ticker data.
Trade IDs, order IDs, owners, counterparties, reservations, generation IDs, checkpoints, ticks,
lots, and tick-lots are not returned.

## 2. Empty and populated windows

When the window contains no committed trades:

- last price, last quantity, last execution time, high, and low are `null`; and
- base and quote volumes are the canonical string `"0"`.

This remains valid when the projection sequence is positive because order-state facts advance the
ticker checkpoint without creating trade observations.

When the window contains trades, all optional trade-derived fields are present, both volumes are
positive, high is not below low, and the last price falls within that range. The last execution time
must lie inside the published inclusive window.

## 3. Exact public conversion

Market Data resolves the canonical Trading market definition before reading a ticker. Price ticks
use the market's limit-price conversion and lots use its base-lot definition. Aggregate quote
volume is converted without floating point:

~~~text
quote atomic units =
  quote-volume tick-lots
  × base atomic units per lot
  × quote atomic units per price tick
  ÷ base atomic units per whole unit
~~~

The division must be exact. Any market-definition mismatch, overflow, or inexact result is an
internal invariant failure and becomes the safe generic 500 response.

## 4. Sequence and freshness semantics

~~~text
lag = observed Trading publication sequence - ticker checkpoint sequence

lag = 0  -> current
lag > 0  -> behind
~~~

The published high-water mark and ticker snapshot form a point-in-time observation. `current` means
caught up to that observation, not permanently current. The checkpoint may include later order
facts than the last trade in the rolling window; therefore `asOf` and `lastExecutedAt` have distinct
meanings.

A checkpoint ahead of Trading's observed publication sequence is an invariant failure. A behind
ticker remains readable with honest lag metadata; Atlas has not accepted a stale-response cutoff.

## 5. Caching and rate limiting

Successful responses use the existing public snapshot policy:

~~~text
Cache-Control: public, max-age=1, must-revalidate
~~~

Ticker and order-book requests share the process-local Market Data snapshot limiter: 120 admissions
per client network identity per 60 seconds, with `Retry-After` on rejection. This is a bounded
single-process defense, not a distributed or trusted-proxy quota.

## 6. Errors

The route uses the existing safe Market Data vocabulary:

- `VALIDATION_FAILED` — 400;
- `MARKET_NOT_FOUND` — 404;
- `RATE_LIMITED` — 429; and
- `INTERNAL_SERVER_ERROR` — 500.

Unexpected schema, generation, database, conversion, and projection failures are handled by the
central safe error adapter. Internal messages and stack traces do not cross the boundary.

## 7. Deferred percentage change

The initial response does not contain absolute or percentage price change. A rolling high/low does
not define the correct comparison price. Atlas must first decide the reference observation at the
24-hour boundary, behavior when that observation is absent, sign and precision rules, and rounding
for presentation.

## Alternatives Considered

### Return internal ticks, lots, and tick-lots

Rejected because they are persistence units rather than client-facing market values.

### Return zero for missing prices

Rejected because zero would fabricate a traded price. Absence and zero volume have different
meanings and must remain distinct.

### Add percentage change using the oldest trade in the current window

Rejected because the oldest included trade is not necessarily the correct 24-hour reference and
would produce unstable semantics as the window moves.

### Reuse Trading trade-history tables directly

Rejected because the public endpoint belongs to Market Data and must consume its accepted
projection boundary rather than couple read traffic to Trading command persistence.

### Add ticker and web UI in one slice

Rejected because the shared API contract should be stable and independently verified before the
frontend starts polling and presenting it.

## Consequences

### Positive Consequences

- Atlas exposes a truthful exact rolling ticker backed only by committed trades.
- Empty markets remain explicit instead of showing fabricated values.
- Clients receive exact window and freshness metadata.
- Shared schemas prevent API and later web consumers from drifting.
- The route reuses established caching, rate limiting, and safe-error behavior.

### Negative Consequences

- The response does not yet provide the percentage change common on exchange dashboards.
- Each request performs market lookup, ticker snapshot aggregation, and publication-sequence read.
- Process-local limiting is not globally exact across API replicas.
- One-second caching means a response may intentionally trail a newly committed trade.

## Reconsider When

Review this decision when percentage change is specified, WebSocket ticker delivery is introduced,
multiple API replicas require distributed limiting, conditional caching becomes useful, public
freshness objectives are accepted, or rolling aggregation performance becomes a measured concern.
