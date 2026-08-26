# ADR-029 — Public Trading HTTP API and Read Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-26  
**Last reviewed:** 2026-08-26  
**Canonical owner/source:** ADR-029

## Context

ADR-026 defines Atlas's limit-order, exact-value, matching, ownership, idempotency, and concurrency
semantics. ADR-027 defines the initial BTC-USD and ETH-USD catalog and durable Trading persistence.
ADR-028 defines Financial reservation, settlement, price-improvement, and release capabilities.
Those decisions are now implemented through transaction-bound place-order and cancel-order
application capabilities, but they are not exposed through a public transport contract.

Without a focused decision, route shape, authentication, CSRF, decimal serialization, owner-safe
reads, pagination, status codes, and public errors could become accidental controller behavior. The
transport must not expose lots, ticks, matching priority, reservation internals, other owners' order
identities, or persistence details.

This ADR defines the initial public market-catalog, order-command, owner-order, and owner-trade HTTP
surface. It does not define an order book, ticker, candles, market history, streaming transport,
administrative market controls, or a general Market Data projection architecture.

## Decision Drivers

The Trading HTTP boundary should:

1. preserve canonical decimal strings and exact lots/ticks semantics without exposing storage units;
2. derive order ownership exclusively from authenticated server context;
3. preserve placement and cancellation idempotency at the HTTP boundary;
4. hide another owner's order existence;
5. expose enough owner-scoped state for placement confirmation, open orders, cancellation, and trade
   history;
6. reuse Atlas's accepted authentication, CSRF, CORS, envelope, caching, and error conventions;
7. keep public market reference data distinct from future Market Data projections;
8. use stable bounded pagination rather than unbounded history responses;
9. avoid exposing Financial reservation, ledger, journal, or wallet-account construction;
10. remain implementable and independently testable as one coherent transport slice.

# Decision

Atlas will expose Trading resources under `/api/v1`. Public JSON schemas live in
`@atlas/contracts`. HTTP controllers validate transport input, invoke public Trading application
capabilities, and map results explicitly. Domain objects, Kysely rows, lots, ticks, internal
sequences, and Financial types do not cross the transport boundary.

## 1. Initial Endpoint Surface

| Operation | Method | Path | Authentication | CSRF |
| --- | --- | --- | --- | --- |
| List markets | GET | `/api/v1/markets` | No | No |
| Get market | GET | `/api/v1/markets/:marketCode` | No | No |
| Place order | POST | `/api/v1/orders` | Yes | Yes |
| List current user's orders | GET | `/api/v1/orders` | Yes | No |
| Get current user's order | GET | `/api/v1/orders/:orderId` | Yes | No |
| Cancel current user's order | DELETE | `/api/v1/orders/:orderId` | Yes | Yes |
| List current user's trades | GET | `/api/v1/trades` | Yes | No |

There is no public order update, price or quantity amendment, generic status mutation, trade
creation, trade deletion, reservation release, direct matching, order-book, ticker, candle, or
market-administration endpoint.

The same `/orders/:orderId` resource supports GET and DELETE. DELETE means owner cancellation of an
active residual; it does not delete the durable order fact.

## 2. Common Envelope and Boundary Rules

Successful JSON responses use the existing Atlas envelope:

```json
{
  "success": true,
  "data": {}
}
```

Errors use:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed.",
    "requestId": "..."
  }
}
```

Public messages are stable and non-sensitive. Responses never expose stack traces, SQL errors,
constraint names, owner IDs, raw idempotency keys, intent hashes, matching priority, row versions,
Financial reservation IDs or amounts, journal IDs, ledger-account IDs, or postings.

Requests and responses use JSON only where a body is defined. Schemas are strict and reject unknown
properties. Route parameters, headers, query parameters, and bodies are validated independently
before application execution.

## 3. Public Market Catalog

`GET /api/v1/markets` returns markets ordered by code:

```json
{
  "success": true,
  "data": {
    "markets": [
      {
        "code": "BTC-USD",
        "baseAssetCode": "BTC",
        "quoteAssetCode": "USD",
        "baseLotSize": "0.001",
        "priceTickSize": "10",
        "minimumQuantity": "0.001",
        "maximumQuantity": "10",
        "status": "active"
      }
    ]
  }
}
```

`GET /api/v1/markets/:marketCode` returns the same representation inside `data.market`.

All quantities and price increments are canonical decimal strings. `priceTickSize` is quote asset
per one whole base asset. The response never exposes atomic-unit counts, lot counts, tick counts,
database identifiers, or matching indexes.

Active, cancel-only, and disabled markets remain discoverable so existing orders and trades retain
an explainable denomination. Status controls new placement behavior; it does not hide history.

Market catalog responses use:

```text
Cache-Control: public, max-age=60, must-revalidate
```

This catalog is Trading reference data. It is not an order book, price, quote, last trade, spread,
volume, ticker, candle, or claim that current liquidity exists.

## 4. Placement Request

`POST /api/v1/orders` requires:

```text
Idempotency-Key: caller-generated-value
Content-Type: application/json
```

```json
{
  "marketCode": "BTC-USD",
  "side": "buy",
  "quantity": "0.001",
  "limitPrice": "50000"
}
```

The body is strict. `side` is exactly `buy` or `sell`. Quantity and limit price are canonical
unsigned decimal strings and must align exactly with the selected market's lot and price-tick
increments. The server never rounds.

Order type and time in force are fixed as `limit` and `good_til_cancelled`; clients do not send
them. Unknown fields are rejected, including `ownerId`, `userId`, `orderId`, `status`, `filled`,
`remaining`, `type`, `timeInForce`, `priority`, `version`, lots, ticks, wallet IDs, reservation
amounts, and settlement instructions.

The authenticated subject becomes the order owner. Both required market wallets must already exist.
Placement never silently creates a wallet.

## 5. Placement Idempotency and Response

Every placement requires exactly one `Idempotency-Key` header matching:

```text
^[A-Za-z0-9._:-]{1,200}$
```

Multiple fields, comma-folded values, missing values, surrounding whitespace, or values outside the
grammar are rejected. The key is scoped to the authenticated owner and place-order operation.

The HTTP contract preserves the application outcomes:

- first key and intent: `201 Created`;
- same key and canonical intent: `200 OK` with the original committed result;
- same key with a different canonical intent: `409 IDEMPOTENCY_CONFLICT`;
- concurrent identical requests: one order, one reservation, and one committed result.

Successful creation and replay return:

```text
Location: /api/v1/orders/:orderId
Cache-Control: no-store
```

```json
{
  "success": true,
  "data": {
    "order": {},
    "trades": []
  }
}
```

The order and trade representations are defined below. `trades` contains executions caused by this
placement in execution order. An unmatched order returns an empty array. A self-trade-prevention
result may return earlier valid executions followed by a cancelled order residual.

An identical retry returns the same durable order identity and its placement-caused taker
executions even if the market or an asset no longer accepts new placement. Because an order remains
a live resource after placement, its representation reflects the current committed lifecycle state
rather than a frozen copy of the original HTTP response. The retry never reserves or matches again.

## 6. Owner Order Representation

Order creation, lookup, listing, and cancellation use:

```json
{
  "id": "019...",
  "marketCode": "BTC-USD",
  "side": "buy",
  "type": "limit",
  "timeInForce": "good_til_cancelled",
  "quantity": "0.003",
  "limitPrice": "50000",
  "filledQuantity": "0.001",
  "remainingQuantity": "0.002",
  "status": "partially_filled",
  "terminalReason": null,
  "createdAt": "2026-08-26T00:00:00.000Z",
  "updatedAt": "2026-08-26T00:00:01.000Z"
}
```

Quantity and price fields are canonical decimal strings reconstructed from the market definition.
JSON numbers are prohibited. `terminalReason` is `owner_cancelled`, `self_trade_prevention`, or
`null`. Open, partially filled, and filled orders use `null`.

The representation does not contain owner ID because ownership is established by the authenticated
session. It does not expose original lots, remaining lots, limit ticks, acceptance priority,
idempotency identity, intent hash, persistence version, Financial reservation state, or another
owner's identifiers.

## 7. Cancellation Contract

`DELETE /api/v1/orders/:orderId` accepts no request body and requires no idempotency header. Order ID
is the durable cancellation and Financial release identity.

Cancellation is permitted while a market is active, cancel-only, or disabled and while an asset is
disabled because it only removes an existing commitment. It succeeds only for the authenticated
owner and only when the order has an active positive residual.

A newly committed cancellation returns `200 OK` with `data.order`. Repeating DELETE for the same
owner-cancelled order also returns `200 OK` with the same terminal representation and performs no
second Financial release.

A filled order or an order cancelled by self-trade prevention returns
`409 ORDER_NOT_CANCELLABLE`. A missing order and another owner's order both return
`404 ORDER_NOT_FOUND`; the API does not reveal cross-owner existence.

The response acknowledges success only after the Trading transition and exact Financial residual
release commit in one transaction. DELETE does not erase the order or its trades.

## 8. Owner-Scoped Order Reads

`GET /api/v1/orders/:orderId` returns `data.order` only when the authenticated subject owns the
order. A missing order and another owner's order both return `404 ORDER_NOT_FOUND`.

`GET /api/v1/orders` supports these optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `marketCode` | Exact canonical market code |
| `status` | One exact order status: `open`, `partially_filled`, `filled`, or `cancelled` |
| `limit` | Integer from 1 through 100; default 50 |
| `cursor` | Opaque continuation token returned by Atlas |

Orders are sorted by creation time descending, then ID descending. The response is:

```json
{
  "success": true,
  "data": {
    "orders": [],
    "page": {
      "nextCursor": null
    }
  }
}
```

Pagination is keyset-based and stable under concurrent inserts. Cursor structure is not a public
contract. A malformed cursor or a cursor reused with different filters returns
`400 VALIDATION_FAILED`. Responses never provide an unbounded mode or caller-selected sort.

The initial reader queries authoritative Trading order facts. It is not the matching authority and
does not require a separate projection store. A future projection may replace the reader without
changing this public representation.

## 9. Owner Trade Representation and Reads

`GET /api/v1/trades` returns executions involving an order owned by the authenticated subject. It
supports optional `marketCode`, `limit`, and `cursor` parameters with the same validation and limit
rules as order listing.

Trades are sorted by execution time descending, then immutable execution sequence descending. The
sequence is used internally for stable keyset pagination but is not returned.

Each trade is represented relative to the authenticated owner's participating order:

```json
{
  "id": "019...",
  "marketCode": "BTC-USD",
  "orderId": "019...",
  "side": "buy",
  "liquidityRole": "taker",
  "quantity": "0.001",
  "price": "49000",
  "quoteAmount": "49",
  "executedAt": "2026-08-26T00:00:01.000Z"
}
```

Quantity, price, and quote amount are canonical decimal strings reconstructed exactly from lots and
ticks. `liquidityRole` is `maker` or `taker` relative to the owner's order.

The representation does not expose the counterparty owner, counterparty order ID, buyer/seller IDs,
internal execution sequence, settlement journals, reservation movements, or matching internals.
Self-trade prevention guarantees that one trade cannot belong to two orders of the same owner.

The list response uses `data.trades` and `data.page.nextCursor` in the same shape as order listing.
An individual public trade lookup is deferred because the initial product journey needs history,
not a separately addressable trade detail resource.

## 10. Authentication, Ownership, CSRF, and CORS

Order and trade endpoints use the access-cookie authentication and account/session checks accepted
by ADR-017 and ADR-019. The trusted `AuthenticatedContext.userId` is the only owner identifier passed
to Trading.

```text
authenticated subject
        ↓
server-owned owner context
        ↓
owner-scoped Trading command or reader
```

Placement and cancellation require exact-origin validation and the session-bound CSRF cookie/header
check. Authenticated GET requests do not require CSRF. Market catalog GETs are public. CORS preflight
is unauthenticated and performs no Trading operation.

Credentialed CORS accepts only configured origins. Allowed request headers include `Content-Type`,
`X-CSRF-Token`, and `Idempotency-Key`. The client cannot choose or override authenticated ownership
through a path, body, query, or header field.

## 11. Validation and Exact Values

Market codes are canonical uppercase pairs. The server does not silently uppercase malformed
transport input. UUID route parameters must be valid. Unknown query parameters and duplicate scalar
query parameters are rejected.

Quantity and price examples for the initial BTC-USD definition include:

```text
accepted quantity:  "0.001", "1", "1.25"
rejected quantity:  0.001, "0.0010", "0.0001", "+1", "1e-3", " 1"

accepted price:     "50000", "50010"
rejected price:     50000, "50000.0", "50001", "+50000", "5e4"
```

Whether a canonical value satisfies a market increment or bound is authoritative server behavior.
Frontend validation is advisory only. No route accepts floating-point JSON numbers for an
authoritative Trading value.

## 12. Status and Error Mapping

Trading uses the established error envelope and request identifier:

| HTTP status | Error code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_FAILED` | Malformed path, query, header, JSON, market code, side, quantity, or price |
| 401 | `AUTHENTICATION_REQUIRED` | Missing, invalid, expired, or unusable authenticated session |
| 403 | `CSRF_FAILED` | Origin or session-bound CSRF validation failed |
| 403 | `FORBIDDEN` | Authenticated caller lacks an applicable Trading permission |
| 404 | `MARKET_NOT_FOUND` | Requested market does not exist |
| 404 | `ORDER_NOT_FOUND` | Order is missing or not owned by the authenticated subject |
| 404 | `WALLET_NOT_FOUND` | A required owner wallet does not exist |
| 409 | `MARKET_NOT_ACTIVE` | Market exists but does not accept new orders |
| 409 | `ASSET_UNAVAILABLE` | A market asset rejects new placement |
| 409 | `INSUFFICIENT_AVAILABLE_BALANCE` | Available balance cannot fund the maximum order reservation |
| 409 | `IDEMPOTENCY_CONFLICT` | Same owner/key was used for a different placement intent |
| 409 | `ORDER_NOT_CANCELLABLE` | Order is filled or terminal for a reason other than owner cancellation |
| 429 | `RATE_LIMITED` | Caller exceeded an applicable Trading operation limit |

Public errors do not include current balances, reservation amounts, hidden market storage values,
or another owner's resource facts. A client may refetch its wallets or order resources after a
state conflict.

Unexpected failures use the existing internal-error mapping. SQL states, deadlock details,
serialization errors, constraint names, internal invariant codes, and stack traces are never
returned directly. Retryable infrastructure failures may use the platform's generic temporary
failure response only when that mapping is defined consistently outside Trading.

## 13. Rate Limiting

Placement and cancellation receive separate owner-aware rate-limit policies. Exact thresholds and
storage are implementation decisions.

Placement limiting counts new idempotency intents rather than raw HTTP attempts. An identical key
within the active window remains retryable so a lost response can be recovered. Cancellation
limiting similarly permits an identical order ID retry while limiting new cancellation targets.

The initial bounded in-memory implementation is acceptable for the single-instance MVP. A
production-like multi-instance deployment must document per-instance semantics or use shared
bounded state. Rate limits do not replace balance checks, market serialization, idempotency,
authentication, CSRF, or future risk controls.

Ordinary abuse-oriented limits may protect market and owner-history reads. Pagination limits remain
mandatory even when request-rate limits are absent.

## 14. Cache, Content Type, and Request Size

All authenticated order and trade responses, including errors reached under those routers, use:

```text
Cache-Control: no-store
```

Market catalog responses use the short public cache policy in section 3.

Placement requires JSON. Cancellation and authenticated reads accept no request body. Unexpected
bodies are rejected. The existing global `32 KiB` JSON limit remains the upper bound; the placement
schema is substantially smaller.

## 15. Logging and Privacy

Structured logs may include request ID, route template, status, authenticated subject identifier
under the accepted privacy policy, market code, order or trade identifier after authorization,
result classification, and duration.

Logs must not contain authentication credentials, CSRF values, raw idempotency keys, request bodies,
quantity, price, quote amount, balances, reservation amounts, intent hashes, counterparty facts,
ledger identifiers, postings, or SQL details. Trading and Financial persistence remain the business
authorities; logs are operational evidence only.

## 16. Minimum Evidence

Implementation must prove:

- public market list and lookup expose exact canonical increments without atomic units, lots, ticks,
  or market-data claims;
- placement requires authentication, exact origin, session-bound CSRF, JSON, and exactly one valid
  idempotency header;
- placement ownership comes only from authenticated context and body schemas reject owner or
  internal fields;
- quantities and prices require canonical strings, exact increments, and accepted market bounds;
- new placement returns `201`, identical replay returns `200`, and both return the same durable order
  identity, location, and placement-caused taker executions while the order representation may
  reflect later committed lifecycle state;
- unavailable markets/assets, missing wallets, insufficient balance, and conflicting keys map to
  the accepted public errors without leaking balances or internals;
- cancellation requires authentication and CSRF, accepts no body, works in cancel-only/disabled
  states, and releases the exact residual once;
- repeated and concurrent cancellation returns a stable successful resource without another
  release;
- filled and self-trade-terminal orders map to `409`, while missing and cross-owner orders both map
  to `404`;
- owner order lookup/list and trade list never expose another owner's resources or counterparty
  identifiers;
- order and trade quantities, prices, and notionals are canonical JSON strings reconstructed exactly
  from committed lots and ticks;
- pagination is bounded, stable, owner-scoped, filter-bound, and rejects malformed cursors;
- authenticated responses use `Cache-Control: no-store` and market catalog responses use the
  accepted short public cache policy;
- retry-preserving rate limits allow identical placement keys and cancellation targets while
  limiting new intents;
- controller tests verify validation and result mapping independently of PostgreSQL;
- real-PostgreSQL HTTP integration proves authenticated ownership, committed placement, matching,
  settlement, cancellation release, replay behavior, and owner-safe reads;
- no response or log exposes raw keys, owner IDs, counterparty facts, priority, versions,
  reservations, journals, accounts, postings, or persistence errors.

# Alternatives Considered

## Nest Orders Under Markets

Rejected because orders are owner resources with stable identifiers and lifecycle operations across
market views. Market is still required in placement and available as a list filter.

## Expose Lots and Ticks Directly

Rejected because those are market-specific persistence and arithmetic units. Canonical decimal
strings are the product contract and remain exact without teaching clients storage representation.

## Accept Owner ID or Wallet ID

Rejected because authenticated context and market assets determine ownership and required wallets.
Caller-selected identities create confused-deputy and cross-owner risks.

## Require a Separate Cancellation Idempotency Key

Rejected because one order permits one accepted terminal release. Order ID plus owner and accepted
reason already form the durable idempotency identity.

## Return `204 No Content` for Cancellation

Rejected because the browser needs the committed terminal order representation and repeat behavior.
Returning the resource keeps new and repeated cancellation outcomes consistent.

## Expose Counterparty Order IDs in Trade History

Rejected because they are unnecessary for the owner's history and leak another user's resource
identity. The response is intentionally relative to the authenticated owner's order.

## Add Order Book, Ticker, and Candles Now

Rejected because those are Market Data projections with different freshness, caching, aggregation,
and scaling concerns. The Trading command/read contract must not accidentally become that
architecture.

## Return Unbounded Order and Trade History

Rejected because history grows monotonically. Bounded keyset pagination provides predictable query
and response cost from the first public release.

# Consequences

## Positive Consequences

- Trading commands preserve exact domain and Financial semantics at the public boundary.
- Browser placement, cancellation, open-order, and trade-history workflows have explicit contracts.
- Owner identity cannot be selected by clients, and cross-owner order existence remains hidden.
- Idempotent recovery behavior is consistent across application, persistence, and HTTP layers.
- Canonical decimal representations avoid floating-point ambiguity and storage-unit coupling.
- Stable pagination prevents owner history endpoints from becoming unbounded queries.
- Market catalog reference data remains clearly separated from future price projections.

## Negative Consequences

- Controllers require explicit mapping between decimal representations and internal lots/ticks.
- Placement responses containing executions are more involved than returning only an order ID.
- Owner-relative trade representations require joins and market reconstruction.
- Cursor/filter binding and retry-preserving rate limits add implementation work.
- The initial HTTP interface has no live order book, streaming updates, or market-price surface.

# Deferred Decisions

This ADR does not decide:

1. order-book depth, ticker, last trade, candles, volume, spread, or historical market projections;
2. polling intervals, Server-Sent Events, WebSocket protocols, subscriptions, or reconnect rules;
3. exact cursor encoding, signing, or storage implementation;
4. exact rate-limit thresholds or shared production rate-limit infrastructure;
5. browser order-entry, confirmation, optimistic-state, notification, or history presentation;
6. administrative market status changes, limit changes, or mass cancellation;
7. maker/taker fees or fee representation;
8. order amendments, market orders, additional time in force, margin, leverage, or short selling;
9. public individual-trade lookup or downloadable statements;
10. a separate read-model database, event stream, or dedicated matching service.

# Reconsider When

Review this decision when browser polling cannot meet freshness requirements, owner-history volume
requires dedicated projections, public market data needs a different caching/SLA boundary, trading
permissions become more granular, fees alter order/trade representations, or new order types cannot
fit the fixed placement contract without ambiguity.

# Relationship to Other Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-023 — Financial HTTP API and Error Contract](ADR-023-financial-http-api-and-error-contract.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [ADR-027 — MVP Trading Market Catalog and Persistence Strategy](ADR-027-mvp-trading-market-catalog-and-persistence-strategy.md)
- [ADR-028 — Financial Reservation, Release, and Trade Settlement Capabilities](ADR-028-financial-reservation-release-and-trade-settlement-capabilities.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

The public Trading contracts are accepted. Shared contract schemas, owner-scoped readers, HTTP
composition, controller mapping, rate limiting, and database-backed transport verification may now
be implemented. Market Data projections and browser workflows remain separately gated.
