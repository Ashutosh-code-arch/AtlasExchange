# ADR-053 — Administration User Management HTTP Contract

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-053

## Context

ADR-052 established explicit Administration permissions and immutable privileged-action audit
facts without exposing an operational surface. Atlas now needs a deliberately narrow API for an
administrator to inspect one known user, suspend or reactivate that user, and grant or revoke the
initial `admin` role.

These operations affect access to every authenticated Atlas capability. The HTTP boundary must not
turn a role claim into sufficient authority, permit self-lockout, accept arbitrary account states,
commit an Identity change without its audit evidence, or allow a stale target session to retain
access after a security change.

## Decision Drivers

The API should:

1. authorize the exact permission inside both transport and application boundaries;
2. derive the actor exclusively from the authenticated access session;
3. keep Identity as owner of user, role, and session persistence;
4. commit a state or role change and its Administration audit fact atomically;
5. revoke target sessions after every successful security change;
6. make retried mutations idempotent and changed retries explicit;
7. prohibit self-targeted mutations and unsupported transitions;
8. validate and contain every request and response through strict shared contracts;
9. protect cookie-authenticated mutations with session-bound CSRF; and
10. avoid prematurely exposing user search, bulk actions, audit export, or browser behavior.

# Decision

Atlas will expose three authenticated Administration routes:

~~~text
GET   /api/v1/administration/users/:userId
PATCH /api/v1/administration/users/:userId/state
PATCH /api/v1/administration/users/:userId/roles/admin
~~~

Every response under `/administration` carries `Cache-Control: no-store`.

## 1. Authentication and authorization order

All routes first require a valid active access session. The confirmed context supplies the actor
user ID, actor session ID, current roles, and request ID. No actor or owner field is accepted from
the request.

The transport checks the exact permission before request-shape validation or rate-limit
consumption:

| Route | Permission |
|---|---|
| User read | `administration.users.read` |
| State change | `administration.users.change_state` |
| Admin-role change | `administration.roles.manage` |

Each application use case repeats that policy check. Authentication middleware is not the
authorization boundary, and possession of an otherwise valid CSRF token does not grant
Administration authority. Ordinary users and unknown permissions are denied with
`403 ADMINISTRATION_FORBIDDEN`.

## 2. Exact user lookup

The read route accepts one canonical UUID path parameter, no query fields, and no body. It returns:

~~~text
{
  success: true,
  data: {
    user: {
      id,
      email,
      state,
      roles,
      createdAt
    }
  }
}
~~~

Roles use canonical `user`, then optional `admin` order. The representation excludes normalized
email, password data, tokens, session details, security events, audit facts, wallet or order data,
and persistence metadata.

An absent UUID returns `404 USER_NOT_FOUND`. This increment adds no list, email search, fuzzy
search, pagination, bulk lookup, or cross-domain account aggregation.

## 3. State changes

The state route accepts a strict body containing `state` and `reason`. Only these transitions exist:

~~~text
active    → suspended
suspended → active
~~~

`pending_verification` and `disabled` cannot be entered or exited through this API. Repeating the
desired state under a new operation, or requesting a transition from any unsupported source state,
returns `409 USER_STATE_CONFLICT` without an audit fact.

The actor cannot target their own user ID. A self-targeted request returns
`409 ADMINISTRATION_SELF_TARGET_FORBIDDEN` before opening the state-changing transaction. This
prevents accidental self-suspension while preserving a separate future path for reviewed emergency
or multi-approver operations.

## 4. Admin-role changes

The role route accepts a strict body containing boolean `assigned` and `reason`. It changes only the
`admin` role. The baseline `user` role remains present and cannot be changed through
Administration.

The target must be active, the actor cannot target themselves, and the requested assignment must
differ from current state. Unsupported requests return `409 USER_STATE_CONFLICT` or the same
self-target response used by account state changes.

Role mutations are serialized by a transaction-scoped PostgreSQL advisory lock in addition to the
target user lock. The initial self-target prohibition ensures an active authenticated administrator
cannot remove the role supporting their current operation. Broader quorum and dual-approval rules
remain future policy.

## 5. CSRF, idempotency, and reasons

Both mutation routes require:

- the allowed browser origin;
- matching session-bound CSRF cookie and header values;
- a UUID `Idempotency-Key` header;
- no query fields; and
- a trimmed reason from 1 through 500 characters with no control characters.

The idempotency UUID becomes the Administration audit operation ID. The operation is locked before
inspection. A retry by the same actor with the same action, target, reason, and typed details returns
the current authoritative user representation and does not write another fact. A changed actor,
action, target, reason, or details returns `409 IDEMPOTENCY_CONFLICT`.

The durable first event retains its original actor session, request ID, and occurrence time. A
logical retry may arrive through a later request ID or a later valid session belonging to the same
actor; those transport facts do not rewrite the first event. Direct audit-writer retries remain
strictly identical as established by ADR-052.

Reasons are operational evidence, not a place for credentials, tokens, secret material, copied
account records, or unnecessary personal data.

## 6. Atomic Identity ownership and session invalidation

Administration owns orchestration and the audit fact. Identity owns all SQL that reads or changes
`identity.users`, `identity.user_roles`, and `identity.sessions`, exposed through a narrow public
transaction-bound store.

Every accepted mutation executes as:

~~~text
authorize permission
        ↓
lock operation and target
        ↓
validate current Identity state
        ↓
change Identity state or admin role
        ↓
revoke every active target session
        ↓
append immutable Administration audit fact
        ↓
commit all, or roll back all
~~~

Session revocation occurs for suspension, reactivation, role grant, and role revocation. A target
must authenticate again after the operation, so no browser session can continue with pre-change
security context. The actor's session is not revoked because self-targeted mutations are forbidden.

An audit constraint or persistence failure rolls back the Identity mutation and session revocation.
No cross-module table access is added to Administration.

## 7. Validation, response containment, and errors

Strict `@atlas/contracts` schemas define path parameters, mutation headers, both request bodies, the
user response, and the bounded error vocabulary. Unknown properties, malformed UUIDs, repeated
headers, query fields, invalid states, invalid reasons, and malformed output fail closed.

The accepted error codes are:

- `ADMINISTRATION_FORBIDDEN`;
- `ADMINISTRATION_SELF_TARGET_FORBIDDEN`;
- `AUTHENTICATION_REQUIRED`;
- `CSRF_FAILED`;
- `IDEMPOTENCY_CONFLICT`;
- `INTERNAL_SERVER_ERROR`;
- `RATE_LIMITED`;
- `USER_NOT_FOUND`;
- `USER_STATE_CONFLICT`; and
- `VALIDATION_FAILED`.

Unexpected failures and invalid internal output use the generic `500 INTERNAL_SERVER_ERROR`
containment. Database errors, constraint names, role assignment metadata, audit internals, and
transport exceptions are never returned.

## 8. Rate limiting and scope

Reads allow 60 accepted requests per authenticated actor per minute. Mutations share a separate
limit of 20 accepted requests per actor per minute. Invalid and unauthorized requests do not consume
capacity. Keys are process-local SHA-256 actor digests rather than raw user IDs.

The limiter is resource protection for the initial single API instance, not durable authorization,
abuse evidence, or an operational quota.

This increment adds no migration, browser console, user list/search, audit reader, denial log,
notification, approval workflow, bulk action, role catalog, or external identity-provider
integration.

## Alternatives Considered

### Let routes update Identity tables directly

Rejected because it would violate module ownership and make transaction, session, and invariant
rules a transport concern.

### Allow arbitrary target states

Rejected because `pending_verification` and `disabled` have separate lifecycle meanings that a
generic administrative patch must not bypass.

### Permit self-suspension or self-role revocation with a warning

Rejected because a warning does not prevent accidental loss of administrative recovery access.

### Leave target sessions active after a role or state change

Rejected because an already authenticated browser could continue under a security context that no
longer reflects the operator's decision.

### Record audit asynchronously after commit

Rejected because privileged state could change without durable evidence.

### Search users by email in the first API

Rejected because user discovery requires separate pagination, normalization, disclosure, abuse,
and operator-workflow decisions. Exact UUID lookup is sufficient to prove the management boundary.

## Consequences

### Positive Consequences

- Administration now has a strict, small, and testable user-management API.
- Identity remains authoritative for user, role, and session persistence.
- Privileged state and its immutable evidence commit or roll back together.
- Target sessions cannot retain pre-change security context.
- Self-targeting and unsupported lifecycle transitions fail before mutation.
- UUID operation locking makes concurrent and cross-request retries deterministic.
- Shared contracts contain private output and safe errors.

### Negative Consequences

- Operators must already know the target UUID; there is no search surface.
- A reactivated or newly promoted user must sign in again.
- Every role mutation serializes through one advisory lock.
- Process-local rate limits are not coordinated across future API replicas.
- Idempotent replay returns the current user representation rather than a stored historical response.
- There is still no browser workflow for these capabilities.

## Reconsider When

Review this decision when Atlas needs user discovery, delegated administration roles, dual approval,
bulk operations, permanent disabling, administrative session inspection, distributed rate limiting,
external identity providers, retained response snapshots, or cryptographically independent audit
evidence.

## Related Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-018 — Identity Data Model and Persistence Strategy](ADR-018-identity-data-model-and-persistence-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-052 — Administration Authorization and Audit Foundation](ADR-052-administration-authorization-and-audit-foundation.md)
