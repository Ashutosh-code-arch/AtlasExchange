# ADR-046 — Browser Portfolio Snapshot Experience

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-046

## Context

ADR-044 defines Atlas's exact, read-only Portfolio snapshot and ADR-045 exposes it through an
authenticated, owner-derived HTTP route. Atlas now needs a browser presentation that is useful to a
trader without inventing a second valuation model, concealing missing prices, or making a composed
operational view look like an executable quote or accounting statement.

The first Portfolio surface must also fit the current single-page exchange workspace, preserve
authenticated ownership across session changes, work on narrow screens, and remain honest when a
refresh fails after valid data has already been shown.

## Decision Drivers

The browser experience should:

1. display the strict server response without recomputing authoritative balances or totals;
2. distinguish complete valuation from a subtotal that excludes unpriced assets;
3. preserve exact decimal strings at the presentation boundary;
4. expose the reference market, price time, and freshness meaning used for each valued position;
5. isolate snapshots between authenticated users;
6. avoid background request volume that has no demonstrated product need;
7. retain useful last-valid data without implying that failed refreshes succeeded; and
8. remain accessible and usable across desktop and mobile layouts.

# Decision

Atlas will add an authenticated Portfolio workspace to the primary browser experience.

## 1. Server-owned portfolio meaning

The browser parses every success response with the shared strict Portfolio schema. It renders the
returned `available`, `reserved`, `total`, per-position `value`, `summary.totalValue`, completeness,
and excluded asset codes directly.

Formatting may group decimal-string integer digits for readability, but it must not convert
authoritative values to JavaScript `number`, add position values, calculate allocations, infer
profit/loss, or replace the server's subtotal. The UI therefore has no independent portfolio
arithmetic authority.

## 2. Complete and incomplete presentation

When `summary.complete` is true, the headline is **Estimated portfolio value** and the UI states that
every positive position has an accepted Atlas reference price.

When it is false, the headline is **Valued subtotal**. The UI labels the valuation incomplete, names
every excluded asset, gives each unpriced position an em dash rather than a zero USD value, and
shows whether no direct USD market or no committed reference price exists.

Zero positions retain their explicit zero status. USD cash uses its contract-defined one-to-one
valuation. A valued position shows its direct market, exact reference price, price timestamp, and
current or delayed status.

## 3. Loading, refresh, and failure state

The workspace loads once after a server-confirmed authenticated session becomes available. It does
not poll and does not open another realtime channel. The user can explicitly request a refresh.

An initial failure shows no fabricated data and provides a retry action. If a later manual refresh
fails, the last valid snapshot remains visible with a prominent stale warning and retry action.
`RATE_LIMITED` receives safe wait-and-retry guidance; internal messages and request identifiers are
never rendered.

Only the newest request generation may update the view. Unmounting or changing the authenticated
user invalidates outstanding work, and the authenticated workspace is keyed by user identity so one
account's snapshot cannot appear in another account's state.

## 4. Composition and responsive structure

Portfolio appears after the Identity surface and before Trading in the overview route. Primary
navigation links directly to it.

The desktop presentation uses a summary followed by a semantic positions table. On narrow screens,
each table row becomes a labelled two-column position card while preserving the table's accessible
structure. Empty authenticated accounts receive an explicit empty state and a link to the Financial
sandbox. Unauthenticated and Identity-unavailable states do not invoke the Portfolio endpoint.

## 5. Product claims and omissions

The workspace labels values as indicative USD values derived from last committed Atlas trades. It
states that they are not executable quotes, profit/loss, or an accounting statement.

The first release deliberately omits allocation charts, percentage changes, cost basis, realised or
unrealised profit/loss, external-market values, selectable valuation currencies, background polling,
and Portfolio WebSocket subscriptions. Each requires an accepted source and semantic rule before it
can be presented truthfully.

## Alternatives Considered

### Recalculate the subtotal in the browser

Rejected because it duplicates exact-decimal rules and could disagree with the response whose
cross-field invariants have already been validated.

### Show unpriced positive positions as zero value

Rejected because zero is a false valuation. The subtotal and exclusion must remain explicit.

### Poll Portfolio continuously

Rejected because balances and committed prices already expose their own update surfaces, while no
Portfolio freshness objective currently justifies repeated private composed reads.

### Clear all content when a refresh fails

Rejected because a labelled last-valid snapshot is more useful and no less honest than replacing it
with an empty screen.

### Add allocation and profit/loss charts immediately

Rejected because Atlas has not accepted cost-basis, reference-period, or incomplete-allocation
semantics. Visual polish cannot define financial meaning implicitly.

## Consequences

### Positive Consequences

- Exact values and reconciliation remain server-owned.
- Missing price coverage is visible rather than converted into a misleading total.
- Authenticated state and outstanding work are isolated by user.
- Manual refresh bounds private read volume and makes user intent explicit.
- Last-valid stale retention provides resilient but honest failure behavior.
- Responsive semantic presentation makes the same contract useful on desktop and mobile.
- Focused API, component, app-composition, and real-browser tests cover the complete boundary.

### Negative Consequences

- The snapshot does not update automatically after every wallet or trade action.
- The composed view can reflect source facts from slightly different moments.
- Large portfolios require a later pagination or virtualization decision.
- Exact strings can occupy substantial visual space on narrow screens.
- Users receive no allocation or performance analytics in this increment.

## Reconsider When

Review this decision when Portfolio has a measurable freshness objective, large position counts need
pagination or virtualization, another valuation currency is accepted, cost-basis and profit/loss
semantics are authoritative, or private realtime delivery provides a justified benefit over manual
refresh.

## Related Decisions

- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-023 — Financial HTTP API and Error Contract](ADR-023-financial-http-api-and-error-contract.md)
- [ADR-041 — Candlestick Chart and Polling Delivery](ADR-041-candlestick-chart-and-polling-delivery.md)
- [ADR-043 — Browser Market Data Streaming and Recovery](ADR-043-browser-market-data-streaming-and-recovery.md)
- [ADR-044 — Portfolio Snapshot and Valuation Foundation](ADR-044-portfolio-snapshot-and-valuation-foundation.md)
- [ADR-045 — Authenticated Portfolio HTTP Contract](ADR-045-authenticated-portfolio-http-contract.md)
