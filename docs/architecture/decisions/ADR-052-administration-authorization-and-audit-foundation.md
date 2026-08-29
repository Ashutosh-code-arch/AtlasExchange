# ADR-052 — Administration Authorization and Audit Foundation

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-052

## Context

Atlas needs an operational boundary for inspecting accounts and performing exceptional Identity
actions without turning authentication into implicit administration. The existing Identity model
already distinguishes `user` and `admin` roles, but a role name alone does not define the allowed
operations, the application enforcement point, or the durable evidence required for privileged
changes.

Administrative actions are high-impact and can affect access to financial and trading surfaces.
They must therefore be denied by default, attributed to a confirmed actor and session, reasoned,
retry-safe, and recorded atomically with the future state change. This increment establishes those
rules and persistence foundations before any administration HTTP route or browser surface exists.

## Decision Drivers

The foundation should:

1. expose a small explicit permission vocabulary rather than scattered role checks;
2. deny ordinary users and unknown permissions by default;
3. attribute every persisted privileged mutation to an actor, session, request, target, and reason;
4. make accepted audit facts immutable and idempotent;
5. allow the audit write to share the state-changing PostgreSQL transaction;
6. keep Identity state ownership inside Identity and technical persistence inside Administration;
7. prevent public self-promotion or accidental first-admin creation; and
8. avoid exposing an HTTP or browser capability before its contracts are reviewed.

# Decision

Atlas will introduce an Administration module containing an explicit admin-only authorization
policy and an append-only privileged-action audit log.

## 1. Authorization policy

The initial permission vocabulary is:

- `administration.users.read`;
- `administration.users.change_state`;
- `administration.roles.manage`; and
- `administration.audit.read`.

Every permission currently requires the existing `admin` Identity role. A caller without that role
is denied, and a permission not in the vocabulary is denied even when the caller is an admin. The
policy returns only the confirmed actor user ID, actor session ID, and request ID required by an
administration use case.

The policy is an application boundary, not an HTTP middleware convention. Every future
Administration use case must authorize the specific permission before reading or changing state.
Transport checks may reject earlier, but they cannot replace the use-case check.

No signup, profile, session, or public API flow may grant `admin`. Initial operator assignment and
emergency recovery remain an explicitly controlled deployment operation until a separate bootstrap
procedure is accepted. Future role management must prevent accidental removal of required
administrative access and must revoke or refresh affected sessions so cached session roles do not
outlive the change.

## 2. Audit facts

The initial privileged mutation vocabulary is:

| Action | Exact details |
|---|---|
| `identity.user_suspended` | `{ previousState: "active", newState: "suspended" }` |
| `identity.user_reactivated` | `{ previousState: "suspended", newState: "active" }` |
| `identity.admin_role_granted` | `{ role: "admin" }` |
| `identity.admin_role_revoked` | `{ role: "admin" }` |

Every accepted fact contains:

- a caller-supplied operation UUID for retry idempotency;
- the actor user and actor session;
- the exact action and constrained action-specific details;
- the target user;
- a trimmed human reason from 1 through 500 characters;
- the bounded request ID;
- the authoritative occurrence time; and
- database-generated record and creation identifiers.

Facts contain IDs and state transitions, not credentials, password hashes, session tokens, CSRF
values, secret material, or copied account records. Operators must not place secrets or unnecessary
personal data in the reason field.

## 3. Persistence and immutability

Migration 0015 creates `administration.audit_events`. It enforces the action vocabulary, exact JSON
detail shape, actor/session ownership, target existence, reason and request constraints, operation
uniqueness, UUIDv7 record IDs, and timeline indexes for target and actor review.

Database triggers reject updates and deletes. Applied facts are corrected by appending a new
accepted fact rather than rewriting history. This is application-level tamper resistance; it is not
cryptographic non-repudiation and does not claim protection from a database superuser or backup
administrator.

An identical retry with the same operation UUID returns the existing event. Reuse of that UUID with
changed actor, session, action, target, reason, details, request, or occurrence time fails as an
idempotency conflict.

## 4. Transaction boundary

The audit writer can bind to either the application database or an existing Kysely transaction.
Every future privileged mutation must change the Identity state and append its audit fact in the
same application-owned PostgreSQL transaction:

~~~text
authorize specific permission
             ↓
begin application transaction
             ↓
change Identity state + append Administration audit fact
             ↓
commit both, or roll back both
~~~

An audit failure must prevent the privileged state change. The audit module does not own Identity
tables or decide the business transition; Identity remains the state authority and exposes the
narrow transaction-bound capability needed by the Administration use case.

## 5. Scope boundary

This increment provides no administration router, shared HTTP contract, browser console, user
search, role mutation, account-state mutation, audit reader, denial log, export, or retention job.
It creates the policy, typed audit domain, transaction-capable writer, and schema needed to build
those capabilities safely in later increments.

## Alternatives Considered

### Check `admin` directly in each route

Rejected because route-local checks produce inconsistent permission names, omit non-HTTP callers,
and make deny-by-default behavior difficult to prove.

### Audit after committing the state change

Rejected because a crash or audit failure could leave a privileged change without durable evidence.

### Store unstructured action names and arbitrary JSON

Rejected because unconstrained facts drift silently and cannot provide reliable operational or test
evidence.

### Allow audit updates for corrections

Rejected because rewriting the original fact destroys the historical sequence. Corrections should
be new facts under a separately accepted action when that capability is required.

### Add administration HTTP and UI now

Rejected because authorization, mutation contracts, disclosure rules, search limits, CSRF, and
browser behavior require focused decisions and tests of their own.

## Consequences

### Positive Consequences

- Privileged capability is explicit, admin-only, and denied by default.
- Future use cases have a framework-neutral application authorization boundary.
- Accepted mutations can be actor-, session-, target-, reason-, and request-attributed.
- Typed facts and database constraints prevent ambiguous action payloads.
- Operation idempotency makes retries safe and changed retries visible.
- Transaction binding allows state and evidence to commit or fail together.
- No administrative attack surface is exposed by this increment.

### Negative Consequences

- The initial role model is coarse; every accepted permission maps to one `admin` role.
- There is not yet an application reader for the audit timeline.
- Free-form reasons require operator discipline even though their shape is bounded.
- Database immutability does not defend against a sufficiently privileged database operator.
- Existing deployments must apply migration 0015 before running the updated API baseline.

## Reconsider When

Review this decision when Atlas needs delegated or read-only operational roles, dual approval for
sensitive changes, cryptographically verifiable or externally retained audit evidence, structured
reason codes, formal retention policy, denial auditing, multiple API replicas with centralized
policy, or regulatory controls beyond application-level immutability.

## Related Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-018 — Identity Data Model and Persistence Strategy](ADR-018-identity-data-model-and-persistence-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
