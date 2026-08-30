# ADR-058 — Application Metrics and Protected Scrape Boundary

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-058

## Context

Atlas has structured JSON logging, request correlation, lifecycle health, Market Data projection
diagnostics, and safe error contracts. Those signals explain individual events and current health,
but they do not provide bounded aggregate evidence for request volume, latency distribution,
admission rejection, process uptime, or memory use.

Phase 7 requires an initial metrics contract before deployment selects a monitoring service. The
contract must be useful to a Prometheus-compatible scraper without exposing identities, paths with
resource IDs, market codes, balances, request data, credentials, or unbounded label values.

Atlas is still one API process. It has no selected collector, alert manager, dashboard platform,
trace backend, ingress network, or replica aggregation strategy. The first implementation should
make those future integrations possible without pretending they already exist.

## Decision Drivers

The metrics boundary should:

1. expose a conventional pull-based text format without coupling Atlas to a monitoring vendor;
2. keep every label vocabulary finite and low-cardinality;
3. measure completed API traffic, latency, and coarse admission rejection;
4. expose basic process saturation evidence without logging or exporting secrets;
5. avoid counting the metrics scrape as application traffic;
6. remain disabled until an operator configures an authenticated scraper;
7. fail startup when enabled without a dedicated secret;
8. preserve health, logs, and metrics as distinct operational signals; and
9. defer tracing and distributed aggregation until Atlas has a concrete topology.

# Decision

Atlas will provide a process-local Prometheus text exposition at a protected internal HTTP route.

## 1. Initial metric catalogue

The API exports:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `atlas_build_info` | Gauge | `version` | One series identifying the running Atlas build |
| `atlas_process_uptime_seconds` | Gauge | None | Current process uptime |
| `atlas_process_resident_memory_bytes` | Gauge | None | Resident process memory |
| `atlas_nodejs_heap_used_bytes` | Gauge | None | Node.js heap currently used |
| `atlas_http_requests_total` | Counter | `method`, `route_group`, `status_class` | Completed version-one API requests |
| `atlas_http_request_duration_seconds` | Histogram | `method`, `route_group`, `status_class` | Completed version-one API latency |
| `atlas_http_admission_rejections_total` | Counter | `request_class`, `reason` | Coarse admission rejections from ADR-057 |
| `atlas_database_pool_connections` | Gauge | `state` | Current active, idle, and total runtime-pool connections |
| `atlas_database_pool_max_connections` | Gauge | None | Configured per-process runtime-pool maximum |
| `atlas_database_pool_waiting_requests` | Gauge | None | Requests waiting to acquire a runtime-pool connection |
| `atlas_database_pool_events_total` | Counter | `event` | Connect, remove, and error lifecycle events |

The duration histogram uses fixed upper bounds of 5, 10, 25, 50, 100, 250, and 500 milliseconds,
then 1, 2.5, and 5 seconds, plus positive infinity. Histograms are preferred over client-side
summaries because a future collector can aggregate bucket counters across replicas.

Process gauges are read when a scrape is rendered rather than maintained by a background timer.

## 2. Bounded label policy

HTTP methods normalize to:

~~~text
GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, OTHER
~~~

Status codes normalize to:

~~~text
1xx, 2xx, 3xx, 4xx, 5xx, unknown
~~~

Request paths normalize to one route group:

~~~text
identity
financial
trading
market_data
portfolio
notifications
administration
status
other
~~~

Metric labels must never contain a raw URL, query, route parameter, user ID, session ID, wallet ID,
order ID, notification ID, market code, peer address, email, asset quantity, price, balance,
idempotency key, request ID, error message, credential, or arbitrary caller-controlled string.

New labels or label values require an explicit cardinality and sensitivity review. Metrics are an
allowlisted public operational schema, not a generic serialization target.

## 3. HTTP instrumentation ordering

Instrumentation is mounted for `/api/v1` after request correlation and before admission limiting,
body parsing, authentication, and module routing. It observes the final response on the `finish`
event, so normal successes, validation failures, authorization failures, admission rejections,
missing API routes, and unexpected failures share one completion measurement.

The instrumentation does not measure health or metrics routes. Module-specific business metrics are
not inferred from HTTP responses; a later metric must be recorded at the boundary owning that fact.

## 4. Protected scrape route

Metrics are exposed only when `METRICS_ENABLED=true` at:

~~~text
GET /internal/metrics
~~~

The request must use a dedicated bearer value from `METRICS_BEARER_TOKEN`. Comparison is
constant-time after a length check. The token must contain 32–256 characters and is required when
metrics are enabled. It is covered by the existing authorization-header log redaction policy.

Missing or incorrect credentials return the standard no-store `401 AUTHENTICATION_REQUIRED`
response. Successful scrapes return Prometheus text format with `Cache-Control: no-store`.

The browser CORS allowlist does not admit the `Authorization` header, so this route is not a browser
application API. Phase 8 must additionally restrict the route at ingress or on a private monitoring
network. The bearer secret is defense in depth, not a substitute for network isolation or TLS.

Metrics are disabled by default. Disabled mode does not install the scrape route or application
instrumentation and therefore adds no metric-series state.

## 5. Registry and exposition ownership

Atlas will initially own a small registry that implements only its accepted counters, gauges,
histogram buckets, label escaping, deterministic series ordering, and Prometheus text rendering.

It will not use a process-global registry. The collector is constructed at the composition root and
injected into HTTP instrumentation, admission observation, and scrape delivery. This keeps tests
isolated and avoids duplicate registration during module reloads.

The registry has bounded series cardinality because all label dimensions are closed enumerations.
No external metrics client is added in this increment. Atlas may replace the renderer with a stable
official client later while preserving metric names, types, labels, and route behavior.

## 6. Relationship to logs and health

Each operational signal retains one purpose:

~~~text
Health   → should this instance receive or continue serving traffic?
Metrics  → how much, how slow, how saturated, and how often over time?
Logs     → what discrete event or failure occurred with request correlation?
Traces   → deferred until cross-service causality exists
~~~

Metrics do not contain request identifiers or replace security audit events. Logs do not need to
duplicate every metric increment. Health endpoints remain independent of metric availability.

## 7. Scope

This decision does not install Prometheus, Grafana, Alertmanager, OpenTelemetry, a trace exporter,
dashboards, alerts, service-level objectives, retention policies, remote write, multi-process
aggregation, event-loop metrics, Market Data lag gauges, domain business metrics, or ingress rules.
Database pool metrics are governed by ADR-060; the remaining signals require focused follow-up
decisions and deployment ownership.

## Alternatives Considered

### Use logs as metrics

Rejected because deriving every rate and latency distribution from log storage is expensive,
backend-specific, and does not establish a stable low-cardinality operational schema.

### Expose raw paths or resource identifiers as labels

Rejected because caller-controlled and resource-specific values create unbounded series cardinality
and can leak operationally unnecessary private data.

### Make metrics publicly readable

Rejected because process version, traffic, failure, latency, and saturation signals provide useful
reconnaissance even when they contain no direct customer data.

### Add OpenTelemetry immediately

Rejected because Atlas has no cross-service trace boundary or selected telemetry pipeline. A narrow
metrics contract solves the current aggregate-observation need without preselecting tracing,
collection, storage, or deployment vendors.

### Count metrics scrapes and health checks as API traffic

Rejected because monitoring cadence would distort product traffic and latency signals, and public
API exhaustion must not remove health or metrics visibility.

## Consequences

### Positive Consequences

- Atlas has a stable vendor-neutral initial metrics schema.
- HTTP volume and latency can be aggregated by finite operational dimensions.
- Admission pressure is visible without exporting network identity.
- Uptime and memory saturation have direct process-level signals.
- Metric cardinality and sensitive-data rules are explicit and tested.
- Scraping is opt-in, authenticated, non-cacheable, and isolated from product metrics.
- The collector can later be replaced without changing the accepted external names and labels.

### Negative Consequences

- Metrics disappear on process restart and are not aggregated across replicas.
- A custom narrow renderer requires compatibility tests and must not grow into a general client.
- Bearer-token rotation currently requires a process configuration rollout.
- No collector, dashboard, alert, or retention policy exists yet.
- The initial catalogue does not expose event-loop, worker-lag, or domain signals.

## Reconsider When

Review this decision when Atlas selects its deployment ingress or metrics backend, runs multiple API
replicas, needs exemplars or native histograms, introduces cross-service tracing, establishes SLOs,
requires additional saturation signals, or can adopt a stable official client without changing the
accepted metric contract.

## Related Decisions

- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-033 — Market Data Projection Worker Lifecycle and Lag Observability](ADR-033-market-data-projection-worker-lifecycle-and-lag-observability.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
- [ADR-057 — API Admission Rate Limiting and Abuse Protection](ADR-057-api-admission-rate-limiting-and-abuse-protection.md)
- [ADR-060 — PostgreSQL Runtime Capacity, Timeout, and Saturation Policy](ADR-060-postgresql-runtime-capacity-timeout-and-saturation-policy.md)
