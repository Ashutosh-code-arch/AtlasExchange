# ADR-069 — Staging Observability Collection, Alerting, and Availability

**Classification:** Canonical

**Status:** Superseded by ADR-075

**Date:** 2026-08-31

**Last reviewed:** 2026-08-31

**Canonical owner/source:** ADR-069

ADR-075 defers the paid/private collector topology for the initial zero-cost demo. The dashboard,
metric definitions, and alerting lessons remain reusable if production-shaped staging resumes.

## Context

Atlas exposes bounded Prometheus-compatible application metrics at a bearer-protected internal API
route. ADR-067 selects Render and requires a private collector plus an external telemetry store, but
does not select either component. ADR-066 also requires retained metrics, an operational dashboard,
actionable alert rules, continuous external availability evidence, and tested notification delivery
before staging can satisfy `monitoring-alert-delivery`.

The API origin is protected by Cloudflare Access for normal traffic while Render lifecycle probes and
private metrics use narrow exceptions. Monitoring must therefore prove two different paths:

```text
private collection → Render private network → /internal/metrics
public availability → Cloudflare Access → /health/ready
```

Provider products and limits change. The capabilities and prices in this decision were reviewed on
2026-08-31. Accepting this decision creates no account, token, alert contact, paid resource, public
endpoint, or monitoring evidence.

## Decision Drivers

The initial staging observability boundary should:

1. scrape the API only over Render's private network;
2. preserve ADR-058's bearer authentication and bounded-label contract;
3. retain metrics outside the collector and application process;
4. deploy the collector from the same immutable, scanned release authority as Atlas;
5. keep provider credentials outside images, Git, dashboards, and logs;
6. detect both private collection loss and public edge/readiness failure;
7. provide useful dashboards before inventing workload-dependent thresholds;
8. require every alert to have severity, owner, action, and runbook;
9. test both firing and recovery notification delivery; and
10. fit a solo developer's initial staging workload without silently accepting paid overage.

# Decision

Atlas selects **Grafana Alloy 1.19.2** as the private collector and **Grafana Cloud** as the initial
staging metrics, dashboard, alerting, and synthetic-monitoring destination.

Grafana Cloud Free is the initial plan hypothesis. At review time it includes 10,000 active metric
series, 14 days of metrics retention, 100,000 API synthetic executions, and three active Grafana
users. The operator must recheck the live plan and disable paid overage before account activation.
Production retention and support remain a later decision.

## 1. Collection topology

The intended path is:

```text
atlas-metrics-collector-staging (one Render private service)
       │ HTTP over Render private network
       │ Authorization: Bearer <dedicated scrape token>
       ▼
atlas-api-staging:<private-port>/internal/metrics
       │
       │ Prometheus remote write over verified HTTPS
       ▼
Grafana Cloud Metrics
```

The collector has no public route and runs in the same Render region/project as the API. It targets
one explicit Render private hostname and port; it must not scrape the Cloudflare hostname, default
Render public subdomain, or an arbitrary service-discovery result.

ADR-070 fixes the initial collector to Render's `0.5c-512mb` private-service plan and relies on
Render's private-service TCP health behavior rather than an unsupported HTTP health path. Its
generated Blueprint wires the API private `hostport` and generated API metrics token through Render
service references.

The same 32–256-character `METRICS_BEARER_TOKEN` is generated for the API and referenced by the
collector. Grafana Cloud remote write uses a metrics-write-only access-policy token and the stack's
Prometheus username and endpoint. None of these values enter source, image layers, command output,
or evidence.

Alloy scrapes every 30 seconds with a five-second timeout, 1 MiB body limit, 1,000-sample limit, 12
labels per sample, and bounded label-name/value lengths. Remote write adds only fixed
`environment="staging"` and `service="atlas-api"` labels. The application remains authoritative for
its metric names and bounded application labels.

## 2. Collector artifact and lifecycle

The collector is a third release artifact:

```text
ghcr.io/<owner>/atlas-metrics-collector:<version>
ghcr.io/<owner>/atlas-metrics-collector:sha-<full-commit>
```

Its Dockerfile pins the upstream multi-platform Alloy v1.19.2 index by digest, validates the committed
configuration while building, attaches Atlas release metadata, disables profiling, support bundles,
and product reporting, and runs with an unprivileged numeric user. The release workflow builds AMD64
and ARM64 images, publishes SBOM/provenance, and scans the collector with the same High/Critical gate
as the API and web images.

The collector keeps Alloy's remote-write write-ahead log under `/var/lib/alloy/data`. Initial staging
may use Render's ephemeral service filesystem because Grafana Cloud is the durable metric authority;
a collector restart can therefore create a visible telemetry gap. Add a persistent disk only after
measured outage requirements justify its cost and operational ownership. Metrics are operational
evidence, not a Financial or audit system of record.

Exactly one collector scrapes the one API replica. Overlapping collectors can submit out-of-order
samples and are prohibited during rollout. A replacement must stop the old instance before the new
instance takes scrape ownership.

## 3. Dashboard contract

`infra/observability/grafana/staging-overview-dashboard.json` is the importable staging dashboard.
It covers:

- private scrape-target availability;
- API request rate and status class;
- p95 request latency by bounded route group;
- PostgreSQL pool connections, maximum, and waiters;
- Node.js event-loop delay;
- Market Data projection running state, lag, and failures; and
- admission rejection rate.

The dashboard selects `environment="staging"` explicitly. It is an investigation surface, not proof
that alerts or readiness are working. Import must select the Grafana Cloud Metrics data source and
the resulting dashboard UID and revision must be recorded.

## 4. Alert policy

The machine-validated policy in `infra/observability/grafana/alert-policy.json` is the source for the
initial Grafana-managed rules. It immediately defines only conditions whose meaning does not require
a traffic baseline:

- private metrics collection missing;
- the expected Market Data projector stopped; and
- one or more Market Data projections in failed state.

Missing data and query errors are alerting states, not healthy states. Each rule has a severity,
pending duration, owner, response action, and runbook anchor. Grafana-specific rule identifiers and
the data-source UID remain deployment outputs because no Grafana stack exists yet.

HTTP 5xx, database pool pressure, event-loop delay, projection lag/freshness, memory, latency, and
admission pressure remain baseline candidates. Their queries are committed, but thresholds are not
activated until representative staging load establishes a count floor, threshold, duration, and
expected action. This preserves ADR-061 and ADR-066 rather than inventing production-looking numbers.

## 5. External availability probe

Grafana Synthetic Monitoring will execute one API readiness check from two geographically distinct
managed locations every minute with a ten-second timeout. It requests the exact custom staging API
origin at `/health/ready`, requires HTTP 200, and alerts after two consecutive failed executions or
missing observations.

The probe authenticates through Cloudflare Access with a dedicated, bounded-duration service token.
Cloudflare receives `CF-Access-Client-Id` and `CF-Access-Client-Secret`; the corresponding secret
values are stored only in Grafana Synthetic Monitoring's encrypted secret store. The Access
application adds one exact-token **Service Auth** policy. It must not use `Any Access Service Token`,
`Everyone`, or Bypass and grants no Atlas application identity or authorization.

Two locations at one-minute cadence consume at most 89,280 executions in a 31-day month before
retries or provider accounting differences. The operator must confirm the live allowance and reduce
cadence or locations before activation if the plan would exceed the approved zero-cost boundary.

Render's health check and the external synthetic answer different questions. Render proves direct
origin lifecycle; the synthetic proves DNS, certificate, Cloudflare policy/service authentication,
origin assertion validation, Render routing, API process, database readiness, and the response path.

## 6. Notification delivery

Initial alert delivery uses one operator-owned email contact point with resolved notifications
enabled. The exact address is an external input and is not committed. Notification policy routes only
the Atlas staging folder/rules to that contact point initially.

`monitoring-alert-delivery` remains failed until the operator:

1. sends a provider contact-point test;
2. causes a real Atlas alert to enter Firing through a controlled fault;
3. receives the notification outside the Grafana UI;
4. removes the fault and receives the Resolved notification;
5. records timestamps, rule revision, delivery destination fingerprint, and response action; and
6. confirms the evidence is no older than ADR-066's 30-day limit.

A dashboard screenshot, green synthetic tile, or provider test button alone is insufficient.

## 7. Privacy, retention, and authority

Only ADR-058/061's low-cardinality operational metrics may leave Render. No logs, request bodies,
raw paths, identities, IDs, email addresses, tokens, balances, orders, prices, quantities, or market
codes are added by the collector. Grafana access is least privilege; metrics-write and synthetic
secrets are separate from interactive administrator authority.

Fourteen-day Free retention is sufficient for initial staging troubleshooting but does not satisfy
Financial recordkeeping, security audit retention, or production support analysis. Those records
remain in their owning systems. The operator must review Grafana account region, data processing,
user access, deletion, and export behavior before production.

## Alternatives Considered

### Render built-in metrics only

Rejected because they do not scrape Atlas's accepted application metrics, preserve its label
contract, provide the committed dashboard, or prove external alert delivery.

### Publicly expose `/internal/metrics` to Grafana Cloud

Rejected because it violates ADR-058 and ADR-067's private collection boundary and makes bearer
authentication the only protection for operational reconnaissance data.

### Run Prometheus and Grafana on Render

Rejected initially because Atlas would own storage durability, upgrades, backups, availability, and
alert routing for two more stateful services. A managed free staging tier is proportionate.

### Use only synthetic monitoring

Rejected because availability probes cannot explain database pressure, latency distribution,
projection failure, event-loop pressure, or admission behavior.

### Activate all candidate thresholds immediately

Rejected because thresholds without representative load create false confidence and alert fatigue.

## Consequences

### Positive Consequences

- Application metrics remain private while storage and evaluation are external.
- The collector is reproducible, scanned, source-identifiable, and independently deployable.
- Dashboards and non-baseline alert rules are reviewable in Git.
- Missing telemetry fails closed in the alert policy.
- Public readiness is observed through the actual Cloudflare/Render path.
- The initial plan can fit a zero-cost small staging workload if live limits remain unchanged.

### Negative Consequences

- Staging adds Grafana Cloud and a third release/runtime artifact.
- Free metrics retention is only 14 days.
- Collector redeploys can lose WAL samples without a persistent disk.
- Grafana stack IDs and managed alert resources cannot be finalized before account creation.
- Service-token rotation spans Cloudflare and Grafana secret configuration.
- The first active alert set intentionally omits workload-sensitive thresholds.

## Reconsider When

Review this decision when active series or synthetic executions approach 80% of the live allowance,
14-day retention is inadequate, production support or data residency changes, collector gaps are
unacceptable, API replicas increase, logs/traces are selected, Grafana pricing or features change,
Cloudflare service authentication is unsuitable, or the solo notification path gains an on-call team.

## References

- [Grafana Cloud pricing](https://grafana.com/pricing/)
- [Grafana Alloy Prometheus scraping](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.scrape/)
- [Grafana Alloy remote write](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.remote_write/)
- [Grafana Alloy configuration validation](https://grafana.com/docs/alloy/latest/reference/cli/validate/)
- [Grafana Synthetic Monitoring secrets](https://grafana.com/docs/grafana-cloud/observe-and-act/testing/synthetic-monitoring/create-checks/manage-secrets/)
- [Grafana alert contact points](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Cloudflare Access service-auth policy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)

## Related Decisions

- [ADR-058 — Application Metrics and Protected Scrape Boundary](ADR-058-application-metrics-and-protected-scrape-boundary.md)
- [ADR-061 — Runtime and Market Data Projection Observability](ADR-061-runtime-and-market-data-projection-observability.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-065 — Software Supply-Chain, Vulnerability, and Secret Response](ADR-065-software-supply-chain-vulnerability-and-secret-response.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
- [ADR-067 — Initial Staging Platform and Managed PostgreSQL Provider](ADR-067-initial-staging-platform-and-managed-postgresql-provider.md)
- [ADR-068 — Staging Domain and Access-Control Boundary](ADR-068-staging-domain-and-access-control-boundary.md)
- [ADR-070 — Render Staging Blueprint Generation and Promotion](ADR-070-render-staging-blueprint-generation-and-promotion.md)
