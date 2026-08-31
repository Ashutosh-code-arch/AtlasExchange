# ADR-071 — Staging Smoke Execution and Sanitized Evidence

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-08-31

**Last reviewed:** 2026-08-31

**Canonical owner/source:** ADR-071

## Context

ADR-066 requires candidate-bound staging smoke evidence before traffic. ADR-068 protects the web and
API behind Cloudflare Access, and ADR-070 creates a release-specific Render deployment contract. A
green Render deployment or direct health probe still does not prove that the public edge, origin
assertion, runtime configuration, public contracts, Atlas session, and private read models work
together.

The existing E2E suite owns disposable local infrastructure and intentionally mutates test data. It
must not be pointed at a persistent shared staging database. Conversely, a live staging check must
not put Cloudflare credentials, Atlas passwords, cookies, traces, or private payloads in Git or test
artifacts.

This decision adds repository capability only. No account, service token, synthetic identity,
provider resource, traffic, or evidence is created by accepting it.

## Decision Drivers

The staging smoke boundary should:

1. run only when explicitly invoked against exact HTTPS custom origins;
2. prove the request path through Cloudflare Access and Render rather than bypassing the edge;
3. bind every result to the candidate version, revision, and three image digests;
4. use a dedicated, bounded machine identity rather than a reviewer or monitoring credential;
5. validate responses with the same shared contracts used by Atlas applications;
6. avoid financial, trading, administrative, and notification mutations in its automated baseline;
7. keep secrets and private values out of traces, screenshots, reports, logs, and evidence;
8. write a deterministic, short-lived, machine-readable evidence summary; and
9. state clearly what additional proof is required before `synthetic-smoke-tests` may pass.

# Decision

Atlas adds an **opt-in read-only staging smoke suite** under `tests/e2e/staging-specs`, executed with:

```bash
pnpm test:staging
```

It uses Playwright's API request context because that workspace already owns the cross-application
test boundary, browser-capable HTTP stack, and isolated test tooling. It has a separate configuration,
test directory, output directory, and command from local `pnpm test:e2e`. Running ordinary local or
repository tests never contacts staging.

## 1. Admission and identity boundary

The suite uses one dedicated Cloudflare Access service token named `Atlas staging smoke runner` and
one exact Service Auth policy. It must not reuse the continuous availability-probe token, a reviewer
session, a Cloudflare administrator token, or the Atlas account password.

The service token:

- is scoped only to the two-host Atlas staging Access application;
- has a bounded lifetime and named owner;
- is stored only in an approved runtime secret store or operator environment;
- is rotated and revoked independently; and
- grants edge admission only, never Atlas user or administrative authority.

Atlas authentication uses one separately managed, verified, non-admin synthetic account. The email
and password are external secret/input values. The account must contain no real-person data, real
custody, external-market connection, or privileged role.

## 2. Automated read-only coverage

The suite proves:

- API liveness, readiness, and exact application version;
- protected web HTML and its exact runtime API-origin script;
- public asset and market catalogs;
- BTC-USD order-book, ticker, and candle contract validity;
- verified synthetic-account login and secure session establishment;
- current-user and session-list behavior;
- owner-scoped wallet, order, trade, portfolio, and notification reads; and
- CSRF-protected logout followed by authentication denial.

Except for session creation and cleanup, the suite performs no mutations. It does not create users,
wallets, deposits, withdrawals, orders, trades, notifications, role changes, or database fixtures.
This makes repeated execution safe against persistent staging state and keeps simulation feature
flags disabled.

## 3. Configuration and secret handling

Every invocation requires the owned registrable domain, exact web/API origins beneath it, stable
version, full source revision, immutable API, web, and collector digests, a new evidence output path,
dedicated Access token values, and synthetic Atlas credentials.

Secret values are accepted only through environment variables. They are never command arguments or
evidence fields. The staging Playwright configuration disables traces, screenshots, and video. The
custom reporter records only test names, status, duration, exact non-secret release identity,
origins, timestamps, scope, and overall outcome. It refuses to overwrite an existing evidence file
and requests owner-only file permissions.

Test failures report bounded route labels and HTTP statuses rather than request headers, credentials,
cookies, or response bodies. Evidence must be written outside the repository to a restricted path.

## 4. Evidence authority

The reporter marks the artifact `scope: read-only-partial` and expires it after 24 hours, matching
ADR-066's maximum freshness for `synthetic-smoke-tests`. A passed artifact proves only the automated
checks listed above for its exact candidate and endpoints.

It is **not sufficient by itself** to mark `synthetic-smoke-tests` passed. The accountable operator
must also retain candidate-bound evidence for:

- normal invited-user browser admission and revocation;
- registration or verified-account lifecycle as appropriate;
- two-user owner-isolation attempts against known resources;
- a reviewed Financial and Trading lifecycle using synthetic state;
- Market Data WebSocket negotiation, snapshots, heartbeat, reconnect, and access revocation;
- direct-origin and default-subdomain bypass denial; and
- any other ADR-066/runbook checks affected by the candidate.

Those checks remain manual or require a later deliberately stateful staging-fixture decision. Atlas
will not make the read-only suite mutate durable state merely to turn one control green.

## 5. Failure and cleanup

Any missing or malformed input, unexpected status, invalid shared contract, wrong release version,
missing secure CSRF cookie, failed logout, or evidence-write failure makes the command fail. A failed
artifact is useful diagnostic evidence but cannot satisfy readiness.

The suite always attempts logout within its authenticated test. If the process is interrupted, the
bounded session expires under Identity policy and can be revoked from the synthetic account's session
list. Never weaken Access, origin assertion validation, CSRF, or cookie settings to make the suite
pass.

## Alternatives Considered

### Reuse the continuous availability-probe token

Rejected because a one-route uptime credential should not silently gain broad application-read
authority or share rotation and incident scope with release testing.

### Run the local mutable E2E suite against staging

Rejected because it provisions fixtures with direct database access, enables simulation mutations,
and assumes disposable infrastructure.

### Store Playwright traces and screenshots on failure

Rejected for this suite because request headers, cookies, account details, or private response state
can enter rich debugging artifacts. Reproduction uses sanitized logs and an explicitly controlled
interactive session.

### Treat direct Render health as smoke evidence

Rejected because it bypasses DNS, Cloudflare policy, signed origin admission, application contracts,
and authenticated behavior.

### Automate the complete stateful trading journey immediately

Deferred until staging fixture ownership, cleanup, simulation controls, two-user isolation resources,
and durable evidence handling are explicitly designed.

## Consequences

### Positive Consequences

- Atlas can repeatedly verify a deployed candidate without altering durable business state.
- Live responses are checked against shared application contracts.
- Evidence is candidate-bound, sanitized, machine-readable, and short-lived.
- Local E2E remains isolated and deterministic.
- Readiness cannot silently overclaim what the automated suite proved.

### Negative Consequences

- Staging needs a second Cloudflare service token and a maintained synthetic Atlas account.
- The automated baseline does not prove browser cookies, WebSockets, ownership denial, or mutations.
- Rich Playwright failure artifacts are intentionally unavailable.
- Live failures can arise from Cloudflare, Render, SMTP/account state, or Atlas and require runbook
  triage.

## Reconsider When

Review this decision when a disposable staging environment becomes available per release, secure
stateful fixture provisioning is implemented, service-token scope is too broad, browser automation
can use human Access admission safely, the suite needs multiple regions, or evidence moves to a
signed central store.

## External References

- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Cloudflare Access CORS behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/)
- [Playwright API testing](https://playwright.dev/docs/api-testing)
- [Playwright reporters](https://playwright.dev/docs/test-reporters)

## Related Decisions

- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-043 — Browser Market Data Streaming and Recovery](ADR-043-browser-market-data-streaming-and-recovery.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
- [ADR-068 — Staging Domain and Access-Control Boundary](ADR-068-staging-domain-and-access-control-boundary.md)
- [ADR-070 — Render Staging Blueprint Generation and Promotion](ADR-070-render-staging-blueprint-generation-and-promotion.md)
