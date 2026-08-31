# Atlas Staging Smoke Testing Runbook

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-08-31

This runbook implements ADR-071. It does not create a Cloudflare token, Atlas account, staging
environment, traffic approval, or readiness result.

## Current state

```text
Read-only smoke suite:              implemented; not executed against staging
Dedicated Access service token:     no evidence
Verified synthetic Atlas account:   no evidence
Exact staging origins:              not supplied
Candidate release identity:         no published candidate evidence
Restricted evidence store:          not selected
Stateful/browser smoke evidence:     not available
synthetic-smoke-tests control:       blocked
```

## External prerequisites

- [ ] Deploy one candidate from an ADR-070 generated and validated Blueprint.
- [ ] Confirm both Atlas custom origins are protected and origin assertion validation is active.
- [ ] Create a dedicated, bounded `Atlas staging smoke runner` Cloudflare service token.
- [ ] Add one exact Service Auth policy for that token; do not reuse the availability-probe token.
- [ ] Create and verify one non-admin synthetic Atlas account containing no personal or real-custody
      data.
- [ ] Select a restricted evidence directory outside the repository.
- [ ] Record the exact stable version, source revision, and three deployed image digests.

Keep the Access secret, Atlas password, cookies, and evidence directory outside Git. Use an approved
secret-injection mechanism that does not place values in shell history. New Cloudflare service-token
secrets may carry a credential-scanner-friendly prefix; never paste them into commands, tickets,
screenshots, or this runbook.

## Required invocation environment

The operator's secret/runtime environment supplies:

```text
ATLAS_STAGING_WEB_ORIGIN
ATLAS_STAGING_API_ORIGIN
ATLAS_STAGING_REGISTRABLE_DOMAIN
ATLAS_STAGING_EXPECTED_VERSION
ATLAS_STAGING_RELEASE_REVISION
ATLAS_STAGING_API_IMAGE_DIGEST
ATLAS_STAGING_WEB_IMAGE_DIGEST
ATLAS_STAGING_METRICS_COLLECTOR_IMAGE_DIGEST
ATLAS_STAGING_ACCESS_CLIENT_ID
ATLAS_STAGING_ACCESS_CLIENT_SECRET
ATLAS_STAGING_SMOKE_EMAIL
ATLAS_STAGING_SMOKE_PASSWORD
ATLAS_STAGING_SMOKE_EVIDENCE_PATH
```

Origins must be the exact custom HTTPS origins, never Render default subdomains. The evidence path
must name a new file outside the repository; the reporter refuses to overwrite it.

## Execute the read-only suite

After injecting the environment without printing it:

```bash
pnpm test:staging
```

The suite performs four serial groups:

1. API liveness, readiness, and exact application version;
2. protected web shell and exact runtime API configuration;
3. asset, market, order-book, ticker, and candle contract validation; and
4. synthetic login, current session, owner-scoped reads, CSRF logout, and post-logout denial.

Playwright traces, screenshots, and video are disabled. The suite creates only a bounded Atlas
session and attempts to remove it. It does not create or change business resources.

## Inspect the sanitized artifact

On completion, inspect the new evidence JSON without copying it into Git. Require:

- `environment` is `staging`;
- all candidate identity fields match the deployment record;
- both origins are exact custom origins;
- `scope` is `read-only-partial`;
- `outcome` and every check are `passed`;
- `observedAt` and `expiresAt` are canonical and no more than 24 hours apart; and
- the artifact contains no secret, cookie, email, user ID, balance, order, trade, or provider token.

An evidence-write failure makes the command fail. A failed artifact records only bounded check names
and status; investigate through provider/application logs without turning on secret-bearing traces.

## Complete the smoke control

Do not mark ADR-066's `synthetic-smoke-tests` control passed from the read-only artifact alone. Add
fresh evidence for:

- invited-user browser admission, eager cookies, revocation, and normal UI navigation;
- two-user ownership denial against known synthetic resources;
- reviewed synthetic Financial and Trading behavior with exact final balances;
- Market Data WebSocket negotiation, snapshots, heartbeat, reconnect, and revocation;
- direct Render/default-subdomain and hostile-origin bypass denial; and
- cleanup of temporary sessions and any deliberately created synthetic state.

Every piece must identify the same candidate and environment. If a stateful run requires temporarily
enabling simulated operations, obtain a separate reviewed time-bounded approval, use only synthetic
identities, restore the flags to disabled, and retain the configuration transition evidence.

## Stop conditions

Stop when the token reaches more than the two Atlas staging hosts, the account has admin authority,
the deployed version differs, a contract fails, credentials appear in output, evidence cannot be
stored privately, mutable actions occur unexpectedly, Access or origin validation is bypassed, or
the environment differs from the candidate record. Preserve sanitized failure evidence and keep the
readiness control blocked.
