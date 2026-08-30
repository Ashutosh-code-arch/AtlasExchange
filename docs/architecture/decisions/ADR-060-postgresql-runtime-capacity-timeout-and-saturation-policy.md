# ADR-060 — PostgreSQL Runtime Capacity, Timeout, and Saturation Policy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-060

## Context

Atlas already owns PostgreSQL lifecycle in the API and uses a separate one-connection migration
pool. The runtime pool previously embedded only a connection count, acquisition timeout, and idle
timeout in code. Query execution, lock waits, abandoned transactions, connection lifetime, and
readiness execution were not bounded explicitly. Pool demand was also invisible outside the
process.

A connection limit is a per-process capacity decision, not a complete database capacity plan. Each
API replica creates its own pool, while PostgreSQL must also retain capacity for migrations,
administration, recovery, and monitoring. Atlas needs validated safe defaults and saturation
evidence before choosing a production replica count or database service tier.

## Decision Drivers

The runtime database boundary should:

1. bound connection acquisition, statement execution, lock waits, idle transactions, and connection
   lifetime;
2. keep the maximum connection budget explicit and validated at startup;
3. make readiness fast, read-only, schema-aware, and independent of normal statement duration;
4. expose current pressure without query text, identities, or unbounded metric labels;
5. preserve application-owned transactions and repository ownership from ADR-010;
6. leave migrations able to run deliberate long operations through their isolated pool; and
7. require deployment capacity planning across every API replica rather than treating one pool size
   as a global limit.

# Decision

Atlas will use one bounded `pg` pool per API process and a separate migration pool.

## 1. Runtime defaults and validation

| Configuration | Default | Accepted range | Purpose |
|---|---:|---:|---|
| `DATABASE_POOL_MAX_CONNECTIONS` | 10 | 1–100 | Maximum connections owned by one API process |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | 2,000 | 100–30,000 | Maximum pool acquisition/connect wait |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | 30,000 | 1,000–300,000 | Idle connection retirement |
| `DATABASE_POOL_MAX_LIFETIME_SECONDS` | 300 | 30–86,400 | Maximum connection lifetime |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 15,000 | 100–120,000 | PostgreSQL statement execution limit |
| `DATABASE_LOCK_TIMEOUT_MS` | 5,000 | 100–60,000 | PostgreSQL lock acquisition limit |
| `DATABASE_IDLE_TRANSACTION_TIMEOUT_MS` | 30,000 | 1,000–300,000 | Abandoned transaction limit |
| `DATABASE_READINESS_TIMEOUT_MS` | 1,000 | 100–10,000 | Readiness query statement limit |

The lock timeout must be strictly shorter than the statement timeout. The readiness timeout must not
exceed the normal statement timeout. Invalid values or relationships fail startup without printing
the database URL.

Every runtime connection identifies itself to PostgreSQL as `atlas-api` and enables TCP keepalive.
The defaults are initial safeguards, not measured production capacity.

## 2. Capacity ownership

Deployment must calculate the aggregate budget before increasing replicas or pool size:

~~~text
API runtime demand = replica count × pool maximum

database connection budget must also retain headroom for:
  migration + administration + monitoring + maintenance/recovery
~~~

Autoscaling may not increase replicas beyond the reviewed database connection budget. A future pool
proxy does not remove the need to budget PostgreSQL server work and transaction concurrency.

## 3. Readiness semantics

Database readiness acquires a pooled connection within the configured acquisition timeout, begins a
read-only transaction, installs the shorter readiness statement timeout locally to that transaction,
and reads the committed schema-version metadata. One query proves both connectivity and schema
compatibility; a redundant `SELECT 1` is not performed.

Any acquisition, transaction, timeout, query, or version failure returns not-ready. Kysely manages
rollback and release through the same pool lifecycle used by application queries. Readiness errors
are not exposed in the public response.

## 4. Saturation metrics

When the protected metrics boundary from ADR-058 is enabled, Atlas exports:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `atlas_database_pool_connections` | Gauge | `state` = `active`, `idle`, `total` | Current pool connections |
| `atlas_database_pool_max_connections` | Gauge | None | Configured per-process maximum |
| `atlas_database_pool_waiting_requests` | Gauge | None | Callers waiting for a connection |
| `atlas_database_pool_events_total` | Counter | `event` = `connect`, `remove`, `error` | Pool lifecycle events |

Counts are read from the live pool when a scrape is rendered. Metrics contain no query text,
database URL, table name, request identity, module name, or error message. A nonzero waiting count is
saturation evidence; alert thresholds require production workload and scrape-retention evidence.

## 5. Migration isolation

Committed migrations continue to run explicitly through their dedicated maximum-one-connection pool.
They do not inherit runtime statement, lock, idle-transaction, or lifetime limits because a reviewed
schema/data migration may intentionally exceed request-serving limits. Production deployment must
still impose an external migration deadline and observe PostgreSQL impact.

## 6. Scope

This decision does not select a managed PostgreSQL tier, connection proxy, replica count, autoscaling
policy, query retry policy, slow-query log threshold, statement timeout per use case, or alert rule.
It does not claim that ten connections are sufficient for production. Those decisions require the
database-backed load and contention evidence required by ADR-059.

## Alternatives Considered

### Keep driver defaults

Rejected because unbounded or implicit execution behavior makes overload recovery and deployment
capacity difficult to reason about.

### Give every module its own pool

Rejected because modules share one API deployment and database. Separate pools multiply connection
budgets and hide aggregate pressure without creating a real deployment boundary.

### Apply runtime timeouts to migrations

Rejected because request-serving limits and deliberate schema evolution have different operational
needs. Migrations are isolated and run as an explicit deployment step.

### Retry timed-out statements automatically

Rejected because retry safety depends on the use case, transaction state, idempotency contract, and
failure classification. The database platform must not silently replay financial or trading work.

## Consequences

### Positive Consequences

- Database resource assumptions are visible, validated, and deployment-configurable.
- Lock waits, abandoned transactions, statements, acquisition, and connection age are bounded.
- Readiness fails quickly and cannot leak its transaction-local shorter timeout into later pooled
  work.
- Pool queueing and utilization are observable through finite, privacy-safe metrics.
- Migration behavior remains explicit and isolated from request-serving policy.

### Negative Consequences

- A legitimate long-running request statement now fails after the configured deadline.
- Incorrect production sizing can still exhaust PostgreSQL when replica budgets are aggregated.
- Process-local counters reset on restart and need an external collector for historical analysis.
- One default timeout cannot represent every future analytical or maintenance query.

## Reconsider When

Review this decision when Atlas selects production PostgreSQL and replica topology, introduces a
connection proxy, observes sustained waiters or timeout failures, adds read replicas or background
worker deployments, needs use-case-specific query deadlines, or completes database-backed load and
contention testing.

## Related Decisions

- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-011 — PostgreSQL Runtime and Local Development Strategy](ADR-011-postgresql-runtime-and-local-development-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-058 — Application Metrics and Protected Scrape Boundary](ADR-058-application-metrics-and-protected-scrape-boundary.md)
- [ADR-059 — HTTP Performance Baseline and Load-Testing Policy](ADR-059-http-performance-baseline-and-load-testing-policy.md)
