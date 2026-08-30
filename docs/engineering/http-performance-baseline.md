# HTTP Performance Baseline

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-059

## Purpose

This document records Atlas's initial repeatable HTTP process-edge performance baseline. It is
development regression evidence, not production capacity evidence.

## Command

Run:

~~~bash
pnpm test:performance
~~~

The default command starts an ephemeral loopback API, performs 200 warm-up requests, then measures
2,000 `GET /api/v1/status` requests at concurrency 25. It includes security headers, correlation,
structured log serialization, metrics instrumentation, admission limiting, Express routing, and
Node HTTP server behavior.

## Development environment

~~~text
Machine class:     Apple M4 development laptop
Memory:            16 GiB
Architecture:      arm64
Logical CPU count: 10
Operating system:  macOS (darwin)
Node.js:           24.7.0
Transport:         loopback HTTP with keep-alive
~~~

Atlas pins Node.js 24.19.0. This measurement was captured with the currently installed 24.7.0
runtime and must be rerun on the pinned runtime before it is used as release evidence.

## Recorded result

Results recorded on 2026-08-30:

| Requests | Failures | Concurrency | Throughput | Median | p95 | p99 | Maximum |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2,000 | 0 | 25 | 14,699.24 req/s | 1.60 ms | 2.32 ms | 2.57 ms | 2.65 ms |

Configured development objectives:

| Objective | Limit | Result |
|---|---:|---|
| Failed requests | 0 | Pass |
| p95 latency | ≤ 100 ms | Pass |
| p99 latency | ≤ 250 ms | Pass |
| Throughput | ≥ 100 req/s | Pass |

## Interpretation

This result indicates that the current HTTP process boundary has substantial headroom against the
conservative development regression objectives on this machine. It does not establish a 14,699
request/second production claim.

The scenario excludes:

- PostgreSQL queries and transactions;
- authentication and password hashing;
- financial journals and wallet locking;
- order matching and settlement;
- projection work;
- WebSocket delivery;
- reverse-proxy and TLS termination;
- real network latency;
- external log transport and backpressure; and
- sustained soak behavior.

These exclusions are material. Database-backed and stateful scenarios must record both performance
and invariant-preserving final state before Atlas states production capacity.

## Reproduction and overrides

The default command needs no infrastructure. A controlled loopback API can be targeted with:

~~~bash
ATLAS_PERFORMANCE_BASE_URL=http://127.0.0.1:3000 pnpm test:performance
~~~

Remote targets additionally require `ATLAS_PERFORMANCE_ALLOW_REMOTE=true`. Do not run remote load
without ownership, an approved test window, and operational monitoring.

Workload and objective overrides are defined by
[ADR-059](../architecture/decisions/ADR-059-http-performance-baseline-and-load-testing-policy.md).
Every JSON result records the effective configuration, so an override cannot silently appear to be
the canonical baseline.

## Production gate

Before first production deployment:

1. install the pinned Node.js runtime;
2. select and record the production compute class;
3. run behind the chosen ingress and TLS topology;
4. use representative PostgreSQL size and connection-pool configuration;
5. implement the stateful scenarios required by ADR-059;
6. reconcile financial, ordering, idempotency, and privacy invariants after load;
7. observe CPU, memory, event-loop, pool, projection-lag, and error signals;
8. establish sustained and burst workloads from explicit product assumptions; and
9. set reviewed SLOs and capacity thresholds from those results.
