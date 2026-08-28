# ADR-045 — Authenticated Portfolio HTTP Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-28  
**Canonical owner/source:** ADR-045

## Context

ADR-044 defines the exact Portfolio snapshot application capability and strict shared response
representation. That capability is not yet reachable through the composed API. Atlas now needs an
authenticated HTTP boundary that derives ownership from the server-confirmed session, protects
private balances from caches, bounds repeated composed reads, and contains internal invariant
failures without weakening Portfolio's explicit incomplete-valuation semantics.

The endpoint is read-only. It does not mutate balances, prices, markets, or portfolio state and does
not need a new persistence schema. Its contract must distinguish a valid incomplete snapshot from a
server failure: missing valuation markets or reference prices are successful Portfolio data, not
HTTP errors.

## Decision Drivers

The delivery boundary should:

1. derive the owner exclusively from authenticated server context;
2. expose no owner, session, wallet, ledger, order, trade, or projection identifiers;
3. accept no client-selected valuation currency, owner, query mode, or hidden request body;
4. prevent shared or browser intermediary caching of private balances;
5. validate the complete application response before transmission;
6. bound composed reads independently per authenticated owner;
7. return safe stable errors and useful retry metadata; and
8. preserve the read-only application and module boundaries accepted by ADR-044.

# Decision

Atlas will expose:

~~~text
GET /api/v1/portfolio
~~~

The endpoint requires a valid Atlas access session and returns the strict Portfolio snapshot defined
by ADR-044.

## 1. Authentication and ownership

The existing access-session middleware authenticates the request before Portfolio validation or
rate-limit admission. The HTTP adapter reads `userId` from the authenticated context and invokes:

~~~text
GetPortfolioSnapshot.execute({ ownerId: authenticatedContext.userId })
~~~

The endpoint has no owner path parameter, query parameter, or request field. Self-registration roles
do not change owner isolation; any authenticated account can read only its own snapshot.

An invalid or expired access credential returns `401 AUTHENTICATION_REQUIRED`. Unauthenticated
requests consume no Portfolio rate-limit capacity and perform no Financial, Trading, or Market Data
read.

## 2. Request contract

The accepted query is a strict empty object. The route also rejects any request body, including an
otherwise valid JSON object. Unknown query parameters such as `ownerId`, `currency`, or `include`
return `400 VALIDATION_FAILED` before rate-limit admission.

This keeps the first contract deterministic: USD valuation, position inclusion, reference-price
policy, and completeness are server-owned rules rather than client switches.

## 3. Success response

A successful request returns `200` with:

~~~text
{
  "success": true,
  "data": {
    "valuationCurrency": "USD",
    "generatedAt": "...",
    "positions": [...],
    "summary": {
      "totalValue": "...",
      "unpricedAssetCodes": [...],
      "complete": true | false
    }
  }
}
~~~

The shared contract validates unique sorted positions, exact available/reserved/total reconciliation,
status-specific valuation fields, direct market identity, exact quantity-times-price values, summary
addition, unpriced assets, and completeness.

An empty account returns an empty position list, exact total `0`, and `complete: true`. A positive
holding without an accepted price returns `200` with an `unpriced` position and `complete: false`.
Neither case is a transport failure.

## 4. Privacy and caching

Every `/portfolio` response, including errors, carries:

~~~text
Cache-Control: no-store
~~~

The response omits owner ID, session ID, wallet ID, ledger accounts, journal references, orders,
executions, projection generations, and internal atomic-unit values. The route does not accept or
echo access credentials.

No CSRF token is required because this `GET` route has no state-changing behavior. Authentication
cookies retain the security rules accepted by ADR-019.

## 5. Rate limiting

Portfolio reads are limited to 60 admitted requests per authenticated owner per one-minute
process-local window. Owner identifiers are SHA-256 digested before becoming limiter
keys, and tracked windows are bounded.

The initial limiter is deliberately process local, matching current single-process deployment. When
capacity is exhausted, the route returns:

~~~text
429 RATE_LIMITED
Retry-After: <positive seconds>
~~~

The application capability is not invoked for a rejected request. Horizontal deployment requires a
shared limiter or an explicitly accepted per-replica policy.

## 6. Error contract

The Portfolio error vocabulary is:

- `AUTHENTICATION_REQUIRED` → `401`;
- `VALIDATION_FAILED` → `400`;
- `RATE_LIMITED` → `429`; and
- `INTERNAL_SERVER_ERROR` → `500`.

Errors contain only a safe message and request identifier. Shared response validation failures,
upstream module contradictions, arithmetic overflow, database errors, and impossible catalog or
market states are logged internally and return the generic `500` representation.

No `WALLET_NOT_FOUND` or `MARKET_NOT_FOUND` error is exposed. Wallet absence produces no position;
an absent accepted valuation path is represented inside successful Portfolio data.

## 7. Composition and module boundaries

Financial, Trading, and Market Data expose reusable public query factories. The Portfolio module
composes those public application capabilities and never imports their repositories or reads their
tables directly.

The production composition root creates the Portfolio router with the same PostgreSQL resource and
access authenticator used by the existing modules. Portfolio adds no database tables, migrations,
workers, transaction authority, or framework dependency to its application use case.

## 8. Snapshot coherence

The response is a composed operational view, not an accounting statement or globally atomic
database snapshot. Financial balances and Market Data prices each follow their owning read
semantics, and a concurrent settlement or projection update can occur between source reads.

`generatedAt`, each reference price's execution timestamp, and Market Data freshness make the
different time meanings explicit. A future globally repeatable-read Portfolio transaction requires a
separate decision because it would change public module transaction boundaries.

## Alternatives Considered

### Put owner ID in the path or query

Rejected because ordinary users have no legitimate need to select another owner and accepting the
field would create an avoidable authorization surface.

### Cache snapshots privately for a short period

Rejected initially because private balance responses should not enter browser or intermediary
caches until Atlas has accepted invalidation and staleness behavior.

### Require CSRF for the read

Rejected because the route is side-effect free. Same-origin and credential rules still apply, while
CSRF remains mandatory for state-changing cookie-authenticated commands.

### Return 404 when no wallets exist

Rejected because an empty portfolio is a valid account state with a deterministic empty snapshot.

### Return an HTTP error when any asset is unpriced

Rejected because this would discard useful exact balances and priced subtotal information. Missing
valuation is data with explicit completeness semantics.

### Let Portfolio query source tables directly

Rejected because it would bypass module ownership and couple one product surface to three persistence
implementations.

## Consequences

### Positive Consequences

- The owner cannot be selected or overridden by the client.
- Private balances are never intentionally cached.
- Missing prices remain truthful successful data rather than hidden transport failures.
- Strict response validation protects the external boundary from internal contradictions.
- Per-owner rate limiting bounds multi-query composition without penalizing unrelated accounts.
- Public query factories preserve module boundaries and can support later product compositions.
- Real-PostgreSQL HTTP tests prove balance, price, owner-isolation, and transport behavior together.

### Negative Consequences

- Every admitted request composes multiple source reads and does not use a global transaction.
- Process-local limiting is not globally exact across future replicas.
- `no-store` prevents conditional requests and browser cache reuse.
- Clients cannot choose another valuation currency or response subset.
- A source invariant failure makes the whole HTTP response unavailable even if some positions could
  be rendered.

## Reconsider When

Review this decision when Portfolio reads require a coherent cross-module database snapshot,
horizontal replicas require shared limiting, response cost justifies server-side caching, users can
select reporting currencies, administration needs authorized account lookup, or a private realtime
Portfolio protocol is accepted.

## Related Decisions

- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-023 — Financial HTTP API and Error Contract](ADR-023-financial-http-api-and-error-contract.md)
- [ADR-037 — Public Trade Ticker HTTP Contract](ADR-037-public-trade-ticker-http-contract.md)
- [ADR-044 — Portfolio Snapshot and Valuation Foundation](ADR-044-portfolio-snapshot-and-valuation-foundation.md)
