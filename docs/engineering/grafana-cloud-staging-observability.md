# Atlas Grafana Cloud Staging Observability Runbook

**Classification:** Canonical

**Status:** Archived

**Last reviewed:** 2026-08-31

This historical runbook implements superseded ADR-069. ADR-075 defers its private collector for the
initial zero-cost demo. It does not authorize a Grafana or Cloudflare account change,
provider spend, public endpoint, secret creation, or staging deployment.

## Current state

```text
Collector implementation:       committed; not deployed
Collector release image:        v0.1.1 digest published and provenance verified
Grafana Cloud stack:             no evidence
Metrics remote write:            not configured
Dashboard imported:             no
Alert rules/contact point:       no
External readiness synthetic:    no
Cloudflare monitor service token:no
Notification firing/recovery:    not tested
monitoring-alert-delivery:       no-go
```

## Required external inputs

- [ ] Explicit approval to create a Grafana Cloud Free stack and confirmation that paid overage is
      disabled.
- [ ] Grafana stack region, owner, administrator, and recovery method.
- [ ] Live limits for active series, retention, active users, alert rules, and synthetic executions.
- [ ] Exact custom staging API hostname from ADR-068.
- [ ] Exact Render private API hostname and effective private port.
- [ ] Grafana Cloud Prometheus remote-write URL and username.
- [ ] Metrics-write-only Grafana access-policy token.
- [ ] Dedicated API metrics bearer token shared only by API and collector.
- [ ] Dedicated bounded-duration Cloudflare Access service token for the readiness probe.
- [ ] Operator-owned alert email address and approval to send test/firing/recovery messages.
- [ ] Two Grafana synthetic locations appropriate for the expected reviewer geography.

Do not paste secret values into this runbook, command history, screenshots, dashboard JSON, alert
annotations, readiness records, or support messages.

## Build and release contract

The release workflow publishes:

```text
ghcr.io/<owner>/atlas-metrics-collector:<version>
ghcr.io/<owner>/atlas-metrics-collector:sha-<full-commit>
```

Resolve and record the exact multi-platform digest and provenance. The local build contract is:

```bash
pnpm observability:validate
docker build --file infra/observability/alloy/Dockerfile \
  --tag atlas-metrics-collector:local .
```

The Docker build executes `alloy validate` with non-secret validation-only values. Do not pass real
runtime credentials as build arguments or Docker secrets; the image contains none.

## Intended collector service

Create `atlas-metrics-collector-staging` as one image-backed **Render private service** in the same
Singapore project/region as the API.

```text
image:             ghcr.io/ashutosh-code-arch/atlas-metrics-collector@sha256:<candidate>
instances:         exactly 1
plan:              0.5c-512mb
public route:      none
port:              12345, private lifecycle/debug only
start command:     image default
health check:      Render private-service TCP probe on port 12345
autoscaling:       disabled
persistent disk:   none initially; record telemetry-gap consequence
```

The service requires:

```text
ATLAS_METRICS_TARGET=<exact Render private API host>:<effective private port>
METRICS_BEARER_TOKEN=<same dedicated value configured in API>
GRAFANA_CLOUD_PROMETHEUS_URL=<exact HTTPS remote-write URL>
GRAFANA_CLOUD_PROMETHEUS_USERNAME=<stack metrics instance ID>
GRAFANA_CLOUD_METRICS_TOKEN=<metrics-write-only access-policy token>
```

The generated Blueprint wires the private target from the API `hostport` and shares the generated
API metrics token through a Render service reference. Seal the remaining values. The target contains
no URL scheme or path. Never use the Cloudflare custom
hostname or public Render hostname for private collection. Confirm the remote-write URL is HTTPS;
TLS verification must remain enabled.

## Activation sequence

1. Recheck Grafana Cloud pricing, limits, region, and terms; record the zero-cost ceiling.
2. Create the Grafana stack with one accountable administrator and protected account recovery.
3. Create a token with metrics-write authority only; record its identifier, scope, expiry, and owner.
4. Generate an independent metrics bearer token and set the same value in API and collector.
5. Deploy the candidate API with metrics enabled on the exact private target.
6. Deploy exactly one collector digest and confirm its configuration is healthy.
7. In Grafana Explore, prove `up{environment="staging",job="atlas-api"} == 1` and verify the current
   `atlas_build_info` version.
8. Confirm expected active-series count is comfortably below 10,000 and no forbidden/high-cardinality
   labels exist.
9. Import `infra/observability/grafana/staging-overview-dashboard.json`, choose the stack's Prometheus
   data source, and inspect every panel under real traffic.
10. Create one folder named `Atlas staging` and implement the three exact active rules in
    `infra/observability/grafana/alert-policy.json` as Grafana-managed alerts.
11. Set missing-data and execution-error states to Alerting; attach severity, owner, action, and this
    runbook URL/anchor to every rule.
12. Create an email contact point with resolved messages enabled and route only the Atlas staging
    rules to it.
13. Create the Cloudflare/Grafana synthetic boundary described below.
14. Perform the contact, firing, recovery, and rotation tests before recording readiness evidence.

Stop if more than one collector is active, remote write requires plaintext, any credential appears in
logs, the metric series exceed the approved plan, dashboard queries leak unbounded labels, or Grafana
requires paid overage.

## External readiness synthetic

### Cloudflare service identity

Create one service token named `Atlas staging availability probe` with a bounded lifetime. Add one
Access policy to the existing two-host application:

```text
Action:   Service Auth
Include:  exact Atlas staging availability probe service token
Exclude:  none required beyond exact-token selection
```

Do not choose `Any Access Service Token`, `Everyone`, Allow, or Bypass. The token is for edge
admission only and conveys no Atlas session, role, user, CSRF authority, or Financial permission.

Store the Client ID and Client Secret as separate Grafana Synthetic Monitoring secure values. Secret
values must be retrieved only at check execution and must not appear in the script, logs, labels, or
screenshots.

### Check contract

Create a scripted API check named `Atlas staging API readiness`:

```text
target:               https://<exact staging API hostname>/health/ready
method:               GET
headers:              CF-Access-Client-Id and CF-Access-Client-Secret from secure values
redirect behavior:    fail unexpected Access login redirects
expected status:      200
timeout:              10 seconds
interval:             1 minute
locations:            2 distinct managed locations
alert after:           2 consecutive failed executions
missing observations: Alerting
```

Validate that the successful origin request contains a Cloudflare-signed assertion and that removing
the exact Service Auth policy produces denial rather than a false success. Recalculate monthly
execution use before saving; two locations every minute are at most 89,280 scheduled executions in a
31-day month before retries/provider accounting differences.

## Notification proof

1. Use Grafana's contact-point test and confirm receipt outside Grafana.
2. Controlled fault: stop the collector or temporarily set its private target to a reserved invalid
   private hostname through a reviewed Render configuration rollout.
3. Confirm `AtlasMetricsCollectionLost` enters Pending and then Firing after two minutes.
4. Confirm the email identifies staging, severity, rule, action, and runbook without exposing secrets.
5. Restore the exact correct target and confirm the rule becomes Normal and sends Resolved.
6. Separately remove the synthetic check's Service Auth policy, confirm two-location readiness failure
   and notification, then restore the exact policy and confirm recovery.
7. Rotate the metrics bearer and Cloudflare service-token secret with bounded overlap. Confirm old
   values fail after revocation and neither pipeline creates an unexplained observation gap.

Do not simulate success by editing the alert query to a constant. The test must exercise the real
collector or public probe path.

## Investigation procedures

### Metrics collection lost

1. Check whether the Grafana query returns no series or `up == 0` and identify the last good sample.
2. Verify one collector digest is running and its Render private service is healthy.
3. Inspect collector logs for scrape versus remote-write failure without printing request headers.
4. Verify private DNS/port reachability and that API `METRICS_ENABLED=true`.
5. Compare only secret fingerprints/rotation versions; never print either token.
6. Restore the last known-good collector digest/configuration and confirm both Firing and Resolved
   delivery.

### Market Data projection stopped

1. Confirm the candidate expects projection enabled and the API build/version is correct.
2. Inspect lifecycle logs for worker start, stop, and process-shutdown events.
3. Compare public projection freshness to authoritative Trading facts without mutating checkpoints.
4. Stop promotion when the read model cannot catch up safely; do not make projection failure control
   Trading transaction authority.

### Market Data projection failed

1. Inspect the most recent projection failure and request correlation in structured logs.
2. Compare maximum lag, consecutive failures, last failure, and oldest success metrics.
3. Check PostgreSQL readiness/pool pressure and event-loop delay for a shared cause.
4. Allow the accepted retry loop to recover or roll back the candidate; never edit checkpoints or
   projected rows manually during diagnosis.

### Public readiness probe failed

1. Compare both locations. One-location failure may be provider/local; both locations suggest the
   shared path.
2. Check DNS, certificate, Cloudflare Access decision, service-token expiry, origin assertion,
   Render routing, API lifecycle, and PostgreSQL readiness in that order.
3. Confirm Render's direct readiness result. A healthy direct probe with failed external probes
   narrows the fault to DNS/Cloudflare/public routing.
4. Never bypass Access, expose the Render subdomain, or make readiness permanently public as a fix.

## Dashboard and baseline review

Run representative staging identity, Trading, Financial, Market Data, notification, and
administration traffic plus the accepted HTTP performance workload. Record at least:

- request count/rate and 5xx count floor;
- p50/p95/p99 latency by bounded route group;
- database active/idle/total/max connections and waiters;
- event-loop p99/max delay under Argon2 and API load;
- projection lag, failure duration, and success freshness;
- admission rejection volume by fixed reason; and
- active series count and Grafana ingestion use.

Only then promote a baseline candidate into an active alert. Update the policy, its test, dashboard,
owner/action/runbook, and ADR evidence together.

## Evidence to retain

Retain sanitized references for:

- Grafana stack/region/plan owner and current limits;
- collector source revision, release digest, SBOM/provenance, Render resource, and deployment time;
- private target proof and failed public `/internal/metrics` proof;
- remote-write token identifier/scope/expiry and bearer-token rotation version;
- active-series count, retention setting, dashboard UID/revision, and data-source UID fingerprint;
- exact alert rule UIDs/revisions, contact-point fingerprint, and notification policy revision;
- Cloudflare service-token identifier/expiry and exact Service Auth policy revision;
- synthetic check ID, hostname fingerprint, locations, cadence, and monthly estimate;
- Firing/Resolved timestamps and external delivery proof for collector and public probe faults; and
- incident owner, response action, outcome, and next evidence expiry.

Redact domains when evidence leaves the operational boundary and always redact email addresses,
tokens, request headers, cookies, account IDs, and provider recovery data.

## Rollback

1. Disable Grafana alert routing before intentionally removing monitored services.
2. Stop the collector private service and revoke the metrics-write token.
3. Disable/delete the exact Cloudflare Service Auth policy, then revoke its service token and secure
   values.
4. Disable the synthetic check and remove the imported dashboard/rules only after evidence export.
5. Set API metrics back to disabled only if no approved collector remains.
6. Preserve sanitized failure evidence and keep `monitoring-alert-delivery` at `no-go`.

Rollback must not expose `/internal/metrics`, weaken Access, enable a public Render subdomain, or reuse
a revoked token.

## Stop conditions

Stop activation when Grafana live limits or region are unacceptable, paid overage cannot be disabled,
the collector cannot stay private, TLS verification must be bypassed, a metric contains sensitive or
unbounded labels, more than one collector owns the target, no-data is configured healthy, the probe
requires a committed/browser-visible secret, Service Auth grants more than the exact token, firing or
resolved delivery does not reach the operator, or evidence cannot identify the exact candidate.
