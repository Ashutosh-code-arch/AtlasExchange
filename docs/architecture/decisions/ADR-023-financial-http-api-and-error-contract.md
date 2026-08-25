# ADR-023 — Financial HTTP API and Error Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-25  
**Last reviewed:** 2026-08-25  
**Canonical owner/source:** ADR-023

## Context

ADR-020 defines Atlas's financial accounting authority. ADR-021 provisions the MVP asset catalog,
and ADR-022 defines the simulated-deposit lifecycle and custody boundary. The API now has application
capabilities for wallet creation, authoritative balance reads, and atomic simulated deposits, but
none is exposed through an accepted public transport contract.

Without a focused HTTP decision, route shape, authentication, ownership, idempotency, decimal
serialization, status codes, and public errors could become accidental properties of controllers.
The transport must preserve Financial authority without allowing clients to select owners, ledger
accounts, postings, or internal journal behavior.

This decision defines the initial asset, wallet, balance, and simulated-deposit HTTP surface. It does
not define withdrawal endpoints, deposit-history pagination, trading endpoints, administrative asset
management, or real custody integration.

## Decision Drivers

The initial Financial HTTP boundary should:

1. preserve canonical decimal strings for authoritative quantities;
2. derive wallet and deposit ownership only from authenticated server context;
3. make simulated-deposit retries explicit and safe at the HTTP boundary;
4. expose product resources without exposing accounting internals;
5. reuse the accepted Identity authentication, cookie, CSRF, CORS, and error conventions;
6. distinguish creation from idempotent replay through normal HTTP semantics;
7. keep missing and unavailable resources understandable without leaking another user's data;
8. remain small enough to implement and test as one coherent slice;
9. make simulation status impossible to mistake for external settlement;
10. leave withdrawal and real-custody contracts to their own lifecycle decisions.

# Decision

Atlas will expose resource-oriented Financial endpoints under `/api/v1`. Internal module names,
ledger-account kinds, and journal construction are not part of the public URL or JSON contract.

## 1. Initial Endpoint Surface

| Operation | Method | Path | Authentication | CSRF |
| --- | --- | --- | --- | --- |
| List assets | GET | `/api/v1/assets` | No | No |
| List current user's wallets | GET | `/api/v1/wallets` | Yes | No |
| Get wallet and balances | GET | `/api/v1/wallets/:assetCode` | Yes | No |
| Create or resolve wallet | PUT | `/api/v1/wallets/:assetCode` | Yes | Yes |
| Create simulated deposit | POST | `/api/v1/deposits/simulated` | Yes | Yes |
| Get simulated deposit | GET | `/api/v1/deposits/:depositId` | Yes | No |

There is no public wallet delete, direct balance mutation, posting, journal, custody-account, fee
account, or arbitrary transfer endpoint.

`PUT /wallets/:assetCode` is idempotent by resource identity because Financial permits at most one
wallet per authenticated owner and asset. It does not require a separate idempotency key.

The deposit collection initially exposes creation and lookup by identifier. Deposit-history listing
and pagination remain deferred until the product has a concrete history surface.

## 2. Common JSON Envelope

Successful JSON responses use the established Atlas envelope:

```json
{
  "success": true,
  "data": {}
}
```

Errors use the established envelope:

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

The request identifier comes from the canonical request-correlation boundary. Public messages are
stable and non-sensitive. Stack traces, SQL errors, internal constraint names, account identifiers,
intent hashes, and journal details are never returned.

Shared request and response schemas live in `@atlas/contracts`. Controllers validate transport input
before calling Financial and map application results explicitly; persistence rows and Kysely types do
not cross the module boundary.

## 3. Asset Catalog Contract

`GET /api/v1/assets` returns the committed ledger catalog:

```json
{
  "success": true,
  "data": {
    "assets": [
      {
        "code": "BTC",
        "displayName": "Bitcoin",
        "ledgerScale": 8,
        "status": "active"
      }
    ]
  }
}
```

Assets are ordered by code. Both `active` and `disabled` catalog assets remain discoverable so
historical wallets and deposits retain an explainable denomination. `status` determines whether a
new wallet or deposit is allowed; it does not hide financial history.

The asset catalog is public because it contains no user or custody secret. It exposes only ledger
identity from ADR-021. It does not expose system-account IDs, addresses, networks, token contracts,
provider metadata, prices, market increments, or claims of external support.

The initial response uses `Cache-Control: public, max-age=60, must-revalidate`. A catalog mutation or
administrative API requires a separate decision; no browser request can add or edit an asset.

## 4. Wallet Contracts

`GET /api/v1/wallets` returns only wallets owned by the authenticated subject, ordered by asset code:

```json
{
  "success": true,
  "data": {
    "wallets": [
      {
        "id": "019...",
        "assetCode": "BTC",
        "available": "1.25",
        "reserved": "0",
        "total": "1.25"
      }
    ]
  }
}
```

`GET /api/v1/wallets/:assetCode` returns the same wallet representation inside `data.wallet`.
Balances are derived from committed postings and serialized as canonical decimal strings. JSON
numbers are prohibited for available, reserved, total, deposit amount, or any future authoritative
Financial quantity.

`PUT /api/v1/wallets/:assetCode` has no request body. It creates the wallet and its account pair when
absent or returns the existing wallet when present:

- `201 Created` for a newly created wallet;
- `200 OK` for an existing wallet;
- `Location: /api/v1/wallets/:assetCode` for either successful result.

The response uses `data.wallet` and includes zero balances for a newly created wallet. The owner ID is
not accepted in the route/body and is not needed in the representation because ownership is already
established by the authenticated session.

Wallet IDs are opaque resource identifiers. Available-account and reserved-account IDs are internal
Financial details and are never returned.

## 5. Simulated Deposit Creation Contract

`POST /api/v1/deposits/simulated` requires:

```text
Idempotency-Key: caller-generated-value
Content-Type: application/json
```

```json
{
  "assetCode": "BTC",
  "amount": "1.25"
}
```

The JSON body is strict: unknown fields are rejected. In particular, it cannot contain `ownerId`,
`userId`, `walletId`, `accountId`, `journalId`, `status`, `method`, postings, or accounting
directions. The owner comes exclusively from the authenticated context.

The `Idempotency-Key` header must be exactly one value matching
`^[A-Za-z0-9._:-]{1,200}$`. Multiple header values, comma-folded values, missing values, or values
outside that grammar are rejected. The key is scoped to the authenticated subject and
simulated-deposit operation as defined by ADR-022.

Successful creation returns `201 Created`. An identical replay returns `200 OK` and the original
resource. Both return:

```text
Location: /api/v1/deposits/:depositId
Cache-Control: no-store
```

```json
{
  "success": true,
  "data": {
    "deposit": {
      "id": "019...",
      "walletId": "019...",
      "assetCode": "BTC",
      "amount": "1.25",
      "method": "simulated",
      "status": "credited",
      "creditedAt": "2026-08-25T00:00:00.000Z"
    }
  }
}
```

The public resource deliberately says `simulated` and `credited`. It does not claim that Atlas
received, confirmed, settled, or reconciled an external asset. Journal IDs, custody-account IDs,
postings, and intent hashes remain private.

The server acknowledges success only after the wallet, deposit, journal, and postings commit. The
frontend must not optimistically add to the displayed balance before the successful response.

## 6. Simulated Deposit Lookup

`GET /api/v1/deposits/:depositId` returns the same `data.deposit` representation for a deposit owned by
the authenticated subject.

A nonexistent identifier and an identifier belonging to another subject both return
`404 DEPOSIT_NOT_FOUND`. The API does not reveal cross-user deposit existence. Deposit lookup does not
expose the idempotency key.

This endpoint provides resource recovery after a client receives a successful creation response. A
client recovering from an ambiguous POST failure should first retry the POST with the same
idempotency key; it cannot guess a deposit ID it never received.

## 7. Authentication, Ownership, and CSRF

Wallet, balance, and deposit endpoints use the access-cookie authentication and account/session checks
from ADR-017 and ADR-019. The trusted `AuthenticatedContext.userId` is passed to Financial as the
owner identifier.

For every authenticated Financial request:

```text
authenticated subject
        ↓
server-owned owner context
        ↓
owner-scoped Financial capability
```

Routes never load a resource and then trust a client assertion of ownership. Readers query by both
resource identity and authenticated owner where applicable.

Authenticated mutations require the existing exact-origin validation and session-bound CSRF
cookie/header check. Authenticated GET requests do not require CSRF. Asset listing is public and does
not require CSRF. CORS preflight remains unauthenticated and performs no Financial operation.

The allowed request headers must explicitly include `Content-Type`, `X-CSRF-Token`, and
`Idempotency-Key` for approved origins. Credentialed CORS never reflects arbitrary origins.

## 8. Validation and Canonical Values

Asset codes use the canonical uppercase Financial format. The server does not silently uppercase
malformed path or body input. Deposit amounts must be canonical unsigned decimal strings, strictly
positive, within the asset's ledger scale, and within the 38-atomic-digit limit.

Examples:

```text
accepted for BTC:  "1", "1.25", "0.00000001"
rejected:          1.25, "01", "1.0", "+1", "1e-8", "0", "-1"
```

The server remains authoritative for scale and asset status. Frontend validation may improve user
feedback but is not a Financial control.

Route parameters, headers, and JSON bodies are validated independently. Unknown JSON properties and
malformed UUIDs are rejected before application execution.

## 9. Status and Error Mapping

Initial Financial mappings are:

| HTTP status | Error code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_FAILED` | Malformed path, header, body, asset code, or amount |
| 401 | `AUTHENTICATION_REQUIRED` | Missing, invalid, or expired authenticated session |
| 403 | `CSRF_FAILED` | Origin or session-bound CSRF validation failed |
| 403 | `FORBIDDEN` | Authenticated caller lacks an applicable permission |
| 404 | `ASSET_NOT_FOUND` | Requested asset does not exist |
| 404 | `WALLET_NOT_FOUND` | Current subject has no wallet for the asset |
| 404 | `DEPOSIT_NOT_FOUND` | Deposit is missing or not owned by the current subject |
| 409 | `ASSET_UNAVAILABLE` | Asset exists but rejects new wallet/deposit operations |
| 409 | `IDEMPOTENCY_CONFLICT` | Same owner/key was used for a different deposit intent |
| 429 | `RATE_LIMITED` | Caller exceeded an applicable operation limit |
| 503 | `SIMULATED_FUNDING_UNAVAILABLE` | Simulated funding is operationally disabled |

Unexpected failures use the existing internal-error mapping and request identifier. PostgreSQL error
codes and constraint names are never translated directly into public messages.

`SIMULATED_FUNDING_UNAVAILABLE` may include `Retry-After` only when the server has a concrete recovery
interval. Historical deposit reads and identical idempotent retries remain available when new funding
is disabled, as required by ADR-022.

## 10. Cache, Content Type, and Request Size

All authenticated wallet, balance, and deposit responses use:

```text
Cache-Control: no-store
```

The asset catalog uses the short public cache policy in section 3. Authenticated Financial responses
must not be stored in shared or browser HTTP caches.

The simulated-deposit POST requires JSON. The wallet PUT has no body and does not require a JSON
content type. Unexpected bodies are rejected. The existing global `32 KiB` JSON request limit remains
the upper bound; route schemas are much smaller.

## 11. Rate Limiting and Logging

Simulated-deposit creation is rate-limited because it is an authenticated value-creation capability,
even though the value is explicitly simulated. Exact thresholds and storage are implementation
decisions, but limits must be owner-aware and must not weaken idempotent retry behavior.

Asset and wallet reads may receive ordinary abuse-oriented limits. Rate limiting must not use
unbounded process-local state in production-like multi-instance deployments without documenting the
resulting semantics.

Structured logs may include request ID, route template, status, authenticated subject identifier
under the accepted privacy policy, asset code, result classification, and duration. Logs must not
contain authentication credentials, CSRF values, raw idempotency keys, financial request bodies,
intent hashes, or pretend to be the balance authority. The journal remains authoritative.

## 12. Minimum Evidence

Implementation must prove:

- the public asset catalog maps committed assets without system-account details;
- authenticated wallet list and lookup return only the current subject's resources;
- wallet PUT returns `201` for creation, `200` for reuse, and consistent zero/current balances;
- wallet and deposit requests cannot select another owner;
- all authoritative quantities are JSON strings and reject JSON numbers;
- deposit creation requires authentication, exact origin, CSRF, JSON, and one idempotency header;
- a created deposit returns `201`, a retry returns `200`, and both return the same resource/location;
- conflicting idempotency reuse returns `409` without another financial effect;
- missing, disabled, and operationally unavailable assets map to the accepted errors;
- deposit lookup hides cross-user resource existence;
- Financial responses use the accepted cache policy and request-error envelope;
- no public response exposes account IDs, postings, journal IDs, intent hashes, or persistence errors;
- controller tests verify result mapping independently of PostgreSQL;
- real-PostgreSQL HTTP integration proves authentication-to-owner propagation and committed balances.

# Alternatives Considered

## Expose a Generic Journal-Posting Endpoint

Rejected because it would let transport callers construct accounting behavior and bypass narrow
Financial capabilities.

## Accept Owner or Wallet Identifiers in Deposit Requests

Rejected because browser-selected ownership creates an authorization hazard. The authenticated
subject and Financial wallet resolution are authoritative.

## Put the Idempotency Key in the JSON Body

Rejected because idempotency is request-execution metadata shared by retry infrastructure. A required
header keeps it distinct from the immutable deposit intent while the database still persists its
owner-scoped identity.

## Return `202 Accepted` for Simulated Deposits

Rejected because the MVP operation is synchronous and has no background confirmation lifecycle.
Success means the balanced journal has committed.

## Return `201` for Identical Replays

Rejected because the replay did not create another resource. `200` communicates successful retrieval
of the original effect while preserving the same body and `Location`.

## Require Explicit Wallet Creation Before Deposit

Rejected by ADR-022. Deposit creation may atomically provision the wallet, while the explicit wallet
PUT remains available for users who want a zero-balance wallet before funding.

## Expose Owner IDs and Ledger Account IDs

Rejected because owner is implicit in the authenticated context and accounting account identifiers
are not product capabilities.

## Hide Disabled Assets from the Catalog

Rejected because historical wallets and deposits still require a visible denomination and status.

## Add Deposit-History Pagination Immediately

Rejected because creation and resource lookup are sufficient for the first transport slice. History
query shape should follow a concrete product surface and pagination policy.

# Consequences

## Positive Consequences

- The browser receives a small, explicit, owner-safe Financial API.
- Decimal and idempotency behavior is consistent across transport and application layers.
- Public resources remain separate from accounting implementation details.
- HTTP statuses distinguish creation, replay, conflict, absence, and operational disablement.
- Simulated value cannot be presented as provider-confirmed custody through this contract.
- Contract schemas can drive API and frontend implementation together.

## Negative Consequences

- Wallet representations require authoritative balance queries.
- Deposit lookup requires a new owner-scoped reader.
- Public and authenticated cache policies differ by route class.
- The idempotency header and CSRF header both require explicit CORS configuration.
- Deposit history, withdrawal, and administration remain unavailable.

# Deferred Decisions

This ADR does not decide:

1. deposit-history filtering, cursor pagination, and retention presentation;
2. withdrawal HTTP contracts and lifecycle;
3. trading, order, trade, or market-data endpoints;
4. administrative asset or simulated-funding endpoints;
5. real custody addresses, networks, confirmations, and provider webhooks;
6. deposit limits, compliance holds, or administrative adjustments;
7. exact rate-limit thresholds and distributed limiter implementation;
8. ETag or conditional-request support for the asset catalog;
9. a generalized API idempotency standard for non-Financial operations;
10. version negotiation beyond the existing `/api/v1` prefix.

# Reconsider When

Review this decision when Atlas introduces real external deposits, asynchronous deposit states,
withdrawals, deposit-history product surfaces, cross-site web/API deployment, machine-to-machine API
clients, administrative financial operations, or a broader API idempotency standard.

# Relationship to Other Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-021 — MVP Asset Catalog and System-Account Provisioning](ADR-021-mvp-asset-catalog-and-system-account-provisioning.md)
- [ADR-022 — Simulated Deposit Lifecycle and Custody Boundary](ADR-022-simulated-deposit-lifecycle-and-custody-boundary.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
