# ADR-018 — Identity Data Model and Persistence Strategy

**Classification:** Canonical  
**Status:** Proposed  
**Date:** 2026-08-19  
**Last reviewed:** 2026-08-20  
**Canonical owner/source:** ADR-018

## 1. Context

Atlas has accepted the Identity security model in ADR-017. This ADR defines how Identity state is represented and persisted in PostgreSQL.

It establishes PostgreSQL ownership, identifiers, tables, credential representation, authorization persistence, transaction boundaries, constraints, concurrency, and durable security history. It does not define the Identity HTTP API, cookie contract, CSRF protocol, or HTTP error representation; those are deferred to ADR-019.

Identity migrations and implementation must not begin until ADR-018 and ADR-019 are accepted.

## 2. Database ownership

Atlas uses a dedicated PostgreSQL schema:

```text
identity
```

The schema is a module namespace, not a separate database, service, or deployment boundary. Identity owns its tables and persistence behavior. Other modules must not query Identity tables directly; cross-module access occurs through application/domain interfaces.

## 3. Persistent identifiers

Persistent Identity entities use database-generated UUIDv7 identifiers:

```sql
id UUID PRIMARY KEY DEFAULT uuidv7()
```

PostgreSQL 18 provides native UUIDv7 generation and UUIDv7 values are time-ordered. See the [PostgreSQL UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html).

Atlas continues storing explicit `created_at` and other authoritative timestamps. UUID ordering must never substitute for business time. Business timestamps use `TIMESTAMPTZ`.

## 4. Initial tables

```text
identity.users
identity.password_credentials
identity.roles
identity.user_roles
identity.sessions
identity.access_tokens
identity.refresh_tokens
identity.email_verification_tokens
identity.password_reset_tokens
identity.security_events
```

Atlas will not introduce a generic `tokens` table because verification, reset, access, and refresh credentials have different lifecycle and security semantics.

## 5. Minimum table columns

### `identity.users`

```text
id, display_email, normalized_email, state, created_at, updated_at
```

### `identity.password_credentials`

```text
user_id, password_hash, password_changed_at, created_at, updated_at
```

`user_id` is both primary key and foreign key to `identity.users`.

### `identity.roles`

```text
code
```

### `identity.user_roles`

```text
user_id, role_code, assigned_at, assigned_by_user_id
```

### `identity.sessions`

```text
id, user_id, created_at, last_activity_at,
absolute_expires_at, revoked_at, revocation_reason
```

### `identity.access_tokens`

```text
id, session_id, secret_digest, issued_at, expires_at, revoked_at
```

### `identity.refresh_tokens`

```text
id, session_id, secret_digest, issued_at, expires_at,
consumed_at, revoked_at, replaced_by_token_id
```

### `identity.email_verification_tokens`

```text
id, user_id, secret_digest, issued_at, expires_at, consumed_at, revoked_at
```

### `identity.password_reset_tokens`

```text
id, user_id, secret_digest, issued_at, expires_at, consumed_at, revoked_at
```

### `identity.security_events`

```text
id, event_type, actor_user_id, target_user_id,
session_id, request_id, occurred_at, metadata
```

`request_id` uses `TEXT` because ADR-014 does not require request identifiers to be UUIDs.

## 6. User model and lifecycle

`display_email` preserves the user-facing representation. `normalized_email` is the canonical login/uniqueness representation:

```text
normalizedEmail = trim + NFC + locale-independent lowercase
```

A unique constraint is required on `normalized_email`. Internationalized email handling beyond this baseline is deferred.

Account state uses PostgreSQL `TEXT` plus a check constraint, not a PostgreSQL enum. Initial states:

```text
pending_verification
active
suspended
disabled
```

`userId` is immutable. Initial product behavior does not support hard deletion. Suspension and disablement preserve identity and historical relationships. Future privacy-erasure requirements require a separate decision.

## 7. Password credentials

There is **at most one** password credential per user at the database level because `password_credentials.user_id` is both its primary key and foreign key. This does not independently guarantee that every user has one.

For password registration, the application transaction creates the user and credential together, so every successfully created password-registered user begins with one credential.

Password rules from ADR-017:

- Argon2id;
- minimum 15 characters;
- maximum 128 Unicode code points;
- NFC normalization before hashing;
- no truncation;
- no composition requirements;
- local/offline compromised-password blocklist.

Raw passwords are never persisted. Final Argon2id parameters must be benchmarked and recorded before implementation.

## 8. Authorization persistence

Persist `identity.roles` and `identity.user_roles`, seeded with:

```text
user
admin
```

A unique constraint prevents duplicate `(user_id, role_code)` assignments. Role-to-permission mapping remains in application code; database-managed dynamic permissions are not introduced initially.

Self-registration must never permit selecting or creating `admin`. The first administrator must use an explicitly controlled bootstrap mechanism.

## 9. Secret representation

| Credential | Stored representation |
|---|---|
| Password | Argon2id encoded hash |
| Random access/refresh/recovery secret | SHA-256 digest as `BYTEA` |
| Signed CSRF token | HMAC using a server-managed key |

Random tokens contain at least 256 bits of entropy. High-entropy random tokens are not hashed with Argon2id. The browser-facing opaque credential may use `tokenId.secret`; the raw secret is never stored.

## 10. Sessions and access tokens

Session baseline:

```text
Access expiry:          10 minutes
Session inactivity:      7 days
Absolute session expiry: 30 days from login
```

```text
idleExpiresAt = min(lastActivityAt + 7 days, absoluteExpiresAt)
```

Successful authenticated activity and successful refresh update session activity. Refresh rotation never extends absolute expiry. Password changes, role changes, suspension, and disablement revoke all sessions.

Every authenticated request resolves the opaque access-token digest and verifies:

```text
token active
+
token unexpired
+
session active
+
account allowed
```

Thus logout, administrative revocation, password change, suspension, and disablement take effect immediately.

## 11. Refresh-token persistence and rotation

One session defines one refresh-token family.
sessionId is the authoritative family boundary.

**One session = one refresh-token family.**

`session_id` is the authoritative family boundary. Reuse revokes the session and all credentials belonging to it.

Each refresh token contains:

```text
id
session_id
secret_digest
issued_at
expires_at
consumed_at
revoked_at
replaced_by_token_id
```

Every successful refresh consumes the current token and creates a replacement. `replaced_by_token_id` preserves rotation history. The first concurrent refresh wins; reuse of a consumed token revokes the session. The refresh operation is one atomic PostgreSQL transaction.

### Authenticated refresh consumption

Refresh consumption must authenticate both identifier and secret, inside the same transaction:

```sql
SELECT *
FROM identity.refresh_tokens
WHERE id = $1
  AND secret_digest = $2
FOR UPDATE;
```

Then:

1. no row → invalid credential; mutate nothing;
2. expired/revoked → reject; do not revoke the session merely because the credential is invalid;
3. consumed → treat as reuse and revoke the session/family;
4. active → consume and create the replacement atomically.

A valid token ID with an incorrect secret must never revoke the session.

Only one unconsumed refresh token may be active per session. Prefer a partial unique index conceptually equivalent to:

```sql
CREATE UNIQUE INDEX ...
ON identity.refresh_tokens (session_id)
WHERE consumed_at IS NULL AND revoked_at IS NULL;
```

The frontend must coordinate refresh across concurrent requests/tabs.

## 12. Recovery and verification tokens

Verification and reset credentials remain separate. Initial lifetimes:

```text
Email verification: 24 hours
Password reset:      30 minutes
```

Resending invalidates earlier capabilities. Password reset is single-use, expires, is consumed atomically, changes the password, revokes all sessions, and does not automatically authenticate the user.

## 13. Required constraints

Where PostgreSQL can enforce them:

```sql
CHECK (octet_length(secret_digest) = 32)
CHECK (expires_at > issued_at)
CHECK (replaced_by_token_id IS NULL OR replaced_by_token_id <> id)
UNIQUE (secret_digest)
UNIQUE (replaced_by_token_id)
```

The exact placement of uniqueness constraints must respect table lifecycle semantics. Other required constraints include unique normalized email, unique role code, unique `(user_id, role_code)`, valid account states, `TIMESTAMPTZ` timestamps, and restrictive internal foreign keys.

Security-event secrecy is **not** treated as a database constraint because `metadata` may be `JSONB`; it is an application-schema, redaction, and testing invariant.

## 14. Token-history retention

Consumed refresh-token records cannot be deleted immediately because they provide reuse evidence.

- retain refresh history until at least the session absolute expiry;
- retain consumed or revoked verification/reset tokens until at least their original expires_at;
- cleanup is an explicit maintenance operation;
- cleanup never removes records still required for active-session reuse detection.

## 15. Transaction boundaries

These use cases are atomic:

```text
Registration → user + credential + role + verification capability
Verification → consume token + activate account
Login → session + access token + refresh token + security event
Refresh → authenticate + consume old token + replacement + access token
Logout → revoke session + token family + access tokens
Password reset → consume token + change password + revoke all sessions
Role/state change → update state/authorization + revoke sessions + security event
```

Repositories participate in these transactions but do not independently create transaction boundaries.

## 16. Concurrency

Sensitive token consumption uses atomic conditional operations or row locking. The refresh lookup above is authoritative; application code must not rely on an earlier unlocked read. Concurrency-sensitive credential behavior is tested against real PostgreSQL.

Atomicity alone is insufficient: security-sensitive use cases must explicitly assess concurrent execution.

## 17. Durable security history

Introduce `identity.security_events` now. It is append-only through the application interface and records critical Identity events such as login success/failure, session revocation, refresh reuse, password changes/resets, role changes, suspension, and disablement.

Events may contain identifiers, timestamps, request IDs, actor/target IDs, and safe metadata. They must never contain passwords, password hashes, cookies, tokens, verification/reset secrets, CSRF secrets, private keys, or raw credentials.

Pino operational logs remain separate from durable security history.

## 18. Repository and module boundaries

Dependency direction remains:

```text
HTTP / transport
        ↓
application
        ↓
domain
        ↓
repository interfaces
        ↓
Identity persistence implementation
        ↓
PostgreSQL
```

Application/domain code must not import Kysely, `pg`, PostgreSQL row types, SQL fragments, or database clients. Other modules must not query `identity.*` directly.

## 19. Migration ownership

Identity migrations belong to the single global migration history established by ADR-010. Identity ownership does not imply separate databases, migration runners, or migration streams.

## 20. Testing requirements

Database-dependent Identity tests use real PostgreSQL, an isolated test database, and the committed migration history.

Coverage must include normalized-email uniqueness, password-credential cardinality, role uniqueness, digest uniqueness, expiry constraints, atomic registration/verification/login/refresh/logout/reset, authenticated refresh consumption, concurrent refresh, reuse detection, session revocation, security-event persistence, restrictive foreign keys, and token-history cleanup.

Concurrency-sensitive credential tests must use real PostgreSQL rather than only mocks.

## 21. Consequences

### Positive

- Clear Identity PostgreSQL ownership.
- UUIDv7 identifiers without treating UUID time ordering as business time.
- Explicit credential lifecycles.
- Efficient SHA-256 representation for high-entropy secrets.
- Authoritative session boundary for refresh-token families.
- Secret authentication before refresh mutation.
- Immediate server-side access revocation.
- Durable security history separate from operational logs.
- Database protection for enforceable invariants.

### Costs

- More tables and transactional orchestration.
- Durable security-event retention requirements.
- Database resolution for opaque access tokens.
- Real PostgreSQL concurrency testing.
- Explicit token-history cleanup.

## 22. Alternatives considered

### Shared `public` schema

**Rejected.** A dedicated `identity` schema makes ownership explicit.

### Separate Identity database

**Rejected for the current architecture.** It adds operational complexity without a demonstrated requirement.

### Separate refresh-token-family table

**Rejected.** One session defines one refresh-token family, making `session_id` the authoritative boundary.

### Generic credentials/tokens table

**Rejected.** Credential types have different lifecycle and security semantics.

### Application-generated UUIDs

**Rejected for persistent Identity entities.** PostgreSQL 18 provides native UUIDv7 generation.

### Database-managed dynamic permissions

**Deferred/rejected initially.** Two roles do not justify operationally mutable permission policy.

### Argon2id for random tokens

**Rejected.** High-entropy random tokens are appropriately represented by SHA-256 digests.

## 23. Deferred decisions

- Identity HTTP endpoints and request/response schemas;
- cookie and browser transport details;
- CSRF contract;
- authentication error semantics;
- frontend refresh coordination implementation;
- administrator bootstrap mechanism;
- internationalized email handling;
- privacy erasure;
- detailed security-event retention beyond token-history rules;
- production backup/restore policy;
- authorization policy beyond `user` and `admin`.

These are addressed by ADR-019 and subsequent decisions.

## 24. Reconsideration criteria

Revisit ADR-018 if Atlas introduces multiple Identity stores, an independently deployed Identity service, dynamic permissions, multiple credential providers, OIDC/social login, passkeys/WebAuthn, privacy-erasure requirements, materially different session/token semantics, a PostgreSQL major upgrade, or demonstrated performance limitations from server-side token resolution.

## 25. Related decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-011 — PostgreSQL Runtime and Local Development Strategy](ADR-011-postgresql-runtime-and-local-development-strategy.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract *(next decision)*

## 26. Status

**Proposed**

ADR-018 defines Identity persistence and security-state ownership but does not authorize migrations or Identity implementation.

The next architectural decision is **ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract**. After ADR-019 is reviewed and accepted, Identity schema migrations and implementation may begin.
