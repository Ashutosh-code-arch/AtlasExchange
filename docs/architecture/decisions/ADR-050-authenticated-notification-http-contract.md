# ADR-050 — Authenticated Notification HTTP Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-050

## Context

ADR-049 provides framework-neutral capabilities for stable owner-scoped inbox pagination, exact
unread counts, and monotonic read acknowledgement. Atlas now needs a browser-consumable HTTP
boundary that preserves those guarantees without accepting owner identity from the client or
exposing persistence details.

The list query performs an exact count, and mark-read mutates private account state under
cookie-based authentication. The contract therefore needs explicit authentication, CSRF, caching,
validation, output containment, rate limiting, and non-disclosure rules before browser work begins.

## Decision Drivers

The HTTP boundary should:

1. derive ownership exclusively from the server-confirmed access session;
2. preserve the accepted bounded cursor and exact-count semantics;
3. protect read acknowledgement with the existing session-bound CSRF mechanism;
4. return the same result shape for first and repeated acknowledgements;
5. avoid confirming that another owner's notification exists;
6. reject unknown input and internal output at strict shared-contract boundaries;
7. prevent private responses from browser or intermediary caching;
8. bound repeated database reads and writes per authenticated owner; and
9. remain separate from browser presentation and realtime delivery.

# Decision

Atlas will expose two authenticated Notification endpoints:

~~~text
GET   /api/v1/notifications
PATCH /api/v1/notifications/:notificationId/read
~~~

## 1. Authentication and ownership

Both routes require a valid access session. The owner ID comes only from the authenticated request
context and is supplied to the Notification application capability by the server.

No owner ID is accepted in query parameters, path parameters, headers, or bodies. No owner ID is
returned in an inbox item or receipt. Authentication executes before request validation or
rate-limit consumption, so unauthenticated callers receive only `AUTHENTICATION_REQUIRED`.

Every response under `/notifications`, including authentication, validation, limiting, not-found,
and unexpected failures, carries `Cache-Control: no-store`.

## 2. Inbox list

`GET /api/v1/notifications` accepts only:

| Query field | Required | Contract |
|---|---:|---|
| `limit` | No | Canonical integer string from 1 through 50; default 20 |
| `cursor` | No | Opaque URL-safe cursor, at most 512 characters |

The request must not have a body. Unknown query fields, repeated/structured values, noncanonical
limits, and malformed cursors return `400 VALIDATION_FAILED`.

The successful `200` representation is:

~~~text
{
  success: true,
  data: {
    notifications: [
      {
        id,
        kind,
        sourceId,
        payload: { assetCode, amount },
        occurredAt,
        createdAt,
        readAt
      }
    ],
    unreadCount,
    page: { nextCursor }
  }
}
~~~

`unreadCount` remains an exact canonical decimal integer string. Items must be unique and ordered by
descending occurrence time and ID. Payload quantities remain canonical exact strings. The shared
response contract contains no schema version, owner ID, persistence key, or internal row data.

## 3. Mark read

`PATCH /api/v1/notifications/:notificationId/read` requires:

- a canonical UUID path parameter;
- the authenticated access session;
- the allowed web origin;
- matching CSRF cookie and header values bound to the session; and
- no query parameters or request body.

The route returns `200` for both a newly created and an existing receipt:

~~~text
{
  success: true,
  data: {
    readReceipt: { notificationId, readAt }
  }
}
~~~

The transport does not expose `created` versus `existing`; retry mechanics are not a product state.
Both return the immutable first-read timestamp.

An absent notification and a notification owned by someone else both return the identical
`404 NOTIFICATION_NOT_FOUND` response. This prevents resource enumeration. Invalid shape returns
`400 VALIDATION_FAILED`, and missing or invalid CSRF proof returns `403 CSRF_FAILED`.

## 4. Validation and failure containment

Shared strict Zod contracts in `@atlas/contracts` define list input, both success representations,
path parameters, and the bounded Notification error-code vocabulary. Unknown properties fail
validation.

The HTTP adapter validates application output before sending it. Invalid internal output and
unexpected failures pass through the API's generic `500 INTERNAL_SERVER_ERROR` containment without
schema diagnostics or private fields.

The accepted error vocabulary is:

- `AUTHENTICATION_REQUIRED`;
- `CSRF_FAILED`;
- `INTERNAL_SERVER_ERROR`;
- `NOTIFICATION_NOT_FOUND`;
- `RATE_LIMITED`; and
- `VALIDATION_FAILED`.

## 5. Rate limiting

List and mark-read use separate fixed-window limiters, each allowing 60 requests per authenticated
owner per minute by default. Limit keys are in-memory SHA-256 owner digests rather than raw IDs.

Capacity is consumed only after authentication and request-shape validation. A denied request
returns `429 RATE_LIMITED` with an integer `Retry-After` header and does not call the application
capability.

The limiter is deliberately process-local for the initial single-instance deployment. It is a
resource-protection boundary, not an authorization, accounting, or durable quota mechanism.

## 6. Composition boundary

The Notification module factory composes the application capabilities with their PostgreSQL
adapters, authentication and CSRF middleware, independent endpoint limiters, and optional clock.
The root API mounts the resulting router under `/api/v1`.

This increment adds no migration and does not define browser polling, stale-state presentation,
navigation badges, toast behavior, WebSockets, external delivery, or notification preferences.

## Alternatives Considered

### Accept owner ID in the query

Rejected because ownership is an authorization fact established by the session, not client input.

### Use POST for acknowledgement

Rejected because the operation changes one known notification subresource and has idempotent update
semantics; `PATCH` communicates that boundary more directly.

### Return 204 for mark-read

Rejected because returning the authoritative immutable `readAt` lets clients reconcile first and
repeated requests without inventing a timestamp.

### Return 201 for the first receipt and 200 for retries

Rejected because it exposes persistence retry status that the browser does not need and creates two
transport paths for the same final product state.

### Return forbidden for another owner's notification

Rejected because distinguishing it from absence reveals resource existence.

### Exempt mark-read from CSRF

Rejected because cookie-authenticated state mutation requires the same origin and session-bound
proof as other Atlas mutations.

### Cache private list responses

Rejected because inbox and read state are owner-specific and change independently of public data.

### Introduce distributed rate limiting now

Rejected because Atlas currently has one application instance and no accepted distributed quota
requirement. The application port allows later adapter replacement.

## Consequences

### Positive Consequences

- The browser has a strict private inbox and acknowledgement contract.
- Client input cannot select or reveal another owner.
- Read acknowledgement has session-bound CSRF protection and stable retry behavior.
- Shared contracts preserve exact amounts, counts, ordering, and output containment.
- Exact-count reads and write attempts have independent per-owner protection.
- Real-PostgreSQL HTTP tests prove owner isolation, non-disclosing misses, retries, and unread change.

### Negative Consequences

- Each list request still performs the exact count defined by ADR-049.
- Process-local rate limits are not coordinated across future replicas.
- The browser must retain and send the session CSRF token for acknowledgement.
- The API exposes only single-item acknowledgement; there is no bulk mark-read route.
- There is no visible product surface until the browser delivery increment.

## Reconsider When

Review this decision when Atlas runs multiple API replicas, exact counts become a measured
bottleneck, the product requires bulk acknowledgement, a mobile/non-cookie client is introduced, or
the inbox receives kinds with materially different payload contracts.

## Related Decisions

- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-047 — Durable Notification Inbox and Event-Capture Foundation](ADR-047-durable-notification-inbox-and-event-capture-foundation.md)
- [ADR-049 — Private Notification Inbox Read Model](ADR-049-private-notification-inbox-read-model.md)
