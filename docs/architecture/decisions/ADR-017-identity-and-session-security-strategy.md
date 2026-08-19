# ADR-017 — Identity and Session Security Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-19  
**Last reviewed:** 2026-08-19  
**Canonical owner/source:** ADR-017

## 1. Context

Atlas requires an Identity boundary before authenticated application features are implemented. This decision establishes the security contracts for account identity, passwords, browser sessions, access and refresh tokens, CSRF protection, recovery flows, authorization, revocation, rate limiting, and security-event handling.

Identity implementation must not begin until this ADR is accepted.

## 2. Decision

### 2.1 Login identifier

Atlas uses **email as the initial login identifier**. A username is not required for the Identity phase.

Email has:
- an original/display representation for user-facing purposes;
- a normalized representation for login and uniqueness;
- case-insensitive uniqueness enforced by the database.

The initial normalization contract is:

```text
normalizedEmail = trim + NFC + locale-independent lowercase
```

Internationalized email handling is deferred.

The internal `userId` is immutable and is the authoritative identity reference.

### 2.2 Account states

Initial account states are:
- `pending_verification`
- `active`
- `suspended`
- `disabled`

Unverified users may complete verification and only access explicitly permitted pre-verification capabilities. They must not receive normal authenticated application access before verification.

The first administrator is created through an explicit bootstrap/administrative process. Self-registration can never select or assign `admin`.

Role changes and password changes revoke or regenerate affected sessions according to the session-revocation rules below.

## 3. Password security

Atlas uses **Argon2id**.

| Property | Decision |
|---|---|
| Minimum | 15 Unicode code points |
| Maximum | 128 Unicode code points |
| Composition rules | None |
| Normalization | NFC before hashing |
| Truncation | Prohibited |
| Blocklist | Local/offline |
| External password checking | Prohibited |
| Hash algorithm | Argon2id |

Passwords are accepted as Unicode without arbitrary composition requirements.

The blocklist is local/offline; raw passwords are never sent to an external service.

Argon2id parameters must be benchmarked on the target environment and recorded before implementation. The benchmark should consider the OWASP-documented acceptable configuration of approximately 19 MiB memory, two iterations, and parallelism 1, while selecting parameters appropriate to Atlas latency and resource limits.

Unknown-email authentication must verify against a dummy Argon2id hash so the unknown-user path does not become an obvious timing oracle.

## 4. Browser session model

Atlas uses short-lived access credentials and rotating refresh credentials stored in cookies.

| Credential | Staging/production cookie | Local/test cookie | Path                   | Lifetime   | Server storage                  |
| ---------- | ------------------------- | ----------------- | ---------------------- | ---------- | ------------------------------- |
| Access     | `__Host-atlas_access`     | `atlas_access`    | `/`                    | 10 minutes | Access-token digest and metadata |
| Refresh    | `__Secure-atlas_refresh`  | `atlas_refresh`   | `/api/v1/auth/refresh` | 30 days    | Refresh-token record and digest  |

Cookie properties:
- Access cookie path: `/`.
- Refresh cookie path: `/api/v1/auth/refresh`.
- Access lifetime: 10 minutes.
- Refresh lifetime: 30 days.
- `HttpOnly` is enabled for both authentication cookies.
- `SameSite=Strict` is the baseline.
- No `Domain` attribute is set.
- Authentication secrets contain at least 256 bits of randomness.
- Browser JavaScript must not receive access or refresh secrets.
- Production configuration must reject insecure authentication cookies.
- The prefixed production/staging cookies are used only when `Secure=true`, because `__Host-` and `__Secure-` cookies require `Secure`.
- Local/test HTTP intentionally uses unprefixed cookie names because prefixed cookies may be rejected by browsers without `Secure`.

The initial web and API deployment must remain same-site. A genuinely cross-site deployment requires a dedicated cookie, CORS, and CSRF security review.

## 5. Access-token lifetime

The access credential lifetime is **10 minutes**.

Session continuation is handled through the refresh session rather than indefinite access-token extension.

## 6. Refresh-token rotation and reuse detection

Refresh tokens are opaque browser credentials. Internally:

```text
tokenId.secret
```

Only the secret digest is stored.

Each refresh-token record contains:

```text
tokenId
sessionId
familyId
secretDigest
issuedAt
expiresAt
consumedAt
revokedAt
replacedByTokenId
```

Refresh rotation occurs in **one atomic PostgreSQL transaction**.

Rules:
1. A valid unconsumed token is atomically marked consumed.
2. A replacement is created in the same transaction.
3. `replacedByTokenId` links the old record to the replacement.
4. The first concurrent refresh that successfully consumes the token wins.
5. Later use of a consumed token is refresh-token reuse.
6. Reuse revokes the entire token family and associated session.
7. The client must authenticate again after family revocation.

The frontend must coordinate refresh operations across concurrent requests and browser tabs.

### Session expiry

```text
Access expiry:           10 minutes
Session inactivity:      7 days
Absolute session expiry: 30 days from login
```

Session inactivity is calculated as:

```text
idleExpiresAt = min(lastActivityAt + 7 days, absoluteExpiresAt)
```

Successful authenticated activity and successful refresh update `lastActivityAt`.

Rotation extends neither the absolute expiry nor the inactivity policy beyond their defined limits.

## 7. CSRF protection

Atlas does not rely on `SameSite` alone.

Authenticated state-changing requests, including refresh, logout, logout-all, password changes, and all other authenticated mutations, require:

```text
SameSite=Strict
+
exact Origin/Referer validation
+
session-bound signed double-submit CSRF token
+
custom request header
```

Login and registration require JSON plus exact-origin validation.

The CSRF token is session-bound and signed. Naive cookie-to-header equality is insufficient.

The readable CSRF cookie is not an authentication secret and is intentionally not `HttpOnly`; its purpose is to participate in the signed double-submit mechanism.

## 8. Session model

Atlas supports **multi-device sessions**. Each browser/device receives its own session record.

This permits:
- per-session logout;
- logout-all;
- administrative revocation;
- independent refresh-token families;
- security-event attribution.

### Logout

`logout` revokes the current session and refresh-token family.

### Logout-all

`logout-all` revokes every active session for the user.

### Administrative revocation

Authorized administrative/security operations may revoke a specific session, all sessions for a user, or disable the account.

Password changes, role changes, suspension, and disablement revoke all sessions.

Every authenticated request resolves the presented opaque access-token digest and verifies:

```text
token active
+
token unexpired
+
session active
+
account allowed
```

Therefore logout, administrative revocation, password changes, suspension, and disablement become immediately effective for authenticated requests.

## 9. Roles and permissions

Initial roles:

```text
user
admin
```

Users cannot self-assign `admin`.

Authorization is enforced server-side. Browser configuration and client-supplied roles are never trusted for authorization or financial decisions.

## 10. Email verification

New accounts begin as `pending_verification`.

Verification capabilities are:
- single-use;
- valid for **24 hours**;
- invalidated when verification is completed;
- invalidated when a new verification capability is issued.

Successful verification transitions the account to `active`.

## 11. Password reset

Password-reset capabilities are:
- single-use;
- valid for **30 minutes**;
- invalidated when a new reset capability is issued.

A successful reset:
- changes the password hash;
- invalidates the reset capability;
- revokes existing sessions according to the account-security policy;
- does not automatically authenticate the user.

Reset responses must not reveal whether an email address exists.

## 12. Rate limiting

Authentication-sensitive operations require rate limiting, including:
- login;
- registration;
- verification resend;
- password-reset request;
- password-reset submission;
- refresh;
- logout-all where abuse is operationally relevant.

Exact limits and distributed enforcement remain implementation decisions to be benchmarked and revisited.

## 13. Security events and operational logging

Operational logs and durable security history are distinct.

Security-log event names may include:

```text
identity.login.succeeded
identity.login.failed
identity.logout
identity.logout_all
identity.refresh.reuse_detected
identity.password.changed
identity.password_reset.requested
identity.password_reset.completed
identity.email_verified
identity.session.revoked
identity.account.suspended
```

These are **security logs**, not automatically durable audit records.

Critical Identity events should be evaluated for persistence in an append-only `identity_security_events` table. If durable persistence is deferred, they must be called security logs rather than audit events.

Never log passwords, password hashes, access/refresh secrets, reset/verification tokens, CSRF secrets, authentication cookies, database credentials, or private keys.

Use opaque `userId` and `sessionId` values for correlation.

## 14. Operational boundaries

Identity follows the application and database boundaries established by the related ADRs.

Application/domain code must not depend directly on:
- Express request/response objects;
- cookie parsing;
- Pino implementation details;
- PostgreSQL clients;
- Kysely transaction objects.

Application transaction boundaries remain application-owned. Refresh rotation, session revocation, password changes, and other state-changing Identity operations use the transaction abstraction established by the database strategy.

## 15. Security invariants

1. Immutable internal `userId` identifies the account.
2. Normalized email is case-insensitively unique.
3. No self-registration path can assign `admin`.
4. Raw passwords are never persisted or logged.
5. Passwords are NFC-normalized before hashing and never truncated.
6. Unknown-email authentication uses a dummy Argon2id path.
7. Authentication cookies are `HttpOnly`.
8. Staging and production authentication cookies are `Secure`.
9. Authentication cookies have no `Domain`.
10. Authentication state-changing requests enforce CSRF protection.
11. Refresh rotation is atomic.
12. Refresh-token reuse revokes its family and session.
13. Refresh rotation cannot extend session lifetime beyond inactivity or absolute expiry.
14. Password reset does not automatically authenticate the user.
15. Unverified users cannot obtain normal authenticated access.
16. Authorization never trusts browser configuration or client-supplied roles.
17. Security secrets never enter operational logs.
18. Identity transaction boundaries do not expose database implementation types.
19. `normalizedEmail` is `trim + NFC + locale-independent lowercase` in the initial identity model.
20. `idleExpiresAt` is `min(lastActivityAt + 7 days, absoluteExpiresAt)`.
21. Successful authenticated activity and refresh update session activity.
22. Password changes, role changes, suspension, and disablement revoke all sessions.
23. Staging and production authentication cookies always use `Secure=true`; insecure authentication-cookie configuration is rejected.
24. The initial web and API deployment remains same-site.
25. The readable CSRF cookie is intentionally not `HttpOnly` and is not an authentication secret.
26. Every authenticated request verifies token activity, token expiry, session activity, and account eligibility.

## 16. Testing requirements

Tests must cover at minimum:

### Passwords
- minimum and maximum lengths;
- Unicode/NFC behavior;
- no truncation;
- blocklist behavior;
- Argon2id verification;
- unknown-email dummy-hash path.

### Sessions
- access expiration;
- inactivity and absolute expiry;
- multi-device sessions;
- per-session logout;
- logout-all;
- administrative revocation.

### Refresh rotation
- successful rotation;
- concurrent refresh race;
- reuse detection;
- family/session revocation;
- replacement-token linkage.

### CSRF
- valid signed session-bound token;
- invalid token;
- wrong session binding;
- missing custom header;
- invalid origin;
- authenticated state-changing requests.

### Identity lifecycle
- email normalization and uniqueness;
- verification expiry and resend invalidation;
- password-reset expiry and resend invalidation;
- reset does not authenticate;
- account-state restrictions;
- role assignment restrictions.

### Security logging
- sensitive values are absent/redacted;
- stable event names exist for important events;
- credential/configuration objects are never serialized.

## 17. Related decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)

## 18. Deferred decisions

- exact Argon2id parameters after benchmarking;
- exact authentication rate limits and distributed implementation;
- production secret-manager integration;
- durable `identity_security_events` persistence if not introduced initially;
- detailed authorization permission matrix beyond `user` and `admin`;
- trusted reverse-proxy/trace-context request identity integration;
- WebAuthn/passkeys and MFA;
- device fingerprinting;
- advanced account-recovery policy;
- distributed session infrastructure if a single API process is no longer sufficient.

## 19. Status summary

**Status: Proposed**

Identity implementation must not begin until this ADR receives final consistency review and is formally accepted. Acceptance also requires the related ADR links to resolve in the repository and the stated security invariants to be preserved during implementation.
