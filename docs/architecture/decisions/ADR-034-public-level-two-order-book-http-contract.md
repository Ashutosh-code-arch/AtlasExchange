# ADR-034 — Public Level-Two Order-Book HTTP Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-034

## Context

ADR-030 reserved public Market Data routes until depth, freshness, caching, rate limiting,
validation, and error behavior were explicit. ADR-031 through ADR-033 now provide committed Trading
facts, an atomic generation-aware level-two projection, and a managed worker with exact lag. Atlas
can expose its first truthful public market view without reading command tables or implying that
displayed liquidity is authoritative or immediately executable.

The initial consumer is the Atlas web application, but the contract is anonymous and must remain
safe for other clients. It must preserve exact values, bound database and response work, make
eventual consistency visible, and reveal no order, owner, priority, reservation, or projection
implementation data.

## Decision Drivers

The endpoint should:

1. expose only aggregate public price levels;
2. preserve prices, quantities, counts, and sequences without floating-point loss;
3. bound both PostgreSQL work and payload size;
4. describe projection freshness without claiming synchronous consistency;
5. remain cacheable for a short, explicit interval;
6. protect the anonymous route from accidental request amplification;
7. validate all inputs and outputs through shared workspace contracts;
8. return stable, safe errors without projection internals;
9. preserve REST polling as a valid fallback when streaming is added; and
10. remain simple enough for the current single-process deployment.

# Decision

Atlas will expose:

~~~text
GET /api/v1/market-data/markets/:marketCode/order-book?depth=N
~~~

The route is anonymous. `marketCode` uses the existing canonical Trading market-code contract.
`depth` is optional, defaults to 20, and is a canonical integer string from 1 through 100. It limits
each side independently and is applied in PostgreSQL as well as to the response. Checkpoint and
level rows are read in one repeatable-read transaction so every response is one coherent projection
snapshot.

## 1. Public representation

The successful response contains:

- market code and effective depth;
- greatest applied Market Data sequence;
- observed Trading publication sequence and exact lag;
- `current` or `behind` freshness state;
- authoritative latest-applied-fact `asOf` time, or `null` at sequence zero;
- response-generation time;
- bids in strict descending price order and asks in strict ascending price order; and
- exact price, aggregate base quantity, and order count for each level.

Prices and quantities are canonical decimal strings. Counts, sequences, and lag are canonical
integer strings so JavaScript number limits cannot change authoritative values. Internal lots and
ticks are converted with the owning Trading market definition. The aggregate quantity conversion
does not enforce the minimum size for a new order because a legitimately partially filled level can
fall below that minimum.

The public response never contains order IDs, owner IDs, priority, individual quantities,
counterparty relationships, generation IDs, checkpoints, database values, or worker errors.

## 2. Sequence and freshness semantics

~~~text
lag = observed published sequence - applied projection sequence

lag = 0  -> current
lag > 0  -> behind
~~~

The values form one point-in-time observation. A Trading transaction may commit immediately after
the high-water mark is read. `current` therefore means caught up to that observation, not globally
or permanently current. A behind snapshot remains available with honest metadata; Atlas has not yet
accepted a production freshness SLO that would justify returning 503 after a fixed threshold.

The projection sequence must never exceed the observed publication sequence. Such a condition is
treated as an internal invariant failure, not normalized into client-visible data. Sequence zero
requires `asOf: null`; every positive applied sequence requires an authoritative `asOf` value.

## 3. Caching

Successful snapshots return:

~~~text
Cache-Control: public, max-age=1, must-revalidate
~~~

One second provides a small polling and intermediary-cache benefit without presenting the book as a
long-lived reference resource. Error responses are not assigned this public cache policy. ETags,
conditional requests, and stale-while-revalidate are deferred until client traffic shows a benefit.

## 4. Rate limiting

The initial adapter uses a process-local fixed window per client network identity:

- 120 successful admissions per 60 seconds;
- request identity derived from Express's non-trusted-proxy client IP behavior;
- raw client identities replaced by SHA-256 digests in limiter memory;
- bounded tracked-client capacity; and
- HTTP 429 with `Retry-After` when exhausted.

Strictly invalid requests are rejected before they consume limiter capacity. This is an application
defense, not a substitute for edge rate limiting. Trusted-proxy configuration, distributed limits,
API keys, and plan-specific quotas require a deployment-focused follow-up before Atlas operates
behind a public proxy or multiple API replicas.

## 5. Validation and errors

Shared `@atlas/contracts` schemas validate strict path, query, success, and error shapes. GET bodies,
unknown query keys, non-canonical market codes, numeric rather than string query values, and depths
outside the accepted range return `VALIDATION_FAILED`.

The public error vocabulary is:

- `VALIDATION_FAILED` — 400;
- `MARKET_NOT_FOUND` — 404;
- `RATE_LIMITED` — 429; and
- `INTERNAL_SERVER_ERROR` — 500.

Unexpected database, projection-generation, conversion, and invariant failures pass through the
central safe error handler. Stack traces, SQL, generation state, and internal error messages never
cross the HTTP boundary.

## 6. Composition and ownership

Market Data owns the use case, router, rate limiter, projection reader, response mapping, and public
contract behavior. It consumes only Trading's public market-reader and publication-sequence
interfaces. It does not query Trading tables directly.

The API process composes the public router independently of whether the projection worker kill
switch is enabled. If the worker is disabled, the last durable snapshot remains readable and its
published sequence and lag expose that it is behind.

## 7. Evidence

Contract tests prove depth parsing, metadata reconciliation, strict ordering, exact string values,
privacy, and safe errors. Application tests prove conversion, depth trimming, not-found behavior,
lag calculation, and sequence invariants. HTTP tests prove anonymous access, defaults, validation,
caching, rate limiting, and safe failure mapping. Real-PostgreSQL HTTP evidence proves composed
market lookup, bounded level reads, exact decimal conversion, and lag from durable checkpoint and
Trading high-water state.

# Alternatives Considered

## Expose lots and ticks

Rejected because they are persistence-oriented market units rather than the client-facing values a
trading UI should render. Exact canonical decimals preserve truth without leaking the representation.

## Query authoritative Trading orders on demand

Rejected because it violates module ownership, adds command-database load, and bypasses the accepted
sequence and rebuild model.

## Return 503 whenever lag is nonzero

Rejected because transient eventual-consistency lag is expected and no production freshness SLO has
been accepted. Exact lag is more useful at this stage.

## No caching or rate limiting

Rejected because an anonymous polling route needs explicit resource controls before it is connected
to the web UI.

## Add WebSocket delivery in the same decision

Rejected because connection lifecycle, subscription recovery, heartbeats, backpressure, and snapshot
handoff require a separate protocol decision.

# Consequences

## Positive Consequences

- Atlas has a truthful, exact, public top-of-book/depth source for the trading workspace.
- Database and response cost are bounded by the same client-visible depth.
- Clients can distinguish a caught-up snapshot from projection lag.
- Shared schemas prevent transport drift between API and web.
- Private Trading and projection details remain concealed.

## Negative Consequences

- Polling can still create repeated database work and one-second-old responses.
- Process-local limiting is not globally exact across multiple API replicas.
- The high-water and snapshot reads are not one cross-module database transaction, so metadata is an
  explicitly point-in-time observation.
- A behind snapshot remains available until a later SLO defines an unacceptable threshold.
- Public decimal conversion currently depends on the Trading market catalog being readable.

# Reconsider When

Revisit this decision when Atlas adds WebSocket delivery, runs multiple API replicas, deploys behind
a trusted proxy, measures public traffic requiring edge quotas or conditional caching, establishes a
production freshness SLO, changes the maximum useful depth, or versions the Market Data protocol.
