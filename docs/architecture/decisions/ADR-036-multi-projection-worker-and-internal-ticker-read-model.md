# ADR-036 — Multi-Projection Worker and Internal Ticker Read Model

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-036

## Context

ADR-033 introduced a lifecycle-managed per-market worker when level-two was the only implemented
projection. ADR-035 then established an independently checkpointed trade-ticker projection and the
exact rolling 24-hour semantics that its later reader must enforce.

Atlas now needs to run both projections continuously without making their database transactions or
generations dependent on one another. It also needs an internal ticker read model that proves
window calculation, exact aggregation, coherent checkpoint metadata, and deterministic last-trade
selection before a public HTTP representation is accepted.

## Decision Drivers

The implementation should:

1. preserve the worker lifecycle, polling budget, and per-market failure isolation from ADR-033;
2. allow level-two and ticker writes to commit independently;
3. never report a market caught up while either required projection is behind;
4. await all in-flight projection work during failure and shutdown;
5. evaluate the ticker window through an injected application clock;
6. calculate aggregate values exactly in PostgreSQL;
7. read ticker data and its checkpoint as one coherent snapshot; and
8. avoid prematurely defining a public ticker transport contract.

# Decision

Atlas will compose level-two and ticker projection behind one generic `MarketDataProjector`
boundary used by the existing worker. The same slice adds a Market Data-owned internal rolling
ticker use case and PostgreSQL reader.

## 1. Combined projection cycle

For each worker batch, `ProjectMarketData` starts both independent projectors with the same market,
batch limit, and Trading fact source. It waits for both outcomes even when either fails. This is
required so a worker failure or shutdown never leaves an unobserved sibling transaction running.

Each projector retains its own advisory lock, generation, checkpoint, and database transaction.
One may commit even when the other fails. The next retry safely replays the already successful
projector from its durable checkpoint and continues the failed one from its checkpoint.

If both projectors fail, the coordinator reports an aggregate error without losing either cause. If
one fails, its original error is preserved for the existing structured retry diagnostics.

## 2. Aggregate worker progress

The worker's market-level projected sequence is the lower of the level-two and ticker checkpoints:

~~~text
overall projected sequence = min(level-two sequence, ticker sequence)
overall lag = Trading published sequence - overall projected sequence
~~

The combined cycle is caught up only when both projectors report caught up. This preserves the
meaning that all required Market Data views have applied every supported fact through the reported
sequence. The existing process-local status remains market-level; per-projection operational status
is deferred until metrics or administrative diagnostics require it.

## 3. Internal ticker window

`GetTradeTicker` obtains `windowEnd` from an injected authoritative clock and derives:

~~~text
windowStart = windowEnd - 24 hours
window = [windowStart, windowEnd]
~~

An invalid clock value fails the use case. Both time boundaries are inclusive, as accepted by
ADR-035. The reader accepts typed market identity and exact `Date` boundaries; parsing public path
parameters remains outside this internal capability.

## 4. Coherent PostgreSQL read

The PostgreSQL reader uses one repeatable-read transaction to resolve the active ticker generation,
read its market checkpoint, calculate window aggregates, and select the last trade. The last trade
orders by execution time descending and then execution sequence descending.

The internal result contains:

- market, checkpoint sequence, and latest-applied-fact time;
- exact window start and end;
- optional last price ticks, quantity lots, execution sequence, and execution time;
- optional exact high and low price ticks;
- exact base-volume lots; and
- exact quote-volume tick-lots, calculated as `sum(price ticks × quantity lots)`.

PostgreSQL `NUMERIC` aggregation is converted directly to `bigint`; authoritative values never pass
through `number`. An empty window returns no last/high/low values and zero volumes. Public decimal
conversion will use the authoritative Trading market definition in the later HTTP-contract slice.

## 5. Scope boundary

This decision does not expose a route, shared contract, cache policy, rate limit, percentage change,
web polling hook, or UI component. It does not alter the schema or introduce a second worker. Those
delivery concerns require a focused public contract after the internal read behavior is stable.

## Alternatives Considered

### Run a separate ticker worker

Rejected initially because both projections share the same market discovery, polling, retry, and
process lifecycle. A generic combined boundary avoids duplicate control loops while preserving
separate persistence transactions.

### Advance projections in one database transaction

Rejected because it would couple generations and failure recovery, undermining the independent
projection ownership accepted in ADR-035.

### Stop after the first projection failure

Rejected because a sibling projection may already be in flight. Failing before it settles weakens
graceful shutdown and can create overlapping work on retry.

### Calculate the rolling ticker in JavaScript

Rejected because it would transfer every window trade, increase application memory and I/O, and
risk accidental numeric conversion. PostgreSQL can calculate the exact bounded aggregates directly.

### Define public decimals in the persistence reader

Rejected because Market Data persistence owns ticks and lots, while the application/public boundary
must use Trading's market definition to convert those units.

## Consequences

### Positive Consequences

- Both Market Data projections now run automatically under one managed lifecycle.
- Overall lag cannot conceal a slower required projection.
- Projection failures retain independent commit and replay behavior.
- The rolling ticker is exact, deterministic, and coherent with its durable checkpoint.
- Public ticker work can build on a tested internal boundary.

### Negative Consequences

- One failed projection marks the market-level worker state failed even if its sibling is current.
- Market-level diagnostics do not yet identify each projection's checkpoint directly.
- Each batch performs two fact reads and two independent projection transactions.
- The internal quote-volume unit still requires market-definition conversion before public use.

## Reconsider When

Revisit this decision when projections need different polling objectives, per-projection status or
alerts become necessary, a separate worker deployment is introduced, repeated fact reads become a
measured bottleneck, or candle processing adds materially different batch and retention behavior.
