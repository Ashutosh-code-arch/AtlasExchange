# ADR-044 — Portfolio Snapshot and Valuation Foundation

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-044

## Context

Atlas now has authoritative owner-scoped wallet balances, exact Trading market definitions, and
committed-trade ticker projections. Phase 6 needs a portfolio surface that composes those
capabilities without creating another balance ledger, presenting fabricated prices, or converting
authoritative values through JavaScript floating point.

A portfolio total is a derived product view, not money that can be spent or settled. It can be
complete only when every positive non-cash position has an accepted reference price. The initial
decision must therefore define ownership, exact valuation, missing-price behavior, freshness, and
the boundary between this query model and later HTTP/browser delivery.

## Decision Drivers

The foundation should:

1. preserve Financial as the only balance authority;
2. reuse public module interfaces rather than query another module's tables;
3. distinguish authoritative quantities from indicative valuation;
4. perform derived arithmetic exactly and without implicit rounding;
5. make incomplete valuation visible instead of dropping assets or inventing prices;
6. include available and reserved quantities in total holdings;
7. avoid new persistence until a durable portfolio read model is justified; and
8. leave profit/loss, cost basis, charts, HTTP security, and browser presentation to focused work.

# Decision

Atlas will introduce a read-only Portfolio application module. It composes Financial wallet and
asset queries, Trading's market catalog, and Market Data's public committed-trade ticker through
their public module interfaces.

Portfolio owns no ledger accounts, balances, orders, executions, ticker rows, or migrations.

## 1. Snapshot ownership and scope

The initial snapshot is account scoped. Its owner identifier comes from a future authenticated HTTP
adapter and is passed to Financial's existing owner-scoped wallet query. Client-supplied owner
identifiers will not be accepted by that adapter.

Every owned wallet becomes one position containing exact available, reserved, and total quantities.
The Portfolio use case defensively requires:

~~~text
available + reserved = total
~~~

Reserved funds remain part of holdings even though they are temporarily unavailable for a new
command. The snapshot must not infer balances from orders or trades.

## 2. Initial valuation currency and market path

The initial valuation currency is fixed to `USD`. A positive USD wallet is cash with a reference
price of exactly `1`.

A positive non-USD position is eligible for valuation only through one non-disabled direct market:

~~~text
<ASSET>-USD
~~~

Both `active` and `cancel_only` markets remain eligible because either can still contain valid
committed price history. A disabled market is not an accepted current valuation path. Indirect
conversion, inverse markets, stablecoin equivalence, and external price providers are not inferred.

Multiple eligible direct markets for one asset are treated as an internal invariant failure rather
than selected arbitrarily.

## 3. Reference-price semantics

The reference price is the last committed Atlas trade in the accepted rolling ticker window. The
snapshot carries the market code, exact price, execution timestamp, and Market Data freshness.

When the market has no committed trade in that window, the positive position is `unpriced` with
reason `NO_REFERENCE_PRICE`. When no eligible direct market exists, it is `unpriced` with reason
`NO_VALUATION_MARKET`.

Portfolio does not substitute the best bid, best ask, candle close, order-entry price, previous
historical close, or an external market price. It does not claim the reference price is executable
for the complete holding.

## 4. Zero positions

A zero-total wallet has valuation status `zero`, exact value `0`, and requires no market-data read.
It does not make the portfolio incomplete. This preserves visible wallet ownership without treating
a nonexistent exposure as a missing-price risk.

## 5. Exact derived arithmetic

Portfolio multiplies canonical decimal quantity and price strings using integer coefficients and
explicit decimal scales. It sums derived USD values by aligning those scales. Binary floating-point
arithmetic is prohibited for valuation.

No implicit rounding to USD ledger scale occurs. For example:

~~~text
0.00000001 × 0.01 = 0.0000000001 USD
~~~

The transport permits up to 100 significant digits for a derived value. This is a bounded display
and interchange representation, not an increase to Financial's authoritative ledger limit.

## 6. Completeness and totals

The summary total is the exact sum of cash, valued, and zero-position values. An unpriced position
contributes no fabricated numeric value. Instead, the response lists every unpriced asset and sets:

~~~text
complete = unpricedAssetCodes.length === 0
~~~

Consumers must not label an incomplete total as the complete portfolio value. A later UI should use
copy such as "valued subtotal" when `complete` is false.

Positions and unpriced asset codes are unique and sorted by asset code so snapshots are deterministic
and contract reconciliation is straightforward.

## 7. No profit/loss or cost basis

This snapshot does not calculate realized profit/loss, unrealized profit/loss, acquisition cost,
percentage return, allocation percentage, or historical portfolio value. Atlas does not yet have an
accepted cost-basis policy for deposits, withdrawals, and executions. Adding those numbers now would
create false financial meaning.

## 8. Delivery boundary

The shared package defines the strict future response representation and validates balance,
valuation-market, ordering, completeness, and total reconciliation. The application capability and
exact arithmetic are implemented independently of Express.

Authenticated HTTP routing, cache policy, rate limiting, composition wiring, browser query state,
and portfolio presentation require subsequent slices. This decision does not make the application
capability publicly reachable yet.

## Alternatives Considered

### Calculate the portfolio only in the browser

Rejected because each client would need to reproduce exact arithmetic, market selection,
completeness, and missing-price policy. A server application capability gives those rules one owner.

### Persist a portfolio total

Rejected because balances and prices already have authoritative sources. A stored total would add
staleness, checkpointing, rebuild, and reconciliation work without a measured query bottleneck.

### Use JavaScript numbers and round to cents

Rejected because it introduces binary floating-point behavior and silently discards valid precision.
Presentation may format values later without changing the exact transport value.

### Use best bid, ask, or candle close when no last trade exists

Rejected because those values have different semantics and would conceal that the accepted reference
price is unavailable.

### Omit assets that cannot be priced

Rejected because the resulting total would look complete while excluding real holdings.

### Add an external price provider now

Rejected because Atlas has not accepted provider trust, availability, licensing, symbol mapping, or
fallback rules.

## Consequences

### Positive Consequences

- Portfolio cannot mutate or replace Financial balance authority.
- Exact holdings and indicative values remain semantically distinct.
- Positive unpriced assets are visible and make completeness machine-readable.
- Zero wallets do not trigger unnecessary ticker reads or false incompleteness.
- Reserved balances remain represented in total holdings.
- No schema migration, worker, or new durable projection is required.
- Deterministic strict contracts can protect the future HTTP and browser boundaries.

### Negative Consequences

- A positive holding may remain unpriced until Atlas records a direct USD trade.
- The rolling ticker window can make an inactive asset unpriced after its last trade ages out.
- The total is indicative and may not represent executable liquidation value.
- Only direct USD markets participate initially.
- Exact derived values can contain more fractional digits than ordinary currency presentation.
- Each positive eligible position requires a ticker query until a broader snapshot optimization is
  justified.

## Reconsider When

Review this decision when Atlas supports a different reporting currency, indirect conversion paths,
external reference prices, a durable cost-basis model, historical portfolio charts, many assets that
make query composition expensive, or an accepted portfolio projection with explicit checkpoints and
rebuild rules.

## Related Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-023 — Financial HTTP API and Error Contract](ADR-023-financial-http-api-and-error-contract.md)
- [ADR-027 — MVP Trading Market Catalog and Persistence Strategy](ADR-027-mvp-trading-market-catalog-and-persistence-strategy.md)
- [ADR-035 — Trade Ticker Projection Persistence and Window Semantics](ADR-035-trade-ticker-projection-persistence-and-window-semantics.md)
- [ADR-037 — Public Trade Ticker HTTP Contract](ADR-037-public-trade-ticker-http-contract.md)
