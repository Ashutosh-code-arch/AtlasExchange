# ADR-059 — HTTP Performance Baseline and Load-Testing Policy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-059

## Context

Atlas now has explicit HTTP resource limits, coarse admission budgets, structured request logs, and
low-cardinality latency metrics. Those controls are configured from assumptions rather than a
repeatable load baseline.

Performance tests must distinguish evidence from ambition. A fast loopback status route does not
prove database capacity, order-matching throughput, settlement latency, WebSocket fan-out capacity,
or production behavior. It can establish that the API process boundary has no obvious regression
and provide a reproducible harness that later targets representative deployed workloads.

Timing assertions also behave differently from deterministic correctness tests. Running strict
latency thresholds on every developer machine or shared CI runner would create noise and incentivize
weak thresholds. Atlas needs a separate command, recorded environment, conservative development
objectives, and an explicit production re-baseline gate.

## Decision Drivers

The initial performance system should:

1. exercise a real TCP server rather than direct Express invocation;
2. include the accepted HTTP security, correlation, logging, metrics, and admission middleware;
3. use bounded concurrency, requests, timeouts, and memory;
4. report throughput and nearest-rank latency percentiles in machine-readable form;
5. fail on transport errors, non-success responses, or unmet explicit objectives;
6. avoid mutating product or financial state;
7. prevent accidental load against a remote environment;
8. keep timing thresholds outside the ordinary deterministic verification command; and
9. state clearly which production claims the baseline cannot support.

# Decision

Atlas will adopt a dependency-free Node.js HTTP load harness and a separate performance command:

~~~bash
pnpm test:performance
~~~

## 1. Initial scenario

The canonical first scenario is `http_status_edge`:

~~~text
GET /api/v1/status
~~~

By default the command starts an ephemeral API server on loopback and sends real keep-alive HTTP
requests through:

- Node HTTP server limits;
- explicit Helmet and CORS policy;
- request correlation;
- structured Pino request serialization to a discarded local destination;
- HTTP request metrics instrumentation;
- read admission limiting; and
- Express routing and response serialization.

The harness increases only its injected local admission capacity enough to admit the configured
warm-up and measured request count. It does not remove or bypass admission middleware.

The local server has no PostgreSQL dependency or business routers. This is an HTTP process-edge
baseline, not application or database capacity evidence.

## 2. Default workload and objectives

The initial development workload is:

| Setting | Default |
|---|---:|
| Warm-up requests | 200 |
| Measured requests | 2,000 |
| Concurrency | 25 |
| Per-request timeout | 2,000 ms |

The initial conservative objectives are:

| Objective | Development gate |
|---|---:|
| Failed or non-200 requests | 0 |
| p95 latency | ≤ 100 ms |
| p99 latency | ≤ 250 ms |
| Throughput | ≥ 100 requests/second |

The latency limits are not product SLOs. They are regression tripwires with substantial allowance
for development-machine variation. Production SLOs require representative endpoints, data,
hardware, network placement, logging transport, ingress, and sustained-duration evidence.

## 3. Measurement semantics

Each request duration begins immediately before Node creates the request and ends after the response
body ends, aborts, or errors. The measured wall-clock interval covers all concurrent requests.

The harness reports:

- exact requested, successful, and failed counts;
- elapsed measured duration;
- requests per second;
- minimum, median, p95, p99, and maximum latency; and
- whether every configured objective passed.

Percentiles use the deterministic nearest-rank method over sorted request samples. All samples are
bounded by the configured request maximum of 100,000. Request concurrency is bounded to 500 and
cannot exceed the request count.

Warm-up traffic is validated for failures but excluded from measured samples.

## 4. Configuration and reproducibility

The command accepts these execution-only environment variables:

| Variable | Default | Accepted range |
|---|---:|---:|
| `ATLAS_PERFORMANCE_REQUESTS` | 2,000 | 100–100,000 |
| `ATLAS_PERFORMANCE_WARMUP_REQUESTS` | 200 | 0–10,000 |
| `ATLAS_PERFORMANCE_CONCURRENCY` | 25 | 1–500 |
| `ATLAS_PERFORMANCE_REQUEST_TIMEOUT_MS` | 2,000 | 100–30,000 |
| `ATLAS_PERFORMANCE_MAX_P95_MS` | 100 | 1–10,000 |
| `ATLAS_PERFORMANCE_MAX_P99_MS` | 250 | 1–30,000 |
| `ATLAS_PERFORMANCE_MIN_RPS` | 100 | 1–100,000 |

The JSON result records Node.js version, operating system, architecture, CPU model, logical CPU
count, total memory, workload, objectives, and observations. It never records environment contents,
headers, credentials, response bodies, or resource identifiers.

Changing an objective for a run is visible in the result. Lowering a committed objective requires
reviewed evidence and documentation rather than silently editing a test until it passes.

## 5. Remote-target safety

`ATLAS_PERFORMANCE_BASE_URL` may point the same scenario at an existing HTTP or HTTPS API. The
harness discards any supplied path and always targets `GET /api/v1/status`. URLs containing
credentials are rejected.

Loopback targets require no additional permission. A non-loopback hostname is rejected unless the
operator also sets:

~~~text
ATLAS_PERFORMANCE_ALLOW_REMOTE=true
~~~

This flag is an explicit safety acknowledgement, not deployment authorization. The operator must
still own the target, confirm the test window, understand ingress and monitoring impact, and avoid
running unapproved load against shared or production systems.

## 6. Command and CI policy

`pnpm test:performance` is not part of `pnpm verify`, pre-commit, or the default unit suite. Its
timing objectives run:

- manually while changing HTTP-edge or performance-sensitive code;
- during Phase 7 and release-candidate verification;
- on a stable dedicated CI runner when Atlas provisions one; and
- on the selected production compute class before first deployment.

The harness's deterministic statistics, request-count, concurrency, failure-classification, and
validation behavior remain covered by ordinary Vitest tests without asserting machine speed.

A future stable performance runner may publish the JSON artifact and compare it with an approved
baseline, but shared-runner timings must not become a blocking gate without variance evidence.

## 7. Required future scenarios

Before Atlas can claim production capacity, focused scenarios must cover at least:

- authenticated session resolution;
- public market catalogue and Market Data snapshots with representative PostgreSQL state;
- portfolio composition;
- concurrent order placement on one market to measure lock contention;
- non-crossing and crossing order mixes;
- atomic four-wallet settlement;
- notification capture overhead;
- Market Data projection catch-up and steady state;
- WebSocket connection, subscription, fan-out, reconnect, and backpressure behavior;
- admission-limit degradation and recovery;
- database pool saturation; and
- sustained soak behavior with memory and event-loop observation.

Correctness invariants, persisted final state, and error taxonomy remain mandatory under load. Raw
throughput is not a success if financial, ordering, privacy, or idempotency behavior changes.

## 8. Scope

This decision does not establish a production SLO, capacity plan, autoscaling rule, maximum user
count, maximum orders per second, database sizing, WebSocket capacity, or market-data freshness
objective. It does not add k6, Gatling, Artillery, JMeter, a hosted load generator, or distributed
workers.

## Alternatives Considered

### Put latency assertions in Vitest

Rejected because correctness tests run on heterogeneous machines and should not fail due to
uncontrolled scheduler or host load. Only deterministic harness behavior belongs in the unit suite.

### Adopt a distributed load-testing tool immediately

Rejected because the first scenario needs one process and one endpoint. A larger tool becomes
justified when Atlas needs scenario scripting, multiple load generators, coordinated data setup,
protocol mixing, or sustained distributed load.

### Benchmark Express without TCP

Rejected because direct handler invocation omits connection reuse, Node's HTTP parser and server,
response streaming, and meaningful request concurrency.

### Start with trading throughput claims

Rejected because a credible Trading benchmark requires representative PostgreSQL data, authenticated
owners, deterministic funding, correctness reconciliation, and controlled contention scenarios.
Quoting a number before that design would be misleading.

### Permit arbitrary remote paths

Rejected because a configuration mistake could load or repeatedly mutate a sensitive endpoint. The
initial remote mode is fixed to the read-only API status route.

## Consequences

### Positive Consequences

- Atlas has one repeatable command and machine-readable performance result.
- The baseline exercises the real HTTP process boundary over sockets.
- Conservative objectives catch substantial edge regressions without becoming product SLOs.
- Bounded workload and remote-target safeguards reduce accidental operational impact.
- Timing checks remain separate from deterministic correctness gates.
- The documented exclusions prevent loopback throughput from becoming a false capacity claim.

### Negative Consequences

- The initial scenario does not measure PostgreSQL or business behavior.
- Loopback results omit network, ingress, TLS termination, and external log transport costs.
- A discarded logging destination measures serialization but not collector backpressure.
- Results vary with machine power, thermal state, scheduler load, and Node.js version.
- The dependency-free harness will need replacement or extension for distributed and multi-protocol
  scenarios.

## Reconsider When

Review this decision when Atlas selects production compute and ingress, defines SLOs, provisions a
stable performance runner, needs database-backed scenarios, requires sustained or distributed load,
adds multiple API replicas, or needs combined HTTP and WebSocket test orchestration.

## Related Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-005 — Sprint 1 Testing Toolchain](ADR-005-sprint-1-testing-toolchain.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [ADR-033 — Market Data Projection Worker Lifecycle and Lag Observability](ADR-033-market-data-projection-worker-lifecycle-and-lag-observability.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
- [ADR-057 — API Admission Rate Limiting and Abuse Protection](ADR-057-api-admission-rate-limiting-and-abuse-protection.md)
- [ADR-058 — Application Metrics and Protected Scrape Boundary](ADR-058-application-metrics-and-protected-scrape-boundary.md)
