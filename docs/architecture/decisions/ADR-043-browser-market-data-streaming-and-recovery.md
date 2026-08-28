# ADR-043 — Browser Market Data Streaming and Recovery

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-043

## Context

ADR-042 establishes a strict public WebSocket protocol for complete order-book, ticker, and candle
snapshots. The Trading workspace still uses three independent REST polling loops. Atlas now needs to
move those panels to the accepted stream without losing selection isolation, truthful freshness,
last-valid state, manual recovery, hidden-tab discipline, or the independent REST diagnostic
boundary.

The browser implementation must remain small enough for one developer to reason about. It must not
create one socket per panel, treat a connected transport as fresh data, accept cross-routed payloads,
or clear useful snapshots merely because the network is temporarily unavailable.

## Decision Drivers

The browser transport should:

1. multiplex all visible public Market Data through one connection;
2. wait for the versioned server welcome before sending subscriptions;
3. resubscribe deterministically after reconnect without server-retained state;
4. reject malformed, cross-topic, cross-market, or wrong-parameter snapshots;
5. prevent an older sequence from replacing a newer visible snapshot;
6. preserve the last matching snapshot as visibly stale during interruption;
7. stop background socket activity while the document is hidden;
8. avoid reconnect storms and detect missing application heartbeats;
9. acquire and release resources safely under React Strict Mode; and
10. prove the real browser flow through the API and PostgreSQL-backed projections.

# Decision

The Trading workspace will own one `BrowserMarketDataStreamClient` and pass that explicit dependency
to the order-book, ticker, and candle hooks. Production components have no implicit REST-polling
fallback.

The REST snapshot routes remain supported for diagnostics, direct API consumers, and future explicit
recovery decisions. They are no longer the normal rendered Trading-desk transport.

## 1. Connection and subscription lifecycle

The client converts the configured HTTP API base URL to `ws:` or `wss:` and requests only the
`atlas.market-data.v1` subprotocol. The first active view subscription creates the connection. The
client sends no subscription command until it receives and validates the server `welcome`.

Order book, ticker, and candles then share that socket while retaining separate identifiers and
observers. Market, depth, interval, or limit changes unsubscribe the old selection and create a new
one. A callback retained by an old React effect cannot update the new selection.

The client constructor has no browser side effects. The first subscription acquires the visibility
listener and connection; the final unsubscribe removes the listener, cancels timers, and closes the
socket normally. This makes owned and injected clients follow the same subscription lifetime.

## 2. Snapshot acceptance

Every inbound frame is parsed by the shared strict server-message contract. A snapshot is accepted
only when its identifier maps to an active subscription and its topic, market, depth, interval, and
limit match that subscription.

Each subscription records its greatest accepted projection sequence. A lower sequence is ignored.
An equal or greater complete snapshot may replace the visible state. The exact validated decimal and
integer strings remain presentation inputs; the stream does not introduce financial authority into
the browser.

Malformed JSON, invalid shared contracts, a duplicate welcome, a heartbeat before welcome, or a
cross-routed snapshot closes the socket with protocol-error code 1002.

## 3. Interruption and recovery

An unexpected close marks every matching last-valid panel `stale`; a panel without an initial
snapshot becomes `error`. The client reconnects after 250 ms and doubles the delay after failed
pre-welcome attempts up to eight seconds. A validated welcome resets the delay.

Reconnect creates a new socket and sends every currently active subscription again using the same
subscription identity. The server's first full snapshots restore current state; no replay cursor or
client delta reconstruction is required.

Manual retry reissues only the selected subscription through an ordered unsubscribe/subscribe pair
when connected. If disconnected, it cancels the pending delay and attempts connection immediately.

## 4. Visibility and liveness

When the document becomes hidden, the client cancels reconnect and heartbeat timers and closes the
socket normally. It retains visible state without marking it stale while the page cannot be seen.
When the document becomes visible, it marks retained views stale, connects immediately, and
resubscribes.

The validated welcome declares the application heartbeat interval. Each heartbeat resets a watchdog
for 2.5 times that interval. If the watchdog expires, the browser closes the connection with private
application code 4000 and enters normal reconnect recovery. WebSocket ping/pong remains the server's
transport-level responsibility because browsers do not expose ping frames to application code.

## 5. React ownership

The workspace memoizes the client for one API base URL but does not create external resources during
render. React Strict Mode's development mount-cleanup-mount probe unsubscribes the last view, releases
the connection, then safely reacquires it when the views subscribe again. A real unmount reaches the
same zero-subscription cleanup without a separate parent disposal race.

The hooks expose loading, ready, stale, error, and idle state as before, but UI copy now identifies a
live WebSocket rather than a REST refresh interval.

## Alternatives Considered

### Retain REST as an automatic fallback

Rejected because a silent fallback would recreate multiple polling loops, obscure stream failures,
and make traffic and recovery behavior difficult to reason about. REST remains explicit and
independent.

### Create one socket inside each panel hook

Rejected because it multiplies connections, heartbeats, reconnect timers, and server limits for one
market view.

### Keep the socket open in hidden tabs

Rejected initially because Atlas does not need invisible one-second snapshots. Closing and
resubscribing is simple because every recovery snapshot is complete.

### Clear state whenever the socket disconnects

Rejected because a known last-valid snapshot is more useful than an empty panel when it is clearly
labelled stale.

### Accept all snapshots for a known identifier

Rejected because identifier routing alone would not protect the UI from a buggy or compromised
server sending another market, topic, depth, or interval under that identifier.

## Consequences

### Positive Consequences

- One browser connection carries all three active Market Data views.
- The normal Trading desk no longer generates three independent polling loops.
- Reconnect, visibility resume, and manual retry all recover through the same full-snapshot path.
- Strict routing and monotonic sequence checks prevent stale or mismatched replacement.
- Last-valid data remains usable with explicit interruption messaging.
- Unit, component, workspace, protocol-state-machine, and real-browser tests cover the boundary.

### Negative Consequences

- Hidden-to-visible transitions always create a new connection and three new subscriptions.
- A temporary disconnect may label a still-recent snapshot stale until the next complete snapshot.
- REST does not automatically mask a WebSocket outage.
- The browser client owns timers and connection state that require explicit lifecycle testing.
- Full snapshots still use more bandwidth than delta delivery.

## Reconsider When

Review this decision when background subscriptions become a product requirement, the application
needs private authenticated realtime topics, REST fallback has a measured availability benefit,
delta delivery is accepted, multiple browser workspaces require a broader application-level stream
owner, or reconnection metrics justify a different backoff policy.

## Related Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-034 — Public Level-Two Order-Book HTTP Contract](ADR-034-public-level-two-order-book-http-contract.md)
- [ADR-037 — Public Trade Ticker HTTP Contract](ADR-037-public-trade-ticker-http-contract.md)
- [ADR-040 — Public Candle History HTTP Delivery](ADR-040-public-candle-history-http-delivery.md)
- [ADR-041 — Candlestick Chart and Polling Delivery](ADR-041-candlestick-chart-and-polling-delivery.md)
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
