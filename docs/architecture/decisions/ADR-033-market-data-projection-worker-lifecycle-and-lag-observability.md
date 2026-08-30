# ADR-033 — Market Data Projection Worker Lifecycle and Lag Observability

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-28  
**Last reviewed:** 2026-08-30
**Canonical owner/source:** ADR-033

## Context

ADR-030 requires the initial Market Data projector to run as a lifecycle-managed worker in the API
deployment. ADR-031 provides the retained Trading fact stream and publication sequence, while
ADR-032 implements the atomic, restartable level-two projector and durable checkpoint. Until an
operational loop invokes that projector, however, committed facts remain unconsumed and no process
continuously maintains the book.

Atlas needs a polling, failure, observability, startup, and shutdown contract before the worker is
enabled in the API process. That contract must keep projection failure from becoming command
failure while still making lag and persistent errors visible.

## Decision Drivers

The worker should:

1. use only public Trading and Market Data application interfaces;
2. discover the initial market catalog rather than hard-code market codes;
3. prevent one failing market from stopping projection for other markets;
4. bound database work performed by one market before yielding;
5. retry transient failures without a tight error loop;
6. expose exact sequence lag without logging fact payloads or private order state;
7. start only after PostgreSQL schema readiness is established;
8. stop intake and allow an in-flight projection transaction to finish before database closure;
9. preserve command API readiness while projections are behind or retrying;
10. remain deterministic under unit and real-PostgreSQL tests.

# Decision

Atlas will run one `MarketDataProjectionWorker` inside the API deployment when projection is enabled.
The worker discovers Trading markets at startup and owns one independent asynchronous loop per
market.

~~~text
API startup
├── verify PostgreSQL + schema
├── discover Trading markets
├── start Market Data loops
└── start HTTP listening

Per-market loop
├── project at most N bounded batches
├── read Trading publication high-water mark
├── calculate exact sequence lag
├── publish structured diagnostics
└── poll again or retry with backoff

API shutdown
├── stop HTTP intake
├── abort worker sleeps
├── await in-flight projection transactions
└── close PostgreSQL
~~~

## 1. Process placement and market discovery

The initial worker runs in the existing API process and PostgreSQL deployment. A separate process,
queue, scheduler, or stream platform is not introduced.

At worker startup, Trading's public `TradingMarketReader` supplies the catalog in deterministic code
order. Each discovered market receives an independent loop and diagnostic state. An empty catalog or
failure to discover markets makes configured worker startup fail, because the process cannot start
the capability it claims to operate.

Markets added after startup require an API restart in the initial implementation. Dynamic catalog
refresh may be introduced when market administration exists.

## 2. Bounded polling and catch-up

Every market projects immediately at startup, then waits for the configured polling interval between
cycles. A cycle invokes the level-two projector for at most a configured number of batches. Each
batch respects Trading's maximum fact page boundary of 1,000.

If the projector remains behind after the cycle budget is exhausted, the worker records the exact
remaining lag and yields before continuing. This prevents one busy market from creating an
unbounded application task or monopolizing the connection pool. Markets run independently, so a
busy or failed BTC-USD loop does not delay ETH-USD.

The accepted defaults are:

| Setting | Default | Valid boundary |
| --- | ---: | ---: |
| Poll interval | 250 ms | 25–60,000 ms |
| Fact batch size | 250 | 1–1,000 |
| Maximum batches per cycle | 8 | 1–100 |
| Initial retry delay | 500 ms | 25–60,000 ms |
| Maximum retry delay | 30,000 ms | 25–300,000 ms and not below the initial delay |

The worker is enabled by default and has an explicit environment kill switch. Disabling it prevents
new projection progress but does not delete checkpoints or derived state.

## 3. Exact lag and diagnostic state

Trading exposes the last committed per-market publication sequence through a public
`TradingPublicationSequenceReader`. After each projection cycle, the worker compares that high-water
mark with the durable Market Data checkpoint returned by the projector.

~~~text
lag = last committed Trading publication sequence
    - last durable Market Data projection sequence
~~~

The high-water mark must never be below the checkpoint. A zero difference is `caught_up`; a positive
difference is `behind`. The observation is a point-in-time measurement—a Trading transaction may
commit immediately afterward.

The worker keeps a non-authoritative in-memory diagnostic snapshot for every market containing:

- worker state: `starting`, `caught_up`, `behind`, `failed`, or `stopped`;
- projected and published sequences plus exact lag;
- consecutive failure count;
- last success and failure times;
- last error class name.

Structured logs emit worker start/stop, failure, recovery, and change-driven cycle-completion
events. Unchanged idle polls remain silent. Sequences and lag are logged as canonical integer
strings. Fact payloads, order identifiers, owners, account data, and credentials are not logged. A
later metrics or administrative adapter may read the diagnostic snapshot; this ADR does not
authorize a public endpoint.

## 4. Failure isolation and retry

A projection exception changes only that market to `failed`. The loop records a structured error and
retries using bounded exponential backoff:

~~~text
delay = min(maximum delay, initial delay × 2^(consecutive failures - 1))
~~~

A successful cycle resets the failure count and emits a recovery event. Permanent problems such as
a sequence gap continue retrying at the maximum delay and remain visible; the worker never skips the
fact, edits Trading history, or advances the checkpoint speculatively.

Runtime projection failure does not stop HTTP, roll back committed Trading commands, or make the
command API unready. It affects the freshness and later availability policy of Market Data only.
Readiness continues to represent process lifecycle and PostgreSQL/schema compatibility until a
separate public Market Data freshness contract says otherwise.

## 5. Lifecycle ordering

The generic API lifecycle now manages background workers explicitly.

Startup order is:

1. validate configuration and construct resources;
2. verify PostgreSQL connectivity and schema compatibility;
3. start configured workers;
4. begin HTTP listening;
5. mark startup complete.

If worker or HTTP startup fails, started workers are stopped before PostgreSQL closes.

Shutdown first stops accepting HTTP requests so no new Trading command can publish work through this
process. It then aborts worker sleeps and waits for any current projector call to commit or roll back.
Only afterward does it close PostgreSQL. Worker stop is covered by the same bounded lifecycle
deadline and contributes to forced-shutdown diagnostics if it does not settle.

## 6. Configuration boundary

Worker configuration is parsed once with the rest of the API environment:

- `MARKET_DATA_PROJECTION_ENABLED`;
- `MARKET_DATA_PROJECTION_POLL_INTERVAL_MS`;
- `MARKET_DATA_PROJECTION_BATCH_SIZE`;
- `MARKET_DATA_PROJECTION_MAX_BATCHES_PER_CYCLE`;
- `MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS`;
- `MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS`.

Invalid numeric boundaries or a maximum retry delay below the initial delay prevent startup. Worker
configuration contains no secret.

## 7. Deterministic evidence

Unit tests inject a scheduler and controlled projector outcomes to prove immediate startup,
independent market state, bounded batches, exact lag, exponential retry, recovery, and in-flight
shutdown behavior without wall-clock sleeps. Lifecycle tests prove worker ordering and cleanup on
startup failure. Real-PostgreSQL integration proves that the running loop consumes committed facts,
updates the durable book and checkpoint, observes later publication, and stops cleanly.

# Alternatives Considered

## Project only when a public request arrives

Rejected because request latency and correctness would depend on replay work, and no consumer would
maintain state when clients were absent.

## One loop for all markets

Rejected because a slow or failing market would delay every other market and complicate independent
retry state.

## Retry immediately forever

Rejected because a persistent database, schema, or sequence error would create a hot log and query
loop.

## Make projection lag fail API readiness

Rejected for the current private projection stage because command-side Trading remains authoritative
and available. Public Market Data freshness behavior requires its own contract.

## Add a queue or streaming platform now

Rejected because retained PostgreSQL facts, per-market sequences, and transactional checkpoints meet
the current scale and deployment requirements.

# Consequences

## Positive Consequences

- Committed Trading facts are projected continuously without manual commands.
- Market failures and retry schedules are isolated.
- Exact lag and recovery are visible through structured diagnostics.
- Catch-up work is bounded and configurable.
- Shutdown preserves projection transaction atomicity and database ordering.
- The worker can later move to another process without changing fact or checkpoint contracts.

## Negative Consequences

- Every API replica starts loops and contends for the existing per-market advisory lock, although
  only one applies a sequence.
- Polling creates queries while markets are idle.
- Diagnostics and their aggregate metrics remain process-local until an external collector exists.
- Newly provisioned markets require a restart to be discovered.
- Permanent projection failures require operator attention and continue bounded retries.

# Deferred Decisions

This ADR does not decide:

1. public or administrative worker-status endpoints;
2. metrics backend, alert thresholds, or service-level objectives;
3. maximum public snapshot age and stale-state HTTP behavior;
4. dynamic market discovery without restart;
5. separate worker deployment or replica leadership optimization;
6. rebuild commands and generation activation;
7. ticker, candle, REST, or WebSocket delivery.

# Reconsider When

Review this decision when polling load is material, worker loops move to a separate deployment,
multiple API replicas create measurable duplicate reads, dynamic market provisioning exists, or a
public freshness objective requires readiness or traffic-management integration.

# Relationship to Other Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-030 — Market Data Projection and Sequencing Foundation](ADR-030-market-data-projection-and-sequencing-foundation.md)
- [ADR-031 — Trading Market Data Fact Persistence and Publication Contract](ADR-031-trading-market-data-fact-persistence-and-publication-contract.md)
- [ADR-032 — Market Data Checkpoint and Level-Two Projection Persistence](ADR-032-market-data-checkpoint-and-level-two-projection-persistence.md)
- [ADR-061 — Runtime and Market Data Projection Observability](ADR-061-runtime-and-market-data-projection-observability.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

The managed Market Data projection worker, public Trading high-watermark reader, validated polling
configuration, structured lag diagnostics, bounded retry, and lifecycle integration may be
implemented. Public snapshot and streaming delivery remain separately gated.
