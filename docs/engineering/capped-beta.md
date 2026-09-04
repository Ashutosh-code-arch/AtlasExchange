# Capped Beta: Account Admission and Activation

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-09-04

**Canonical owner/source:** [ADR-082](../architecture/decisions/ADR-082-capped-beta-registration.md)

Human-verification policy is defined by
[ADR-085](../architecture/decisions/ADR-085-public-account-human-verification.md).

## Scope and current state

The code supports a maximum of **20 total demo identities**, including the existing operator
account and pending/suspended users. Public signup and password recovery remain off by default.
This document is not evidence of live deployment or working hosted email. Local signup remains
available and uncapped, using Mailpit.

## Behavior

- Below 20 accounts, a new signup creates a pending identity with the ordinary `user` role.
  Email verification is still required before sign-in/trading.
- At 20, valid signup requests receive `409 BETA_CAPACITY_REACHED` and the UI explains that the
  beta is full. Existing users may sign in and continue trading.
- Duplicate addresses keep the generic accepted response while capacity exists; at capacity,
  existing and new addresses receive the same full response.
- Registration, verification, and recovery rate limits remain active. Capacity failure may be
  preceded by normal request validation/rate-limit rejection.
- The operator provisioning command shares the ceiling. Its existing-account path still works.
- An email-delivery failure leaves a pending identity occupying a place; use resend after fixing
  delivery. Never expose verification tokens or mark public signups verified automatically.
- Expired verification links and suspended accounts do not free places. There is no automatic
  deletion, waitlist, or place-reclamation workflow in this slice.

## Before enabling hosted signup

For the restricted Render-to-SMTP delivery check while both public flags remain false, follow
the [operator email test runbook](operator-email-test.md). This requires the ADR-084 implementation
to be released/deployed; v0.2.2 does not contain it. Disable the diagnostic before opening public
flows. Successful test-email receipt does not replace testing verification, resend, and recovery.

1. Select and configure an email provider within the zero-cost policy. Do not add paid overage
   or transmit new credentials without operator authorization. Render Free blocks outbound SMTP
   ports 25, 465, and 587 ([Render documentation](https://render.com/docs/free)). The current
   adapter can use a provider-supported allowed port with TLS, such as 2525, but port availability
   alone does not prove delivery. Otherwise implement an HTTPS email adapter separately.
2. Verify the sender/provider requirements and test verification, resend, and password-reset
   delivery to real external inboxes. Test failure/retry behavior and links at the actual Worker
   origin. Do not use Mailpit, localhost SMTP, or shared demo credentials for public users.
3. Create a Cloudflare Turnstile Managed widget restricted to the exact Worker hostname. Store
   `TURNSTILE_SECRET_KEY` only on the API and set the public `TURNSTILE_SITE_KEY` only on the
   Worker. Confirm the runtime document contains the site key but never the secret, CSP permits only
   the required Cloudflare challenge script/frame origin, fabricated/replayed/wrong-action tokens
   fail, and provider outages fail closed. A 20-account ceiling still cannot prevent one person from
   creating multiple accounts. Review simulated-funding/order limits and provide privacy/support
   information, including the human-verification provider, appropriate for real account data.
4. Build/release and deploy the updated API, Worker, and web assets with flags still closed.
   No migration is needed. Do not serve new UI flags against an old API image. The existing
   `demo:deployment:generate` manifest remains an invitation-only deployment profile; it is not
   a beta activation manifest. Follow this runbook for the reviewed beta overlay.
5. Confirm the existing account count using a read-only query in the intended database:

   ```sql
   SELECT count(*) AS total_beta_accounts FROM identity.users;
   ```

   Every row counts. If there are already 20 or more, do not remove accounts automatically.
6. Configure the API email variables in provider secret/configuration storage:
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USERNAME`, `SMTP_PASSWORD`.
   For an authenticated STARTTLS submission service, use its documented port and
   `SMTP_SECURE=false`; Atlas still requires TLS before delivery. Keep passwords out of Git,
   shell command arguments, logs, and screenshots.
7. Deploy both human-verification keys while flags remain false. Once prerequisites pass, set
   `PUBLIC_REGISTRATION_ENABLED=true` and `PUBLIC_PASSWORD_RECOVERY_ENABLED=true` on the API, then
   restart/check readiness. Apply matching flags on the intended Worker only after the API is
   healthy. Missing keys fail closed; gateway flags are not authorization. Preserve existing origin
   variables and shared secrets; do not deploy to an accidental Worker name.
8. Confirm a new user can sign up, verify, sign in, fund simulated wallets, and trade against a
   different account. Confirm that all new accounts have only the ordinary user role. Exercise the
   20th/21st and concurrent-request boundary in an isolated database, not by filling the live beta.

## Close admission

Set `PUBLIC_REGISTRATION_ENABLED=false` on the API first, then on the Worker. The API setting is
authoritative even if a browser has cached old UI. Existing sessions and sign-in remain available.
This switch also closes resend-verification and verification of already-issued links. Pending
users must wait until the registration feature reopens and may then need a fresh link. Leave
password recovery enabled when email delivery works. When only the capacity ceiling is reached,
verification and resends remain available without changing any flag; do not flip the feature flag
just because the beta is full.

Closing signup is not account suspension and does not free places. Use audited administration
for abusive accounts. Do not weaken self-trade prevention, email verification, or ledger integrity.

## Verification

- `registration-capacity.integration.test.ts`: real PostgreSQL, rollback, mixed account states,
  concurrent signup/operator creation, and rejection beyond 20.
- `beta-config.test.ts`: fixed demo ceiling, safe defaults, independent switches, email prerequisites.
- Identity HTTP, authentication UI, and gateway tests: safe full response and explicit feature flags.
- Turnstile adapter/UI tests: exact hostname/action binding, bounded token, provider failure,
  fail-closed gateway configuration, and token transport.
- Run `pnpm verify` and the relevant browser journeys before release. Local test success is not
  evidence that the selected hosted email provider works.
