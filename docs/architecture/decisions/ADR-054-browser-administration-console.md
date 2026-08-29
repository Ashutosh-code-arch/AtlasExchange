# ADR-054 — Browser Administration Console

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-054

## Context

ADR-053 exposed exact-user Administration capabilities for privileged operators. Atlas now needs a
browser workflow that makes those capabilities usable without turning the initial console into a
general user-discovery system or weakening the authorization, idempotency, audit, and session
invalidation guarantees established by the API.

The surface changes security state. It must therefore distinguish server-confirmed records from
stale browser state, prevent accidental self-management, require explicit operational intent, and
avoid disclosing the existence of Administration tooling to ordinary authenticated users.

## Decision Drivers

The browser experience should:

1. mount and load only for a currently authenticated administrator;
2. preserve the exact-UUID lookup boundary and expose no user discovery;
3. display only the strict public Administration user representation;
4. require a reviewed reason and an explicit confirmation for every change;
5. preserve mutation idempotency across uncertain retries;
6. replace browser state only with a validated server response;
7. communicate target-session invalidation after accepted changes;
8. retain stale data honestly after a matching-record reload failure;
9. reset all private state when the authenticated identity changes; and
10. remain accessible and usable on narrow and wide viewports.

# Decision

Atlas will add an Administration console to the authenticated overview. The navigation entry,
lazy-loaded feature, and rendered region exist only when the current session reports the `admin`
role. The API remains the authoritative authorization boundary; the browser gate is defense in depth
and avoids unnecessary disclosure or data loading.

## 1. Exact identity lookup

The console accepts one exact Atlas user UUID and performs no request before an operator submits it.
It provides no email search, suggestions, directory, recent-user list, pagination, or bulk action.
A different submitted UUID clears the previously displayed record before loading. A successful
response must pass the strict shared contract and match the requested UUID before it is shown.

The visible record contains only email, user ID, state, canonical roles, creation time, and whether
the view is server-confirmed or stale. Password, credential, token, session, persistence, and audit
details are not browser data.

## 2. Supported controls and self-protection

The console exposes only the transitions accepted by ADR-053:

~~~text
active    → suspended
suspended → active

admin absent  → admin granted
admin present → admin revoked
~~~

Admin-role controls are available only for an active target. Pending-verification and disabled
identities are visible but operator-locked. When the loaded target equals the authenticated actor,
all mutation controls are replaced by a self-management warning. The server repeats these checks.

## 3. Reviewed intent and server confirmation

Every mutation has a separate trimmed 1–500 character reviewed-reason input and a button naming the
exact resulting action. Control characters and empty or surrounding-whitespace reasons are rejected
before transport. Reasons must not contain secrets, credentials, tokens, or unnecessary personal
data.

The displayed user changes only after a strict successful response confirms the requested target
and final state or role assignment. Accepted state and role changes explicitly tell the operator
that target sessions were revoked and that fresh authentication is required. There is no optimistic
security-state update.

## 4. Operation identity and retry

Each new mutation intent receives a browser-generated UUID `Idempotency-Key`. If transport or server
confirmation is uncertain, retrying the unchanged action, target, and reason reuses that UUID.
Changing any part of the intent creates a new UUID. A confirmed success or a new lookup clears the
retry identity.

The key is held only in the mounted feature instance. It is not written to local storage, session
storage, a URL, or analytics.

## 5. Loading, stale data, and lifecycle

Only one lookup is authoritative at a time; late results cannot overwrite a newer request. A failed
reload of the same UUID may retain the last valid record, but the record is labelled stale and all
mutation controls are disabled until a successful reload. A failed lookup for a different UUID does
not retain the previous identity.

The feature is keyed by authenticated user ID. Sign-out or user replacement unmounts the private
workspace and clears lookup state, reasons, messages, and operation identities. Atlas adds no
implicit polling to this console.

## 6. Safe errors and responsive presentation

Known Administration errors map to short operator guidance. Backend messages, request IDs,
constraint names, transport details, and private records are never rendered. Unexpected failures
leave the displayed user unchanged.

The console uses semantic forms, labelled fields, headings, status and alert regions, keyboard-
operable controls, visible disabled states, and a responsive one-column layout on smaller screens.
It follows the existing reduced-motion behavior.

## 7. Scope

This decision adds no user search, list, audit timeline, denial log, bulk operation, role catalog,
approval workflow, administrator impersonation, session viewer, external identity-provider tooling,
or persistent browser cache. Those capabilities require separate disclosure and operating-policy
decisions.

## Alternatives Considered

### Show the console to every signed-in user and rely only on API denial

Rejected because it needlessly discloses privileged tooling and loads code that the user cannot use.
Server authorization remains mandatory regardless of the browser gate.

### Search by email

Rejected because it would create a user-discovery surface before Atlas has accepted its disclosure,
normalization, pagination, rate-limit, and operator-policy rules.

### Optimistically update state

Rejected because the browser must not present a security change as accepted before the atomic
Identity mutation, session invalidation, and audit append have committed.

### Generate a fresh idempotency key on every retry

Rejected because an uncertain first response could make the repeated click a distinct logical
operation and lose ADR-053's retry guarantee.

### Keep the last viewed user across sign-out

Rejected because privileged identity data and pending reasons must not cross authentication
lifecycles.

## Consequences

### Positive Consequences

- Administrators can safely exercise the initial user-management API through the product UI.
- Ordinary users receive no Administration navigation, feature mount, or private request.
- Exact lookup avoids introducing an accidental account directory.
- Reviewed reasons and explicit action labels make operator intent visible.
- Server-confirmed updates preserve the API's atomic security guarantees.
- Same-intent retries retain their durable operation identity.
- Stale records remain useful without enabling unsafe changes.

### Negative Consequences

- Operators must obtain the exact target UUID outside this console.
- There is no visible audit history or approval workflow.
- A stale record cannot be acted upon until a successful reload.
- Browser role gating reflects the current session and cannot replace server authorization.
- The first console supports only one target and one operation at a time.

## Reconsider When

Review this decision when Atlas accepts user discovery, delegated Administration permissions,
multiple concurrent operator workflows, durable draft reasons, audit viewing, dual approval,
administrator session inspection, bulk operations, or external identity-provider management.

## Related Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-052 — Administration Authorization and Audit Foundation](ADR-052-administration-authorization-and-audit-foundation.md)
- [ADR-053 — Administration User Management HTTP Contract](ADR-053-administration-user-management-http-contract.md)
