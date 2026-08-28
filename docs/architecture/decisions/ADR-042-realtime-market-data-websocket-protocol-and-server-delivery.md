# ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-042

## Context

Atlas exposes independently checkpointed level-two, ticker, and candle projections through bounded
anonymous REST snapshots. The Trading workspace currently polls those routes. It now needs a
realtime transport that reduces repeated browser polling while preserving exact values, projection
freshness, privacy, deterministic recovery, and safe process shutdown.

Atlas is still a single API process operated by one developer. It has no measured requirement for
incremental book deltas, an external message broker, cross-replica subscription coordination, or an
authenticated private socket. The protocol must therefore solve the present public-snapshot problem
without pretending to provide stronger ordering or delivery guarantees than its source projections.

## Decision Drivers

The server delivery should:

1. reuse the accepted public Market Data representations and exact decimal strings;
2. give clients a deterministic initial state and reconnect path;
3. version and strictly validate both directions of the protocol;
4. avoid one PostgreSQL read per connected browser on every refresh;
5. bound connections, subscriptions, input, output buffering, and background work;
6. reject cross-origin browser use even though the data is anonymous;
7. detect abandoned connections and shut upgraded sockets down before database closure;
8. emit safe errors and operational metadata without leaking internals; and
9. remain suitable for the current single-process deployment.

# Decision

Atlas will provide a public WebSocket endpoint at:

~~~text
GET /api/v1/market-data/stream
Sec-WebSocket-Protocol: atlas.market-data.v1
Origin: <configured WEB_ORIGIN>
~~~

The API uses a no-server WebSocket gateway attached to the existing HTTP server's upgrade event.
Per-message compression is disabled. The stream is enabled independently from the Market Data
projection worker and is configured through validated environment values.

## 1. Authentication and handshake

The first protocol version is anonymous because it contains only the same public data as the REST
routes. It accepts no credentials or tokens in the URL. A browser handshake must provide the exact
configured web origin and offer the `atlas.market-data.v1` subprotocol. The server rejects an
unknown path, query string, origin, or protocol before accepting the socket.

Anonymous does not mean unbounded. The initial process limits are 1,000 connections in total and
five connections per source address. These defaults are operational limits, not a capacity claim.

## 2. Versioned message contract

Client and server messages are strict shared Zod contracts. Unknown fields, malformed identifiers,
binary frames, and unsupported message variants are rejected. Request and subscription identifiers
contain 1–64 ASCII letters, digits, underscores, or hyphens.

Clients can send:

- `subscribe`, containing a request identifier and one order-book, ticker, or candle subscription;
- `unsubscribe`, containing a request identifier and active subscription identifier.

The server can send:

- `welcome`, declaring protocol, server time, heartbeat interval, and subscription limit;
- `subscribed` and `unsubscribed` acknowledgements;
- a topic-discriminated `snapshot`;
- `heartbeat`; and
- a bounded safe `error`.

The allowed error codes are `VALIDATION_FAILED`, `MARKET_NOT_FOUND`, `SUBSCRIPTION_CONFLICT`,
`SUBSCRIPTION_LIMIT`, and `STREAM_UNAVAILABLE`. Internal error details are logged, not transmitted.
Three consecutive invalid client messages close the connection with policy-violation code 1008.

## 3. Subscription and snapshot semantics

Order-book subscriptions declare depth, ticker subscriptions declare a market, and candle
subscriptions declare interval and limit. Each connection initially supports at most twelve active
subscriptions.

A subscription is not acknowledged until its first snapshot is successfully loaded. The server
then sends `subscribed` followed by a complete snapshot. Subsequent messages are complete replacement
snapshots using the accepted REST response data shape; they are not deltas.

The initial refresh cadence is one second. During each refresh, the server groups identical topic
parameters, performs one application-query read for that unique channel, and fans the result out to
all matching subscribers. It does not query once per client.

## 4. Recovery and ordering

The protocol does not promise delivery of every intermediate projection state. Each snapshot carries
the projection's `sequence`, `publishedSequence`, `lag`, `freshness`, `asOf`, and `generatedAt`
metadata. A newer complete snapshot replaces an older one for that subscription.

After disconnect or browser reconnection, the client opens a new socket and resubscribes. The first
complete snapshot re-establishes its state. No resume token, replay buffer, or delta-gap recovery is
needed in version one. REST remains a valid independent snapshot and diagnostic boundary.

## 5. Liveness, backpressure, and lifecycle

Every fifteen seconds the gateway sends an application heartbeat and a WebSocket ping. A connection
that fails to pong before the next interval is terminated. Incoming frames are limited to 8 KiB.
If a client's queued outbound data exceeds 1 MiB, the server closes it with retry-later code 1013
instead of accumulating unbounded memory.

On normal API shutdown, the gateway stops admitting upgrades and stops refresh/heartbeat timers,
then closes clients with going-away code 1001 before the HTTP server and PostgreSQL resources close.
It drains already-running subscription and grouped-refresh reads before PostgreSQL resources close.
The existing forced-shutdown path terminates upgraded sockets as well as ordinary HTTP connections.

## 6. Deployment boundary

Connection and subscription state is process-local. Every API replica may independently read the
durable projection snapshots and serve its own clients; version one does not require sticky sessions
for correctness because reconnect always creates fresh subscriptions and full snapshots.

If database read amplification across replicas becomes material, Atlas will evaluate a shared
publication transport rather than assuming process-local polling scales indefinitely.

## Alternatives Considered

### Server-Sent Events

Rejected because Atlas needs explicit multiplexed subscribe and unsubscribe commands for multiple
markets, topics, depths, intervals, and limits over one connection.

### Incremental order-book and candle deltas

Rejected initially because they require per-client revision state, replay retention, gap detection,
and recovery semantics. Full snapshots are bounded and match the existing durable read models.

### One WebSocket per topic

Rejected because it multiplies browser connections and makes coordinated lifecycle and limits less
clear without improving the public snapshot semantics.

### PostgreSQL notifications or an external broker

Rejected initially because a one-second grouped snapshot refresh is sufficient for the current
single-process learning platform. A broker is justified only after measured latency, throughput, or
replica-read pressure requires it.

### Authenticate the public stream

Rejected because the payload contains no owner-scoped data. Private orders, balances, sessions, and
notifications remain prohibited from this endpoint and require a separate authenticated protocol.

## Consequences

### Positive Consequences

- All three accepted Market Data views share one strict, versioned realtime protocol.
- A successful acknowledgement always has an immediately usable initial snapshot.
- Reconnect recovery is explicit and does not depend on retained server session state.
- Grouped channel reads bound database work relative to unique subscriptions rather than clients.
- Origin, connection, subscription, frame, buffer, heartbeat, and shutdown behavior are explicit.
- The REST boundary remains available while the browser migration is delivered separately.

### Negative Consequences

- Complete snapshots use more bandwidth than well-designed deltas.
- One-second query refresh adds bounded database load even when a projection has not advanced.
- Process-local limits are approximate across multiple replicas.
- Source-address limits may group users behind the same proxy or network address.
- The server exists before the web client consumes it, creating one deliberately temporary delivery
  increment.

## Reconsider When

Review this decision when measured client or database load requires delta publication, multiple API
replicas need shared fan-out, private realtime data enters scope, a proxy changes trustworthy client
identity, browser visibility behavior requires server-side subscription suspension, or the required
latency is materially below the accepted refresh cadence.

## Related Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-030 — Market Data Projection and Sequencing Foundation](ADR-030-market-data-projection-and-sequencing-foundation.md)
- [ADR-034 — Public Level-Two Order-Book HTTP Contract](ADR-034-public-level-two-order-book-http-contract.md)
- [ADR-037 — Public Trade Ticker HTTP Contract](ADR-037-public-trade-ticker-http-contract.md)
- [ADR-040 — Public Candle History HTTP Delivery](ADR-040-public-candle-history-http-delivery.md)
- [ADR-041 — Candlestick Chart and Polling Delivery](ADR-041-candlestick-chart-and-polling-delivery.md)
