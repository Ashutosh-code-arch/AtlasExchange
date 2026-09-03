# ADR-082: Capped Beta Registration

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-04

**Last reviewed:** 2026-09-04

**Canonical owner/source:** ADR-082

## Context

The owner approved public self-registration for a small simulated-trading beta of at most 15–20
users. Atlas previously disabled all public account flows in its one-account hosted demo.
This decision amends the account-access scope of ADR-075/076, not the zero-cost hosting or
simulated-only custody/execution boundaries. It does not assert that the beta is deployed.

## Decision

- Choose a hard ceiling of **20 total identities** in the demo environment, including the existing
  operator-provisioned identity. Pending, active, and suspended users all count; this is an account
  limit, not a concurrent-session limit or a verified-person count.
- Enforce capacity in Identity persistence, inside the same transaction as account creation.
  Capped registration and operator provisioning acquire a PostgreSQL table lock before checking
  capacity, using read-committed isolation. Concurrent requests cannot each take the final place.
- Operator provisioning cannot bypass the ceiling. Existing-identity lookup remains possible.
  The cap is an application invariant for supported creation paths, not protection against an
  administrator writing arbitrary SQL directly.
- When full, registration returns HTTP 409 with `BETA_CAPACITY_REACHED` identically for existing
  and new addresses. Do not expose identities, counts, credentials, or verification tokens.
- Rollback does not consume a place. A committed pending registration does consume one, even if
  email delivery fails. Existing resend/verification flows remain available when the cap is full.
- Keep email verification, password hashing, secure sessions, origin/CSRF checks, rate limiting,
  and ordinary-user role assignment. Public signup never grants administrative privileges.
- Add independent `PUBLIC_REGISTRATION_ENABLED` and `PUBLIC_PASSWORD_RECOVERY_ENABLED` switches
  to the API. Defaults remain enabled outside demo and disabled in demo. Gateway flags control UI
  visibility only; API flags and the database capacity check enforce policy.
- Local development remains uncapped. Every demo API process has a fixed ceiling of 20; do not
  raise it through an environment-variable change.
- Do not enable hosted account flows without verified email delivery. The current adapter is
  SMTP; demo activation requires explicit host, sender, credentials, and mandatory TLS. Reject
  known Render-blocked SMTP ports and the local Mailpit port. A compatible allowed-port provider
  must be tested, or a separately reviewed HTTPS delivery adapter must be added.

## Consequences and remaining activation work

An existing operator identity leaves at most 19 additional places. Suspensions and expired
verification links do not automatically free places; do not delete financial owners to reopen
signup. Bots can still occupy places, and one person may own multiple accounts. Existing rate
limits do not replace bot protection or abuse review.

This slice adds capacity and configuration support, not a complete public-launch approval.
Before activation, complete email-provider setup, bot/abuse controls, privacy/support disclosures,
and hosted verification/recovery testing. Per-account funding quotas and a pending-account
reclamation policy remain separate work. Keep free plans and the simulation warning intact.

No schema migration is required. No existing account is removed when a database already exceeds
20; new supported account creation is refused.

See the [capped-beta runbook](../../engineering/capped-beta.md) for rollout and shutdown steps.
