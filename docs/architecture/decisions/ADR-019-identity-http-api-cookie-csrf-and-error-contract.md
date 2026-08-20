# ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-20  
**Last reviewed:** 2026-08-20  
**Canonical owner/source:** ADR-019

## Context

ADR-017 establishes the Identity session-security model and ADR-018 establishes the Identity persistence model. This ADR defines the HTTP boundary that exposes those decisions to the web client and approved callers.

This decision is the final prerequisite before Identity implementation. No Identity migrations or implementation should begin until ADR-018 is accepted and committed and ADR-019 is accepted.

## Decision

### 1. Authentication API surface

The initial API is versioned under `/api/v1/auth`.

| Operation | Method | Path |
|---|---|---|
| Register | POST | `/api/v1/auth/register` |
| Login | POST | `/api/v1/auth/login` |
| Verify email | POST | `/api/v1/auth/verify-email` |
| Resend verification | POST | `/api/v1/auth/resend-verification` |
| Forgot password | POST | `/api/v1/auth/forgot-password` |
| Reset password | POST | `/api/v1/auth/reset-password` |
| Refresh | POST | `/api/v1/auth/refresh` |
| Logout | POST | `/api/v1/auth/logout` |
| Logout all | POST | `/api/v1/auth/logout-all` |
| Current user | GET | `/api/v1/auth/me` |
| Sessions | GET | `/api/v1/auth/sessions` |
| Revoke session | DELETE | `/api/v1/auth/sessions/:sessionId` |

### 2. Request and response contracts

Authentication requests use JSON. Successful JSON responses use:

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
    "code": "AUTHENTICATION_FAILED",
    "message": "Authentication failed.",
    "requestId": "..."
  }
}
```

`204` responses have no body.

| Operation | Status |
|---|---:|
| Register | 202 |
| Resend verification | 202 |
| Forgot password | 202 |
| Login | 200 |
| Verify email | 204 |
| Reset password | 204 |
| Refresh | 204 |
| Logout | 204 |
| Logout all | 204 |
| Revoke session | 204 |
| Current user / session listing | 200 |

Registration, verification resend, and password recovery must not disclose whether an email exists. Registration returns the same `202` contract for an existing address.

### 3. Authentication schemas

Registration:

```json
{
  "email": "user@example.com",
  "password": "..."
}
```

Login:

```json
{
  "email": "user@example.com",
  "password": "..."
}
```

Wrong credentials return `401 AUTHENTICATION_FAILED`.

A valid password for `pending_verification` returns `403 ACCOUNT_VERIFICATION_REQUIRED` and creates no session or authentication cookies.

Suspended and disabled accounts return `403 ACCOUNT_UNAVAILABLE` after valid credential verification without exposing the precise administrative state.

Verification and password-reset capabilities are single-use opaque secrets. They are delivered through email using a fragment exception:

```text
https://app.example.com/verify-email#token=...
https://app.example.com/reset-password#token=...
```

The frontend must read the fragment once, immediately remove it with `history.replaceState`, POST the token in JSON, and never persist or log it.

### 4. Authentication cookies

#### Production and staging

| Cookie | Path | Secure | HttpOnly | SameSite | Lifetime |
|---|---|---:|---:|---|---:|
| `__Host-atlas_access` | `/` | true | true | Strict | 10 minutes |
| `__Secure-atlas_refresh` | `/api/v1/auth` | true | true | Strict | 30 days maximum |

No `Domain` attribute is set. Authentication cookie secrets contain at least 256 bits of randomness.

Production configuration must reject insecure authentication cookies.

#### Local/test HTTP

| Cookie | Path | Secure | HttpOnly | SameSite |
|---|---|---:|---:|---|
| `atlas_access` | `/` | false | true | Strict |
| `atlas_refresh` | `/api/v1/auth` | false | true | Strict |

The insecure names are required because `__Host-` and `__Secure-` cookies require `Secure`. Insecure-cookie mode is explicitly guarded for local/test only.

The refresh cookie path is `/api/v1/auth`, allowing logout to use the refresh credential when the access credential has expired.

### 5. Cookie lifecycle

Login creates a session, access token, and refresh token.

Refresh rotates the refresh credential atomically. Logout and logout-all revoke the applicable server-side credentials and clear cookies.

A refresh `401` clears authentication cookies. Revoking the current session through `DELETE` also clears the current browser cookies.

Cookie clearing uses the same effective cookie name and path as the original cookie.

### 6. CSRF matrix

| Endpoint class | Session CSRF | Protection |
|---|---|---|
| Register/login/verification/recovery | No | Exact origin + JSON-only + restrictive CORS |
| Refresh | Yes, bound through refresh-authenticated session | CSRF cookie/header + exact origin |
| Authenticated mutations | Yes | CSRF cookie/header + exact origin |
| Authenticated GET | No | Normal CORS/origin policy |
| CORS preflight OPTIONS | No | Preflight handling only |

Login and registration do not use a session-bound CSRF token because no session exists yet.

### 7. CSRF cookie and header

Production/staging:

```text
__Host-atlas_csrf
Path=/
HttpOnly=false
SameSite=Strict
Secure=true
```

Local/test HTTP:

```text
atlas_csrf
Path=/
HttpOnly=false
SameSite=Strict
Secure=false
```

The CSRF cookie is intentionally readable and is not an authentication secret.

Conceptually:

```text
nonce.signature
signature = HMAC(version + sessionId + nonce)
```

The server requires the cookie and `X-CSRF-Token` header, exact equality, valid HMAC/session binding, and valid structure/lifetime.

The token remains stable for the session, is cleared on logout, and expires no later than the session absolute expiry.

### 8. Exact-origin and CORS

The API uses an explicit allowlist of approved same-site application origins.

For authentication and protected operations:

- validate `Origin` exactly;
- where appropriate, use strict `Referer` validation;
- never accept or reflect arbitrary origins;
- allow credentials only for approved origins.

`OPTIONS` preflight does not require authentication or CSRF.

The initial web and API deployment remains same-site. A genuinely cross-site deployment requires a new cookie/CORS/CSRF review.

### 9. Authentication middleware

Authentication middleware resolves the opaque access credential from the cookie and validates it server-side.

Every authenticated request verifies:

```text
token active
+
token unexpired
+
session active
+
session not idle-expired
+
session not absolutely expired
+
account allowed
```

Logout, administrative revocation, password change, suspension, and disablement therefore become immediately effective.

Successful authentication creates an explicit `AuthenticatedContext` containing only required context such as `userId`, `sessionId`, authorization context, and `requestId`. Raw credentials are never exposed through it.

### 10. Session semantics

Baseline:

```text
Access expiry:             10 minutes
Session inactivity:         7 days
Absolute session expiry:   30 days from login
```

```text
idleExpiresAt = min(lastActivityAt + 7 days, absoluteExpiresAt)
```

Successful authenticated activity and refresh update session activity subject to the absolute limit.

Password changes, role changes, suspension, and disablement revoke all sessions.

### 11. Refresh failure and reuse

Refresh credentials are internally represented conceptually as:

```text
tokenId.secret
```

Refresh authenticates both the token identifier and its secret.

The transaction:

1. locates the token by `tokenId`;
2. locks the row;
3. validates the supplied secret against `secret_digest`;
4. rejects without mutation when invalid;
5. rejects expired or revoked credentials;
6. treats consumed credentials as reuse;
7. on reuse, revokes the session and its refresh-token family;
8. otherwise consumes the token and creates its replacement atomically.

One session is one refresh-token family; no separate family identifier is required.

Frontend coordination is mandatory:

```text
in-tab single-flight
+
cross-tab refresh lock
+
cross-tab completion notification
```

The implementation may use `BroadcastChannel`, Web Locks, or an equivalent mechanism.

### 12. Public authentication errors

Initial codes:

```text
AUTHENTICATION_FAILED
AUTHENTICATION_REQUIRED
ACCOUNT_VERIFICATION_REQUIRED
ACCOUNT_UNAVAILABLE
FORBIDDEN
VALIDATION_FAILED
CSRF_FAILED
RATE_LIMITED
```

Mappings:

- `401 AUTHENTICATION_FAILED` — invalid login credentials.
- `401 AUTHENTICATION_REQUIRED` — authentication required or invalid for a protected operation.
- `403 ACCOUNT_VERIFICATION_REQUIRED` — valid password but unverified account.
- `403 ACCOUNT_UNAVAILABLE` — suspended/disabled account after valid credential verification.
- `403 FORBIDDEN` — authenticated caller lacks permission.
- `400 VALIDATION_FAILED` — malformed request.
- `403 CSRF_FAILED` — CSRF validation failure.
- `429 RATE_LIMITED` — rate-limited operation.

### 13. Rate limiting

Rate-limited responses use `429 Too Many Requests`, the standard error envelope, and `Retry-After` when a concrete interval is available.

Rate limiting is required at least for login, registration, verification resend, password recovery, password reset, refresh, and other sensitive authentication mutations as evidence requires.

Exact algorithms and thresholds remain implementation decisions.

### 14. Cache, content type, and request size

Authentication responses use:

```text
Cache-Control: no-store
```

Authentication JSON requests require:

```text
Content-Type: application/json
```

Unexpected content types are rejected.

The existing Atlas global JSON request-size limit remains `32 KiB`.

### 15. Frontend credential and refresh behavior

Authenticated browser requests use:

```text
credentials: "include"
```

The client never reads authentication cookies directly.

Authenticated state-changing requests include `X-CSRF-Token`.

Refresh is centralized in the frontend authentication/API layer. Components and features do not implement independent refresh races.

```text
request
  ↓
access accepted
  ↓
continue

access rejected
  ↓
single-flight refresh
  ↓
refresh succeeds
  ↓
notify waiting callers
  ↓
retry original request once

refresh fails
  ↓
clear authentication state
  ↓
unauthenticated state
```

The client never retries indefinitely. Cross-tab coordination prevents multiple tabs from independently rotating the same refresh credential.

### 16. Security-event boundary

Operational Pino logs remain distinct from durable Identity security history.

Critical authentication/security events are persisted through `identity.security_events` as established by ADR-018.

Security events must never contain passwords, password hashes, access/refresh secrets, cookies, CSRF secrets, recovery capabilities, or other credential material.

### 17. Related decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-018 — Identity Data Model and Persistence Strategy](ADR-018-identity-data-model-and-persistence-strategy.md)

## Consequences

### Positive

- Authentication behavior is explicit and testable.
- Cookie scope and security attributes are defined.
- CSRF protection has separate pre-session and authenticated contracts.
- Opaque server-side credentials permit immediate revocation.
- Refresh reuse detection is transactionally implementable.
- Frontend refresh races are treated as a security and correctness concern.
- Existing Atlas response envelopes remain compatible.
- Authentication operations avoid intentional account enumeration.
- Authentication cookies remain inaccessible to JavaScript.
- Operational logs and durable security history remain separate.

### Negative

- Cookie, CSRF, CORS, refresh, and frontend coordination require coordinated implementation.
- Same-site deployment is an initial architectural constraint.
- Server-side access-token resolution introduces database/cache work.
- Cross-tab coordination adds frontend infrastructure.
- Security tests must cover concurrent refresh, revocation, CSRF, origin validation, and enumeration resistance.

## Deferred decisions

- Exact rate-limit algorithms and thresholds.
- Distributed rate limiting.
- Trusted proxy and forwarded-header policy.
- WebSocket authentication and lifecycle behavior.
- OAuth/OIDC.
- Multi-factor authentication.
- Passwordless authentication.
- Runtime frontend configuration for one immutable artifact.
- Cross-site frontend/API deployment.
- Exact frontend refresh-lock primitive.
- Detailed session-management UI fields.

## Acceptance confirmation

ADR-019 is accepted because:

1. ADR-018 is amended, accepted, committed, and all referenced links resolve.
2. The response envelope matches the contracts package.
3. Cookie names, paths, attributes, and local/test exceptions are explicit.
4. The CSRF matrix and exact-origin policy are implementation-ready.
5. Refresh-token authentication, rotation, and reuse are transactionally defined.
6. Frontend single-flight and cross-tab refresh coordination is mandatory and documented.
7. Authentication error codes and status mappings are fixed.
8. Request size, content type, caching, and rate-limit contracts are fixed.
9. Identity implementation remained blocked until ADR-019 was accepted.

## Status

**Accepted**

ADR-019 completes the architectural prerequisites for Identity. Identity schema migrations and implementation may now proceed subject to ADR-017, ADR-018, and the related architectural decisions.
