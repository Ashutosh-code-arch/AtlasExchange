# ADR-041 — Candlestick Chart and Polling Delivery

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-041

## Context

ADR-038 defines exact sparse candle history and ADR-040 exposes it through a bounded anonymous HTTP
contract. Atlas now needs to present that history inside the Trading workspace without implying an
external market feed, hiding projection lag, fabricating buckets, or making browser floating-point
values authoritative.

The first chart should be useful on desktop and mobile, remain maintainable by one developer, and
reuse the polling safety established by the order book and ticker. Atlas does not yet have measured
requirements that justify a third-party charting dependency or streaming transport.

## Decision Drivers

The web delivery should:

1. preserve sparse UTC bucket placement rather than compressing time gaps;
2. show exact server-provided OHLCV strings and explicit open-candle state;
3. expose all six accepted intervals without coupling interval state to market selection;
4. retain a valid chart visibly when a later refresh fails;
5. ignore late responses after market or interval changes;
6. pause background traffic in hidden tabs and prevent overlapping requests;
7. expose projection lag and manual recovery;
8. remain responsive, accessible, and dependency-light; and
9. keep browser chart arithmetic outside financial authority.

# Decision

Atlas will render a native responsive SVG candlestick and volume chart inside the Trading workspace.
It will not add a charting dependency in this slice.

The default request is:

~~~text
interval = 5m
limit = 120
refresh = 5 seconds
~~~

Users can select `1m`, `5m`, `15m`, `1h`, `4h`, or `1d`. Each change creates a distinct selection
boundary. A response for an older market or interval cannot replace the active selection.

## 1. Truthful chart geometry

Candles are positioned from their actual UTC start and end timestamps. Missing server buckets
therefore consume horizontal time but render no candle. The client does not synthesize zero-volume
candles, forward-fill prices, or compress sparse periods into adjacent visual slots.

The browser converts validated decimal strings to finite JavaScript numbers only to calculate SVG
coordinates and compact axis labels. The exact strings remain the displayed OHLCV values. Chart
coordinates, axis rounding, and colors are presentation only and must never feed orders, balances,
settlement, persistence, or API commands.

Volume bars share candle time positions. A candle whose close is at or above open uses the buy color;
a lower close uses the sell color. An open candle uses a dashed, unfilled body and is also labelled
`Open` in the latest-candle summary.

## 2. Polling and selection lifecycle

The chart owns an independent non-overlapping REST loop. It:

- loads immediately while the document is visible;
- schedules the next request only after the current request settles;
- pauses while the document is hidden and refreshes when it becomes visible;
- clears an old market or interval snapshot before displaying the new selection;
- ignores responses from disposed selections;
- retains a matching last-valid snapshot after refresh failure; and
- provides explicit retry for initial and stale failures.

Polling, order-book polling, and ticker polling remain independent so one unavailable read model does
not suppress the others.

## 3. Freshness and states

The chart exposes loading, empty, current, behind, stale, and unavailable states. Server-provided
`sequence`, `generatedAt`, `lag`, and `freshness` remain visible. `behind` means the chart is readable
but its candle checkpoint trails the observed Trading publication sequence. `stale` means the
browser failed to refresh and is retaining a previously valid matching snapshot.

An empty response states that no committed trades exist in the chart window. It does not draw a flat
line or infer a price from ticker or order-book data.

## 4. Accessibility and responsiveness

The chart region and SVG use market- and interval-specific accessible names. Interval controls expose
pressed state. Exact latest OHLCV values remain available as semantic definition-list content rather
than only as pixels. Each SVG candle includes its timestamp, OHLC, volume, trade count, and open state
as descriptive content.

The chart scales to its container on larger viewports and preserves a horizontally scrollable minimum
plot width on narrow screens so candles and labels do not collapse into unreadable geometry.

## Alternatives Considered

### Add a third-party financial chart library now

Rejected initially because the accepted scope needs static candlesticks, volume, intervals, sparse
time placement, and refresh states. A dependency becomes worthwhile when interactions such as zoom,
pan, indicators, annotation, or high-frequency incremental updates would otherwise create material
maintenance cost.

### Compress sparse candles into equal adjacent slots

Rejected because it visually removes periods with no committed Atlas executions and misrepresents
elapsed time.

### Drive the chart from ticker polling

Rejected because ticker and candle projections have independent checkpoints, semantics, and failure
states.

### Refresh open candles every two seconds

Rejected initially because the snapshot route is cacheable for one second and Atlas has no measured
need for higher chart frequency. Five seconds reduces redundant anonymous traffic while preserving a
responsive learning environment.

## Consequences

### Positive Consequences

- The Trading workspace now has an exchange-style price and volume history surface.
- Sparse execution periods, open buckets, and projection lag remain truthful.
- Market and interval changes cannot leak late history into the active chart.
- No new runtime dependency or vendor-specific chart abstraction is introduced.
- Exact server strings remain visible and separate from display-only coordinate math.

### Negative Consequences

- The SVG provides no zoom, pan, crosshair, indicators, or user drawing tools.
- REST polling repeats complete bounded snapshots rather than sending incremental changes.
- JavaScript number conversion limits axis geometry for values outside finite browser ranges, even
  though the underlying validated strings remain exact.
- Separate book, ticker, and chart loops create multiple anonymous requests per active market.

## Reconsider When

Review this decision when WebSocket candle updates are accepted, chart history needs interactive
navigation, users need indicators or annotations, hundreds of visible candles cause measured render
cost, or a maintained chart library would remove more complexity than it adds.

## Related Decisions

- [ADR-009 — Frontend Architecture and State Strategy](ADR-009-frontend-architecture-and-state-strategy.md)
- [ADR-034 — Public Level-Two Order-Book HTTP Contract](ADR-034-public-level-two-order-book-http-contract.md)
- [ADR-037 — Public Trade Ticker HTTP Contract](ADR-037-public-trade-ticker-http-contract.md)
- [ADR-038 — Candle Projection and Historical Contract](ADR-038-candle-projection-and-historical-contract.md)
- [ADR-040 — Public Candle History HTTP Delivery](ADR-040-public-candle-history-http-delivery.md)
