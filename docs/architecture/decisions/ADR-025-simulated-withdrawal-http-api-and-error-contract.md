# ADR-025 — Simulated Withdrawal HTTP API and Error Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-25  
**Last reviewed:** 2026-08-25  
**Canonical owner/source:** ADR-025

## Context

ADR-024 defines and implements Atlas's synchronous simulated-withdrawal lifecycle. Financial can
atomically debit an authenticated owner's available balance, preserve reserved value, persist an
immutable withdrawal resource, and resolve retries safely under concurrent requests. That
capability is not yet reachable through the public API.

ADR-023 establishes the current Financial transport conventions for authentication, session-bound
CSRF, strict JSON, canonical decimal strings, idempotency headers, cache policy, response envelopes,
owner-safe lookup, rate limiting, and error mapping. Withdrawal exposure should extend those
conventions without creating a generic money-movement endpoint or suggesting that Atlas transmits
real assets.

This decision defines the initial simulated-withdrawal creation and lookup HTTP contract. It does
not define withdrawal history, browser presentation, notifications, fees, approval, real
destinations, external custody, or asynchronous withdrawal states.

## Decision Drivers

The withdrawal HTTP boundary should:

1. expose the accepted ADR-024 lifecycle without weakening its ownership or accounting rules;
2. make simulation impossible to confuse with external transmission;
3. preserve exact decimal strings and reject JSON numbers for authoritative quantities;
4. make client retries explicit, recoverable, and safe;
5. distinguish insufficient available funds from malformed input and unavailable operations;
6. hide cross-owner resource existence;
7. reject destinations, fees, wallet identifiers, and accounting construction that do not belong to
   the simulated lifecycle;
8. reuse the accepted authentication, CSRF, cache, CORS, envelope, and logging conventions;
9. avoid coupling creation to balance-read or history response shapes;
10. remain small enough to implement and verify as one coherent slice.

# Decision

Atlas will add two authenticated withdrawal endpoints under `/api/v1`:

| Operation | Method | Path | Authentication | CSRF |
| --- | --- | --- | --- | --- |
| Create simulated withdrawal | POST | `/api/v1/withdrawals/simulated` | Yes | Yes |
| Get simulated withdrawal | GET | `/api/v1/withdrawals/:withdrawalId` | Yes | No |

There is no public withdrawal update, delete, cancel, approve, fee, destination, broadcast,
confirmation, generic transfer, or direct balance-mutation endpoint.

## 1. Creation Request

`POST /api/v1/withdrawals/simulated` requires:

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

The JSON object is strict. Unknown properties are rejected, including `ownerId`, `userId`,
`walletId`, `accountId`, `journalId`, `status`, `method`, `fee`, `destination`, `address`, `network`,
`memo`, `transactionHash`, postings, or accounting directions.

Ownership comes exclusively from the authenticated server context. Financial resolves the current
subject's wallet and its available account from `assetCode`; the client cannot choose either.

The amount must be a canonical unsigned decimal string, strictly positive, within the asset's ledger
scale, and within the 38-atomic-digit limit. JSON numbers, exponent notation, signs, whitespace,
leading zeroes, and redundant trailing fractional zeroes are rejected under the same canonical rules
as simulated deposits.

The request contains no destination because this lifecycle performs no external transfer. It
contains no fee because ADR-024 defines the MVP simulated withdrawal fee as zero and no fee resource
exists.

## 2. Idempotency Header

Every creation request requires exactly one `Idempotency-Key` header matching:

```text
^[A-Za-z0-9._:-]{1,200}$
```

Multiple header fields, comma-folded values, missing values, surrounding whitespace, or values
outside that grammar are rejected. The key is scoped to the authenticated owner and
simulated-withdrawal operation. It does not collide with a deposit key or another owner's key.

The HTTP contract preserves ADR-024's outcomes:

- first key and intent: `201 Created` with the new withdrawal;
- same key and same intent: `200 OK` with the original withdrawal;
- same key and different intent: `409 IDEMPOTENCY_CONFLICT`;
- concurrent identical requests: one resource and one debit.

Both successful creation and replay return the same `Location` and representation. A retry never
uses a client-selected withdrawal identifier and never performs a second debit.

## 3. Successful Withdrawal Representation

Creation and lookup return the common success envelope:

```json
{
  "success": true,
  "data": {
    "withdrawal": {
      "id": "019...",
      "walletId": "019...",
      "assetCode": "BTC",
      "amount": "1.25",
      "method": "simulated",
      "status": "completed",
      "completedAt": "2026-08-25T00:00:00.000Z"
    }
  }
}
```

Authoritative quantities are JSON strings. The response contains no owner ID because ownership is
implicit in the authenticated session. It contains no fee field because no fee was charged and no
fee fact exists.

The representation must not contain journal IDs, ledger-account IDs, custody-account IDs, postings,
intent hashes, raw idempotency keys, destinations, addresses, networks, transaction hashes, provider
references, confirmations, approval state, or a claim that an external asset moved.

The combination of the `/simulated` command path, `method: "simulated"`, and the ADR-024 product-copy
rule is mandatory. `status: "completed"` means Atlas committed the simulated balance movement; it
does not mean a blockchain, bank, or provider transfer completed.

## 4. Creation Response Semantics

A newly created withdrawal returns:

```text
201 Created
Location: /api/v1/withdrawals/:withdrawalId
Cache-Control: no-store
```

An identical replay returns:

```text
200 OK
Location: /api/v1/withdrawals/:withdrawalId
Cache-Control: no-store
```

The server acknowledges success only after the withdrawal, journal, and postings commit. The
frontend must not optimistically subtract from the displayed balance before receiving success.

The response does not embed a wallet balance. Wallet state remains available from the existing
owner-scoped wallet endpoints. A client that needs the latest portfolio state refetches that
resource after completion rather than treating a command response as a general balance projection.

## 5. Owner-Scoped Lookup

`GET /api/v1/withdrawals/:withdrawalId` returns the same `data.withdrawal` representation for a
completed withdrawal owned by the authenticated subject.

The path parameter must be a valid UUID. A nonexistent withdrawal and a withdrawal belonging to
another subject both return:

```text
404 WITHDRAWAL_NOT_FOUND
```

The endpoint never reveals whether another owner's withdrawal exists. Persistence readers query by
both withdrawal identifier and authenticated owner rather than loading a record and trusting a
client ownership assertion.

After an ambiguous POST failure, the client should retry the POST with the same idempotency key. GET
lookup is useful only after the client has received a withdrawal identifier; the API does not expose
idempotency-key lookup or history search in this slice.

## 6. Authentication, CSRF, and Request Ordering

Both endpoints use the access-cookie authentication and account/session checks accepted by ADR-017
and ADR-019. The server passes `AuthenticatedContext.userId` to Financial as the owner identifier.

Creation requires the existing exact-origin check and session-bound CSRF cookie/header validation.
Lookup is a side-effect-free authenticated GET and does not require CSRF. CORS preflight remains
unauthenticated and performs no Financial action.

The creation boundary applies controls in this order:

```text
authentication
    ↓
exact origin + session-bound CSRF
    ↓
content type + one idempotency header + strict body validation
    ↓
owner-aware retry-preserving rate limit
    ↓
Financial withdrawal capability
```

An idempotent retry may bypass current asset and operational availability only inside the trusted
Financial application rule from ADR-024. It never bypasses authentication, session state, CSRF,
transport validation, or abuse controls.

The existing allowed CORS request headers already include `Content-Type`, `X-CSRF-Token`, and
`Idempotency-Key`. Credentialed CORS continues to allow only configured origins.

## 7. Status and Error Mapping

Withdrawal responses use the existing error envelope and request identifier. Initial mappings are:

| HTTP status | Error code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_FAILED` | Malformed path, header, JSON body, asset code, or amount |
| 401 | `AUTHENTICATION_REQUIRED` | Missing, invalid, expired, or unusable authenticated session |
| 403 | `CSRF_FAILED` | Origin or session-bound CSRF validation failed |
| 403 | `FORBIDDEN` | Authenticated caller lacks an applicable permission |
| 404 | `ASSET_NOT_FOUND` | Requested asset does not exist |
| 404 | `WALLET_NOT_FOUND` | Current subject has no wallet for the asset |
| 404 | `WITHDRAWAL_NOT_FOUND` | Withdrawal is missing or not owned by the current subject |
| 409 | `ASSET_UNAVAILABLE` | Asset exists but rejects new withdrawals |
| 409 | `IDEMPOTENCY_CONFLICT` | Same owner/key was used for a different withdrawal intent |
| 409 | `INSUFFICIENT_AVAILABLE_BALANCE` | Current available balance is lower than the requested amount |
| 429 | `RATE_LIMITED` | Caller exceeded the simulated-withdrawal operation limit |
| 503 | `SIMULATED_WITHDRAWALS_UNAVAILABLE` | New simulated withdrawals are operationally disabled |

Insufficient balance is a state conflict, not malformed JSON. The public error does not return the
available, reserved, or requested amount. The client may refetch the wallet resource to present
current balances.

Unexpected failures use the existing internal-error mapping. SQL errors, constraint names, stack
traces, account identifiers, and intent hashes are never exposed or translated directly into public
messages.

`SIMULATED_WITHDRAWALS_UNAVAILABLE` may include `Retry-After` only when the server has a concrete
recovery interval. Historical lookup and identical retries remain application-resolvable while new
withdrawals are disabled.

## 8. Operational Control

API composition will receive an explicit `SIMULATED_WITHDRAWALS_ENABLED` configuration value. It is
enabled by default only for local, test, and CI environments and disabled by default for staging and
production unless deliberately configured.

The setting controls creation of new simulated withdrawal intents. It does not alter balances,
historical resources, lookup, or the meaning of a completed withdrawal. Enabling this simulation in
a production-like environment does not make it a real custody capability.

Configuration is parsed once at the application boundary and supplied to the Financial use case;
controllers do not read environment variables per request.

## 9. Rate Limiting

Simulated-withdrawal creation receives a limiter separate from simulated-deposit creation so one
operation does not consume the other's budget. It is scoped by authenticated owner and counts new
idempotency intents rather than raw HTTP attempts.

An identical key within the active window remains allowed so a lost response can be retried. A new
key beyond the limit returns `429 RATE_LIMITED` with an integer `Retry-After` value when the limiter
knows the window reset. Raw keys are never retained or logged where a one-way digest is sufficient.

The initial bounded in-memory implementation is acceptable for the single-instance MVP. A
production-like multi-instance deployment must document per-instance semantics or replace it with a
shared bounded limiter. Exact thresholds remain an implementation-tuning decision and are not a
financial limit policy.

Rate limiting does not replace balance checks, idempotency constraints, authentication, CSRF, or
future risk/compliance controls.

## 10. Cache, Logging, and Privacy

Every withdrawal response, including successful creation, replay, lookup, and errors reached under
the withdrawal router, uses:

```text
Cache-Control: no-store
```

Structured logs may include the request ID, route template, status, authenticated subject identifier
under the accepted privacy policy, asset code, withdrawal identifier after creation, result
classification, and duration.

Logs must not contain authentication credentials, CSRF values, raw idempotency keys, request bodies,
amounts, intent hashes, ledger or custody identifiers, SQL details, or invented external-transfer
facts. Logging is operational evidence, not the balance authority.

## 11. Minimum Evidence

Implementation must prove:

- shared schemas require canonical string amounts and reject unknown or fictional withdrawal fields;
- creation requires authentication, exact origin, session-bound CSRF, JSON, and exactly one valid
  idempotency header;
- the owner is derived from the authenticated context and cannot be selected by the request;
- a new withdrawal returns `201`, an identical retry returns `200`, and both return the same resource
  and `Location`;
- successful responses say `simulated` and `completed` without external-transfer fields;
- missing assets and wallets, disabled assets, insufficient available balance, idempotency conflict,
  operational disablement, and rate limiting map to the accepted errors;
- insufficient balance creates no withdrawal and does not expose balance details in the error;
- owner-scoped lookup returns the resource and hides another owner's resource as `404`;
- authenticated withdrawal responses use `Cache-Control: no-store`;
- retry-preserving rate limiting allows an identical key while limiting new intents;
- controller tests verify mapping independently of PostgreSQL;
- real-PostgreSQL HTTP integration proves Identity-to-owner propagation, exact available-balance
  reduction, unchanged reserved value, replay behavior, lookup ownership, and no partial effect;
- no response or log exposes journal, account, custody, intent, raw-key, destination, or provider
  details.

# Alternatives Considered

## Add Direction to a Generic Deposit/Withdrawal Endpoint

Rejected because it turns a narrow business capability into caller-selected accounting behavior and
weakens route, validation, authorization, and error clarity.

## Accept a Destination for Realism

Rejected because ADR-024 has no external-transfer capability. Accepting an unused or unvalidated
destination would mislead users and create a future security-sensitive contract accidentally.

## Return `202 Accepted`

Rejected because the simulated lifecycle has no background state. Success means the completed
withdrawal and balanced journal committed synchronously.

## Return `422` for Insufficient Balance

Rejected for the current API convention. The request is structurally and semantically valid, but it
conflicts with mutable wallet state; `409` aligns it with other Financial state conflicts.

## Accept a Wallet Identifier

Rejected because the asset plus authenticated owner uniquely resolves the wallet. A client-selected
wallet ID creates an unnecessary ownership and confused-deputy boundary.

## Include the Updated Wallet in the Command Response

Rejected because the withdrawal and wallet are separate resources. Keeping balance reads behind the
existing wallet contract avoids coupling every command response to a balance-projection shape.

## Share the Deposit Rate-Limit Budget

Rejected because funding and withdrawal are separate capabilities with different abuse patterns.
They may share infrastructure without sharing counters or policy.

# Consequences

## Positive Consequences

- The browser receives a small, owner-safe simulated-withdrawal API.
- Creation, replay, and lookup have explicit recovery semantics.
- Insufficient funds are understandable without exposing sensitive balance data.
- Strict schemas prevent accidental destination, fee, or accounting contracts.
- The response remains truthful about simulation and contains no real-custody claims.
- Existing Financial security, cache, error, and observability conventions remain consistent.

## Negative Consequences

- Clients must refetch wallet state after a withdrawal when they need current balances.
- Withdrawal lookup requires a new owner-scoped read model.
- A separate limiter and operational flag add composition and testing work.
- `409` covers multiple Financial conflicts and clients must branch on the error code.
- The contract intentionally demonstrates no destination, fee, approval, or external settlement.

# Deferred Decisions

This ADR does not decide:

1. withdrawal-history filtering, cursor pagination, and retention presentation;
2. browser forms, confirmation copy, portfolio refresh, and notifications;
3. real destinations, networks, address validation, memos, and travel-rule data;
4. MFA step-up, allowlists, cooling-off periods, approval, risk, and compliance review;
5. withdrawal fees, minimums, maximums, daily limits, and velocity policy;
6. pending, rejected, cancelled, broadcast, confirmed, failed, and reversed states;
7. custody-provider APIs, signing, outbox workers, webhooks, and reconciliation;
8. operation-specific asset availability such as withdrawal-only mode;
9. distributed rate-limit storage and production thresholds;
10. a combined deposit/withdrawal activity-history resource.

# Reconsider When

Review this decision before Atlas accepts destinations, transmits externally valuable assets,
charges fees, requires step-up authentication or approval, introduces asynchronous withdrawal
states, exposes history, deploys multi-instance production traffic, or adopts a broader API
idempotency standard.

# Relationship to Other Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-023 — Financial HTTP API and Error Contract](ADR-023-financial-http-api-and-error-contract.md)
- [ADR-024 — Simulated Withdrawal Lifecycle and Custody Boundary](ADR-024-simulated-withdrawal-lifecycle-and-custody-boundary.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
