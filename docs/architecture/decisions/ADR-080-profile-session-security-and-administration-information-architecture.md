# ADR-080 — Profile, Session Security, and Administration Information Architecture

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-03

**Last reviewed:** 2026-09-03

**Canonical owner/source:** ADR-080

## Context

Atlas has server-confirmed identity, rotating session credentials, session inventory and revocation,
and a restricted administration capability. The initial authenticated interfaces exposed these
controls but presented them as compact feature panels rather than complete account and operator
workspaces.

The product shell established by ADR-077 now needs a professional Profile route and a deliberately
restricted Administration route. Visual refinement must not weaken server authority, confirmation
requirements, self-target protection, exact-user lookup, idempotency, or safe error handling.

## Decision Drivers

The security workspaces should:

1. make the signed-in identity and server authority immediately visible;
2. explain the browser credential model without exposing credential material;
3. keep session review and revocation accessible but deliberate;
4. distinguish current and other sessions with lifecycle timestamps;
5. communicate Administration's exact-target and audit constraints before mutation controls;
6. preserve explicit confirmation for destructive session operations;
7. preserve reviewed reasons, self-target protection, and server-confirmed mutation results; and
8. remain clear on desktop and mobile.

## Decision

Atlas will present Profile as an identity and session-security workspace and Administration as a
restricted operator console. Both use the authenticated product shell's restrained, light visual
language and existing API contracts.

## 1. Profile and Identity

The Profile route will lead with the exact authenticated email, immutable user ID, assigned roles,
and a **Server confirmed** state. It will not infer or display personal details that Atlas does not
own.

The page will explain three security properties:

- browser storage contains no access token;
- protected session state is server confirmed; and
- session credentials rotate automatically.

These statements describe the established identity architecture. They do not reveal cookies,
tokens, hashes, or other credential material.

## 2. Active Sessions

Session inventory remains an explicit user action from Profile. When opened, it will display the
number of returned active sessions and distinguish the current session from other sessions.

Created, last-active, idle-expiry, and absolute-expiry timestamps remain server-provided and are
displayed in UTC. Session identifiers are not displayed because they do not help the user make a
revocation decision.

Revoking one session and signing out everywhere continue to require confirmation. The UI removes a
session only after the API confirms revocation. Failures use safe public messages and retain the
last trustworthy state.

## 3. Administration

Administration remains visible only to an authenticated user with the `admin` role. Its header and
pre-action safeguards will communicate:

- targets require an exact immutable user ID and there is no discovery interface;
- accepted changes create actor-attributed audit evidence; and
- access changes revoke the target's existing sessions.

The target record remains server confirmed and visibly stale after a failed reload. Account-state
and role controls continue to require an explicit reviewed reason and an idempotent operation
identity. Administrators cannot change their own access from this console.

The interface will not expose passwords, password hashes, session tokens, cookie contents,
credential families, or unrestricted user search.

## 4. Responsive Behavior

- Desktop may place identity and security cards side by side.
- Tablet stacks the cards while retaining compact security facts.
- Mobile stacks identity facts, safeguards, lookup controls, and session actions in task order.
- Destructive actions remain clearly labelled and are never reduced to icon-only controls.

## Alternatives Considered

### Use a generic settings page

Rejected because Atlas currently owns identity and session security, not a broad preference model.
Generic settings navigation would imply unsupported profile and product preferences.

### Display session identifiers and credential details

Rejected because these values do not improve ordinary security decisions and unnecessarily expose
implementation detail.

### Add administration user search

Rejected because exact-target lookup is a deliberate privacy and operational boundary. Discovery
requires a separate authorization, audit, pagination, and privacy decision.

### Merge Profile and Administration

Rejected because self-service session security and privileged changes to another identity have
different audiences, risks, and audit expectations.

## Consequences

### Positive

- Profile now behaves like a complete account-security workspace.
- Users can understand session authority without seeing secret material.
- Administration communicates its safeguards before controls become available.
- Existing revocation, confirmation, self-protection, and idempotency rules remain intact.
- Both workspaces align visually with the authenticated brokerage interface.

### Negative

- Profile does not yet support editing personal data or preferences.
- Session inventory intentionally omits device and location labels until trustworthy data exists.
- Administration still requires operators to obtain an exact user ID outside the console.

## Reconsider When

Review this decision when Atlas adds editable profile data, verified device metadata, security-event
history, multi-factor authentication, account preferences, a separately authorized user directory,
or more granular administration roles.

## Related Decisions

- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-077 — Authenticated Product Shell, Routing, and Interface Density](ADR-077-authenticated-product-shell-routing-and-interface-density.md)
- [ADR-079 — Account Activity, Portfolio, and Funds Information Architecture](ADR-079-account-activity-portfolio-and-funds-information-architecture.md)
