# ADR-061 — Runtime and Market Data Projection Observability

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-061

## Context

ADR-058 established protected process metrics and ADR-060 added PostgreSQL pool saturation. Atlas can
now observe request latency, memory, admission pressure, and database connection demand, but it
cannot distinguish slow requests caused by event-loop starvation from external waits.

ADR-033 already makes the Market Data projection worker maintain exact per-market diagnostic state:
worker state, publication sequence lag, consecutive failures, and success/failure timestamps. That
state is available only through process-local code and structured logs. Scraping it should not
re-query PostgreSQL, recalculate lag, expose a public diagnostic endpoint, or create a second worker
status authority.

## Decision Drivers

The next observability increment should:

1. expose event-loop delay and utilization with Node's runtime-native instrumentation;
2. sample only when protected metrics are enabled;
3. align monitor startup and shutdown with the managed API lifecycle;
4. reuse the worker's existing diagnostic snapshot rather than querying persistence;
5. signal aggregate projection lag, failures, and state without market-code labels;
6. preserve Market Data failure independence from command API readiness;
7. emit only finite Prometheus values before the first runtime sample; and
8. avoid defining alerts or SLOs without production workload evidence.

# Decision

Atlas will extend the protected metric catalogue with lifecycle-managed event-loop observation and
aggregate Market Data projection diagnostics.

## 1. Runtime performance monitor

When `METRICS_ENABLED=true`, the composition root creates one `RuntimePerformanceMonitor`. It starts
after database readiness and stops after HTTP intake closes through the existing managed-worker
lifecycle. Disabled metrics create no event-loop delay histogram.

The monitor uses Node's native event-loop delay histogram at 20-millisecond sampling resolution and
event-loop utilization counters. Each scrape reports the interval since the previous scrape and then
resets delay observations and the utilization baseline.

The runtime metrics are:

| Metric | Type | Meaning |
|---|---|---|
| `atlas_nodejs_event_loop_utilization` | Gauge | Event-loop utilization ratio during the scrape interval |
| `atlas_nodejs_event_loop_delay_mean_seconds` | Gauge | Mean event-loop delay during the interval |
| `atlas_nodejs_event_loop_delay_p99_seconds` | Gauge | Event-loop delay p99 during the interval |
| `atlas_nodejs_event_loop_delay_max_seconds` | Gauge | Maximum event-loop delay during the interval |

Node reports delay in nanoseconds; Atlas exports seconds. Before the monitor starts or when a sample
is unavailable, Atlas emits zero rather than `NaN` or infinity. Utilization is constrained to the
inclusive range zero through one.

These values are scrape-interval gauges, not cumulative histograms and not request traces. Scrape
cadence therefore affects their interpretation and must be consistent in a future deployment.

## 2. Projection diagnostic source

The `MarketDataProjectionWorker` remains the sole owner of its diagnostic state. The metrics
collector reads `getStatus()` at scrape time. It performs no database call, does not mutate worker
state, and does not affect retry, polling, checkpoint, or readiness behavior.

If projection is explicitly disabled, the metrics show `running = 0`, zero discovered markets, and
zero aggregate values. If metrics are disabled, none of these series exist.

## 3. Aggregate projection metrics

The projection metrics are:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `atlas_market_data_projection_running` | Gauge | None | One while the worker is running, otherwise zero |
| `atlas_market_data_projection_markets` | Gauge | Fixed `state` | Count of markets in each worker state |
| `atlas_market_data_projection_max_lag` | Gauge | None | Maximum exact sequence lag across discovered markets |
| `atlas_market_data_projection_max_consecutive_failures` | Gauge | None | Maximum consecutive failures across markets |
| `atlas_market_data_projection_oldest_success_timestamp_seconds` | Gauge | None | Oldest latest-success time across markets |
| `atlas_market_data_projection_last_failure_timestamp_seconds` | Gauge | None | Most recent failure time across markets |

The `state` vocabulary is fixed to `starting`, `caught_up`, `behind`, `failed`, and `stopped`. Every
state is emitted on every scrape, including zero counts.

No metric contains a market code, publication sequence per market, error name, error message, fact
payload, order identifier, owner, or account data. Metrics answer whether projection is unhealthy;
the existing structured log identifies which market and error class requires investigation.

## 4. Readiness and alerting

Event-loop pressure and projection lag do not change `/health/ready` in this increment. Readiness
continues to represent lifecycle and PostgreSQL/schema compatibility. Trading commands remain
authoritative when projections are delayed, and the public Market Data contracts already expose
point-in-time freshness.

This ADR defines signals, not thresholds. Alert rules, scrape interval, evaluation duration,
notification routing, and SLOs require the selected deployment topology and representative load
evidence. Operators should evaluate event-loop pressure together with request latency, memory,
database waiters, projection failure state, and logs rather than treating one sample as a verdict.

## 5. Scope

This decision does not install a metrics collector, dashboard, alert manager, trace exporter, or
profiling agent. It does not expose an administrative worker-status endpoint, per-market metric
labels, CPU utilization, garbage-collection metrics, WebSocket connection metrics, or domain
business metrics. Those require separate cardinality, privacy, and operational decisions.

## Alternatives Considered

### Recalculate projection lag from PostgreSQL during every scrape

Rejected because scraping would consume database capacity and create another implementation of the
worker's already-defined lag semantics.

### Label every projection series by market code

Rejected initially because aggregate metrics are sufficient to detect the condition and existing
logs identify the affected bounded market. This preserves the strict metric-label policy without
reducing operational detection.

### Make lag or event-loop delay fail readiness

Rejected because no production threshold or duration evidence exists, and projection failure does
not remove Trading command authority. Incorrect thresholds could amplify load through restarts or
traffic churn.

### Sample runtime performance when metrics are disabled

Rejected because an unused monitor adds work and lifecycle state without an operator consuming the
signal.

## Consequences

### Positive Consequences

- Operators can distinguish event-loop saturation from database pool pressure and external waits.
- Projection backlog, persistent failure, and stale success are visible without a public endpoint.
- Metrics reuse authoritative in-memory diagnostics and add no scrape-time SQL.
- All label values remain finite, fixed, and free of market or customer identity.
- Monitor lifecycle and no-sample normalization are deterministic and tested.

### Negative Consequences

- Interval gauges depend on external scrape cadence and reset on process restart.
- Aggregate projection metrics require logs to identify the affected market.
- A 20-millisecond delay sampling resolution cannot describe shorter delay distributions precisely.
- No alerting or retention system consumes these signals yet.

## Reconsider When

Review this decision when Atlas selects a monitoring backend and scrape cadence, defines production
SLOs, observes event-loop or projection incidents, moves projection to a separate process, adds many
dynamic markets, needs per-market dashboards, or introduces tracing and continuous profiling.

## Related Decisions

- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-033 — Market Data Projection Worker Lifecycle and Lag Observability](ADR-033-market-data-projection-worker-lifecycle-and-lag-observability.md)
- [ADR-058 — Application Metrics and Protected Scrape Boundary](ADR-058-application-metrics-and-protected-scrape-boundary.md)
- [ADR-059 — HTTP Performance Baseline and Load-Testing Policy](ADR-059-http-performance-baseline-and-load-testing-policy.md)
- [ADR-060 — PostgreSQL Runtime Capacity, Timeout, and Saturation Policy](ADR-060-postgresql-runtime-capacity-timeout-and-saturation-policy.md)
