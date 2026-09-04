# ADR-085: Public Account Human Verification

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-05

**Last reviewed:** 2026-09-05

**Canonical owner/source:** ADR-085

## Context

Atlas has a hard ceiling of 20 demo identities. Existing origin checks, bounded request bodies,
global admission limits, and identity-route rate limits reduce abuse but do not distinguish a person
from an automated client. A bot could consume every remaining beta place or repeatedly trigger
hosted verification and recovery email. ADR-082 therefore forbids opening public account flows
until bot protection exists.

## Decision

- Use Cloudflare Turnstile Managed mode for the zero-cost demo. It fits the existing Worker boundary
  and usually avoids a visual puzzle while retaining an accessible interaction when risk requires it.
- Require a fresh Turnstile token for registration, verification-email resend, and forgot-password
  requests. Login remains protected by its independent rate limit; verification and password-reset
  token consumption do not create accounts or send email and do not require this challenge.
- The Worker publishes only `TURNSTILE_SITE_KEY` through the runtime document. The site key is a
  public identifier. `TURNSTILE_SECRET_KEY` belongs only in API secret storage and must never enter
  Git, web assets, Worker variables, logs, or screenshots.
- Browser completion is not authorization. The API calls Cloudflare Siteverify before invoking the
  Identity use case and requires success, the exact browser-origin hostname, and the expected action:
  `register`, `resend_verification`, or `forgot_password`.
- Tokens are bounded to 2,048 characters, expire quickly, and are single-use. The UI clears and
  recreates the widget after every attempted submission. Action or hostname mismatch is rejected.
- A provider rejection returns the stable public error `HUMAN_VERIFICATION_FAILED`. Network,
  timeout, non-success HTTP, or malformed provider responses fail closed as
  `HUMAN_VERIFICATION_UNAVAILABLE`; no account or email use case runs.
- Keep existing origin and rate-limit checks before Siteverify so attackers cannot use Atlas as an
  unbounded verification proxy. Human verification supplements rather than replaces capacity,
  rate limiting, email verification, suspension, and abuse review.
- In demo, enabling either public registration or password recovery without
  `TURNSTILE_SECRET_KEY` fails API startup. Enabling either Worker UI flag without a valid
  `TURNSTILE_SITE_KEY` fails gateway configuration. Flags remain false until keys and hosted
  journeys are verified.
- Permit only `https://challenges.cloudflare.com` in the Worker CSP `script-src` and `frame-src`
  when a site key is configured. Do not add inline-script or wildcard allowances.

## Consequences

Automated abuse becomes materially more expensive and cannot bypass the challenge by submitting a
fabricated browser field. Turnstile availability is now a dependency of enabled public account
actions, so those actions intentionally stop rather than fail open during an outage. Cloudflare
processes browser signals for this security function; Atlas must disclose this in its beta privacy
information before publication.

This decision does not activate signup, create a widget or credentials in Cloudflare, send email, or
prove the hosted user journeys. Separate environment-specific widgets should be used if staging and
production are introduced.

See the [capped-beta runbook](../../engineering/capped-beta.md) for activation order and evidence.
