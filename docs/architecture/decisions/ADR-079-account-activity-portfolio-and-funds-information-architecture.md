# ADR-079 — Account Activity, Portfolio, and Funds Information Architecture

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-02

**Last reviewed:** 2026-09-02

**Canonical owner/source:** ADR-079

## Context

Atlas has separate authenticated routes for Orders, Portfolio, and Funds. Their underlying
capabilities already preserve exact decimal values, server-confirmed state, private account
boundaries, idempotent simulated funding, and transparent portfolio valuation. The initial pages
exposed those capabilities but retained marketing-style headings and feature-demo composition.

ADR-077 established the authenticated product shell and ADR-078 established the trading
workstation. The account routes now need a consistent brokerage-style information architecture
without inventing profit, loss, performance, available margin, or transaction data that the Atlas
API does not own.

## Decision Drivers

The account workspaces should:

1. use operational page language rather than landing-page language;
2. keep server authority and simulation boundaries visible;
3. expose the market scope of order and execution records;
4. preserve exact quantities without browser financial arithmetic;
5. distinguish portfolio valuation from executable pricing and accounting statements;
6. make wallet selection, balances, funding, and withdrawal tasks easy to scan;
7. remain usable on desktop and mobile; and
8. reuse existing feature controllers and API contracts.

## Decision

Atlas will present Orders, Portfolio, and Funds as three distinct account workspaces with shared
visual conventions: restrained page headers, bordered operational panels, compact status chips,
tabular numerals, explicit data authority, and responsive task ordering.

## 1. Orders

The Orders route is a selected-market ledger. It will expose an explicit market selector before
the activity table so users can see and change the scope of loaded records.

The page may summarize only records that have actually been loaded. Summary labels must therefore
say **Loaded orders**, **Active orders**, and **Loaded executions** rather than imply account-wide
totals. Pagination remains authoritative for older records.

Order status, fills, execution quantities, and cancellation outcomes remain server-confirmed.

## 2. Portfolio

The Portfolio route will lead with the server-provided valued total or incomplete valued subtotal,
followed by a dedicated Positions panel. The panel displays exact available, reserved, and total
balances together with the accepted reference price and valuation status.

Atlas will not calculate or display profit and loss, allocation, return, cost basis, or performance
until those concepts have explicit server-owned contracts. The existing valuation disclaimer
remains adjacent to the positions.

An empty portfolio links to `/app/funds`, because wallet creation belongs to the Funds route.

## 3. Funds

The Funds route will use this task order:

1. select an asset;
2. inspect its server-confirmed wallet balance;
3. add simulated funds or complete a simulated withdrawal; and
4. inspect feedback or the latest withdrawal receipt.

Available, reserved, and total remain separate. Deposit and withdrawal forms remain visibly
simulated and do not collect external network, address, destination, or payment information.

## 4. Responsive Behavior

- Desktop retains wide tables and side-by-side funding actions.
- Tablet stacks actions when horizontal space becomes constrained.
- Mobile keeps summary metrics compact, converts positions to labelled cards, and stacks all form
  controls in task order.
- Wide tables scroll only within their own panel and must not create page-level horizontal scroll.

## Alternatives Considered

### Add familiar brokerage metrics using browser calculations

Rejected because fabricated or locally derived margin, return, and profit/loss values would appear
authoritative without corresponding domain contracts or ledger semantics.

### Combine Portfolio and Funds

Rejected because valuation review and balance mutation are different tasks. Separating them keeps
the Portfolio route read-oriented and the Funds route action-oriented.

### Show all-market orders without a visible filter

Rejected because the current controller loads selected-market history. Hiding that scope would
misrepresent the data.

## Consequences

### Positive

- The account area now resembles an operational brokerage workspace rather than a feature demo.
- Record scope and server authority are explicit.
- Existing exact-decimal, idempotency, and private-data guarantees remain unchanged.
- Future account-wide history or performance features have clear extension points.

### Negative

- Summary counts describe the loaded page, not complete historical totals.
- Market-by-market review requires changing the selector.
- Advanced analytics and transaction history remain deferred.

## Reconsider When

Review this decision when Atlas adds account-wide history queries, a transaction ledger, cost basis,
profit-and-loss contracts, margin, multi-currency valuation, external funding, or saved account
filters.

## Related Decisions

- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [ADR-044 — Portfolio Snapshot and Valuation Foundation](ADR-044-portfolio-snapshot-and-valuation-foundation.md)
- [ADR-077 — Authenticated Product Shell, Routing, and Interface Density](ADR-077-authenticated-product-shell-routing-and-interface-density.md)
- [ADR-078 — Trading Workstation Information Architecture](ADR-078-trading-workstation-information-architecture.md)
