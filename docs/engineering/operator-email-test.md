# Operator Email Test

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-09-04

**Canonical owner/source:** ADR-084

## Implementation versus activation

This capability requires a new API release and updated web/gateway assets. It is not present in
the immutable v0.2.2 release. Source implementation is not proof of deployment or email delivery.
Do not retag or overwrite v0.2.2. Follow the release runbook for a new version and digest.

No real email, live configuration, or signup flag should change during local verification. Automated
tests use fake SMTP transport; database integration tests use disposable local PostgreSQL databases.

## Enable a controlled test

1. Publish and deploy the updated API through the normal checks, then build/deploy updated web and
   gateway assets to the existing `atlas-exchange` Worker. Keep public signup and recovery disabled
   on Render and Cloudflare. Do not accidentally deploy to the default `atlas-exchange-demo` name.
2. Sign in to Atlas and copy **your own User ID** from Profile. Do not use another user's ID, an
   email address, or the word `admin`. No database account/role mutation is needed.
3. Confirm the Profile email is an inbox you control. The test always sends to that server-loaded
   account email; it does not have a recipient input.
4. In Render environment configuration, retain the verified Brevo SMTP settings and set:

   ```text
   OPERATOR_EMAIL_TEST_ENABLED=true
   OPERATOR_EMAIL_TEST_USER_ID=<your Profile User ID>
   PUBLIC_REGISTRATION_ENABLED=false
   PUBLIC_PASSWORD_RECOVERY_ENABLED=false
   ```

   These operator settings belong only to the API. Do not put the UUID or SMTP secrets in browser
   runtime configuration or commit live values. Save/redeploy and confirm readiness. No email is
   sent by deployment itself. Missing SMTP settings, blocked ports, or open public account flags
   will cause this diagnostic activation to fail startup.
5. Open Profile and click **Send test email** once. This click explicitly requests one external
   email. An authenticated account other than the configured operator cannot use the action.
6. A 202/acceptance message means the SMTP server accepted the recipient and message. Confirm
   receipt in the actual inbox/spam folder and compare Brevo's transactional delivery log. A
   provider-dashboard-only test does not prove the Render path. Keep credentials, full provider
   errors, recipient details, and email contents out of screenshots/shared logs.
7. After receipt, set `OPERATOR_EMAIL_TEST_ENABLED=false` in Render and redeploy. The UUID can be
   removed. Both public account flags must remain false until bot/abuse controls and the controlled
   verification, resend, and password-recovery journeys have been completed.

## Failure handling

- 401: sign in again. Suspended, disabled, pending, expired, or revoked access cannot send mail.
- 403/unavailable action: check the configured UUID, enablement, and session/CSRF state. Do not
  elevate the user's role or bypass CSRF to make it work.
- 429: respect `Retry-After`; the UI conservatively asks for a 15-minute wait. No automatic retry.
- 503/network error: acceptance is unconfirmed, not necessarily rejected. Check inbox and Brevo
  logs first. Review the SMTP login/key, verified sender, port 2525/STARTTLS, and provider account
  status. Never paste the SMTP key into chat or command arguments.

The limiter permits three attempts per 15 minutes per process and blocks concurrent sending. A
restart resets that limiter, so disable the test when finished. It is not a public abuse control.
This test does not modify identities, verification tokens, password-reset tokens, or financial data.
