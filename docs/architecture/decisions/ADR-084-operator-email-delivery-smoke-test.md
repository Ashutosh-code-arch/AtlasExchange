# ADR-084: Operator Email Delivery Smoke Test

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-04

**Last reviewed:** 2026-09-04

**Canonical owner/source:** ADR-084

## Context

Brevo SMTP configuration is present on Render, but environment configuration and API readiness do
not prove mail delivery. Render Free has no shell or one-off jobs. The owner approved a protected
operator test action instead of the previously proposed CLI-only approach. This slice does not
authorize sending mail, a provider deployment, or public signup activation.

## Decision

- Identity owns an authenticated Profile action at `/api/v1/auth/operator-email-test`.
- `OPERATOR_EMAIL_TEST_ENABLED` defaults to false. Enablement requires demo, one explicit
  `OPERATOR_EMAIL_TEST_USER_ID` UUID, both public account-flow flags disabled, and the same explicit
  authenticated TLS SMTP configuration required by hosted account flows. Invalid activation fails
  startup. No role grant or database migration is required.
- GET reports availability only to authenticated users. POST requires the existing server session,
  exact-origin and signed double-submit CSRF controls, and the configured user ID. An admin role
  alone does not grant this permission. Every request uses the existing database-backed active
  account and unrevoked/unexpired session checks.
- POST accepts only an empty JSON object and no query parameters. The recipient is the account
  email loaded by server authentication, never a browser-supplied address. Active Identity accounts
  represent verified or deliberately operator-provisioned identities. No new verification/reset
  credential or account is created.
- The message has fixed plain text, no links or attachments, and mandatory TLS with bounded
  connection/greeting/socket timeouts. Files and URLs cannot be loaded into the message.
- Allow at most three SMTP attempts per 15 minutes and one in flight. Failures consume quota.
  This limiter is process-local and resets on restart; it is suitable for the explicitly trusted
  single operator, not a durable public abuse-control mechanism or a substitute for bot protection.
- Return 202 only on explicit SMTP acceptance for that recipient; this is not proof of inbox
  delivery. Ambiguous failures are not automatically retried. Operators check their inbox and
  provider logs before retrying because SMTP may accept a message before a connection is lost.
- Application diagnostic logs record a fixed event and bounded outcome, not provider error text,
  recipient, message body, or SMTP credentials. Existing request correlation remains in place.
- No email is sent on startup, GET, rendering, or health checks. No Cloudflare diagnostic flag or
  secret is needed. UI visibility is server-derived; backend authorization is decisive.

## Consequences

The test can exercise the actual Render-to-Brevo path without opening account registration. It is
not anonymous/public email sending, a verification bypass, or proof that verification/resend/reset
journeys work. API and web/gateway deployment are required before using the action. Disable the
test after receipt and before enabling either public account flow. The existing 20-account cap and
ADR-082 activation prerequisites remain unchanged.

See the [operator email test runbook](../../engineering/operator-email-test.md).
