# ADR-078 — Trading Workstation Information Architecture

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-02

**Last reviewed:** 2026-09-02

**Canonical owner/source:** ADR-078

## Context

Atlas has working browser capabilities for market selection, read-only Coinbase reference data,
candlestick visualization, Atlas level-two depth, simulated limit-order entry, private orders,
executions, and cancellation. The first product surface presented those capabilities in a single
vertical sequence. Although functionally correct, that sequence forces repeated scrolling and
hides the relationship between market context, price information, liquidity, and execution.

ADR-077 introduced the authenticated product shell and readable light visual system. The Trade
route now needs a workstation composition suitable for repeated desktop use while remaining clear
on tablets and mobile devices.

## Decision Drivers

The Trade interface should:

1. keep selected-market context visible while an order is prepared;
2. distinguish external reference data from Atlas simulated execution data;
3. place order entry close to liquidity without implying that Coinbase prices execute Atlas orders;
4. expose market switching without leaving the Trade route;
5. retain server-confirmed order, balance, and execution authority;
6. avoid invented prices, balances, spreads, or performance values;
7. preserve accessible regions, headings, tables, forms, and status text;
8. remain usable from narrow mobile screens to wide workstations; and
9. reuse the completed feature controllers rather than duplicate data loading.

## Decision

Atlas will use a **three-zone trading workstation** on wide screens:

```text
┌──────────────┬──────────────────────────────┬──────────────────┐
│ Watchlist    │ Selected market + chart      │ Limit order      │
│              │ Coinbase reference data      │ Atlas order book │
├──────────────┴──────────────────────────────┴──────────────────┤
│ Private orders and executions                                 │
└────────────────────────────────────────────────────────────────┘
```

The zones are composition boundaries, not new data owners.

## 1. Watchlist

The left zone displays only configured Atlas markets and their server-confirmed operating state,
lot size, and tick size. Atlas will not invent watchlist prices for markets whose reference feed has
not been loaded. Selecting a market updates the shareable `/app/trade/:marketCode` route and resets
market-specific order intent.

Search, favorites, percentage movers, and customizable watchlists are deferred until Atlas has
enough markets and persistence requirements to justify them.

## 2. Market and reference-data zone

The central zone contains selected-market identity followed by the existing Coinbase quote,
24-hour metrics, and candlestick chart. It must continuously label the source as external,
read-only reference data.

Coinbase data provides visual context only. It cannot price, match, route, settle, validate, or
otherwise authorize an Atlas simulated order.

## 3. Execution zone

The right zone places the simulated limit-order ticket above Atlas's level-two order book. The
ticket retains exact decimal strings and sends the user's explicit values to the server. The order
book remains an Atlas projection, not a Coinbase book.

The execution zone must keep Buy and Sell semantics explicit, retain market-state gating, and
describe the simulation boundary next to the submit action.

## 4. Activity zone

Private orders and executions occupy a full-width zone below the market workstation. This gives
tables sufficient horizontal space while keeping order outcome and cancellation controls inside the
Trade route. `/app/orders` continues to provide a focused activity-only composition using the same
feature controller.

## 5. Responsive behavior

- Wide desktop uses the three-zone workstation.
- Tablet keeps the watchlist beside the market view and moves execution below the market view.
- Mobile uses task order: watchlist, market context, chart, order ticket, order book, activity.
- The market list becomes horizontally scrollable on narrow screens.
- Tables and charts may scroll within their own labelled region; the entire page must not acquire
  unintended horizontal overflow.

## Alternatives Considered

### Keep every capability vertically stacked

Rejected because key decision context disappears during scrolling and the interface does not make
effective use of desktop width.

### Copy an existing brokerage terminal exactly

Rejected because Atlas should use familiar information relationships without copying another
product's visual identity, terminology, or undocumented behavioral assumptions.

### Merge Coinbase and Atlas market data

Rejected because the two sources have different authority. Visual proximity must not become data
or execution ambiguity.

### Add draggable and user-persisted panels now

Deferred because it adds layout state, persistence, accessibility, and testing complexity before a
stable default workstation has been validated.

## Consequences

### Positive

- Market context, reference price, Atlas depth, and order entry are visible together.
- The source and authority boundary remains explicit.
- The same controllers support both the full Trade route and focused Orders route.
- Wide screens gain useful density without reducing text below the ADR-077 minimum.

### Negative

- The right execution column is narrower and requires deliberately compact order-book tables.
- Tablet and mobile require different grid arrangements.
- Watchlist customization remains unavailable.

## Reconsider When

Review this decision when Atlas supports many more markets, persistent watchlists, advanced order
types, multiple chart providers, detachable panels, professional keyboard workflows, or validated
user demand for configurable density.

## Related Decisions

- [ADR-029 — Public Trading HTTP API and Read Contract](ADR-029-public-trading-http-api-and-read-contract.md)
- [ADR-034 — Public Level-Two Order Book HTTP Contract](ADR-034-public-level-two-order-book-http-contract.md)
- [ADR-043 — Browser Market Data Streaming and Recovery](ADR-043-browser-market-data-streaming-and-recovery.md)
- [ADR-055 — Light Product Interface and Visual System](ADR-055-light-product-interface-and-visual-system.md)
- [ADR-077 — Authenticated Product Shell, Routing, and Interface Density](ADR-077-authenticated-product-shell-routing-and-interface-density.md)
