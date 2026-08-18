# ADR-015 — API Health, Readiness, and Process Lifecycle Strategy

**Classification:** Canonical  
**Status:** Proposed  
**Date:** 2026-08-18  
**Last reviewed:** 2026-08-18  
**Canonical owner/source:** ADR-015

## 1. Context

Atlas needs precise lifecycle signals for an API that will eventually serve identity, trading, wallets, ledger, market data, and notifications.

A health endpoint must not imply more than it actually proves. In particular, “the process returned HTTP 200” and “the API can safely serve financial requests” are different statements.

Atlas therefore distinguishes three lifecycle signals:

```text
Startup
→ Has initialization completed?

Liveness
→ Is the API process running and capable of responding?

Readiness
→ Can this instance currently accept application traffic?
```

Deployment platforms react differently to these signals. Failed startup or liveness may cause a process restart, while failed readiness should normally remove an instance from traffic without necessarily restarting it.

Incorrect liveness checks can create cascading restarts during a shared database outage.

## 2. Decision

Atlas will expose separate health endpoints:

```text
GET /health/live
GET /health/ready
```

Liveness is a process-health signal and must not depend on PostgreSQL or other external dependencies.

Readiness is an application-traffic eligibility signal and must reflect whether required startup and runtime dependencies are available.

Startup, readiness, and shutdown state will be represented by explicit lifecycle state owned by the process/server composition boundary rather than scattered process-global checks.

The API will not accept business traffic before required initialization succeeds.

## 3. Liveness

`GET /health/live` is intentionally inexpensive.

It must:

- not query PostgreSQL;
- not perform external dependency checks;
- not mutate state;
- expose only minimal information;
- return `200` while the process remains capable of responding.

Successful response:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "status": "ok"
}
```

If PostgreSQL becomes unavailable while the API process can still respond, liveness should generally remain successful.

The purpose is to avoid restarting every API instance in response to a shared dependency outage that the process itself cannot repair.

## 4. Readiness

`GET /health/ready` represents whether the instance can currently accept application traffic.

Ready:

```http
HTTP/1.1 200 OK
```

```json
{
  "status": "ready"
}
```

Not ready:

```http
HTTP/1.1 503 Service Unavailable
```

```json
{
  "status": "not_ready"
}
```

### Required readiness conditions

Atlas initially requires all of the following:

- startup completed;
- configuration validated;
- database pool initialized;
- PostgreSQL connectivity available;
- expected migration/schema version verified;
- shutdown has not started.

Readiness must be recalculable during runtime because PostgreSQL may become unavailable and later recover.

A database readiness check should:

- use a short timeout;
- perform a minimal operation;
- avoid locks and business queries;
- return only readiness status to the caller;
- avoid logging every successful poll.

Schema compatibility may be verified during startup and retained as lifecycle state rather than querying migration history on every readiness probe.

## 5. Health Response Security

Health endpoints should require no user authentication when used by infrastructure.

Responses must expose only minimal lifecycle status.

They must not expose:

- database hosts;
- database credentials;
- SQL errors;
- stack traces;
- internal topology;
- detailed dependency versions;
- configuration contents.

All health responses use:

```http
Cache-Control: no-store
```

Detailed diagnostic information belongs in structured operational logs.

Health endpoints must not mutate application state.

## 6. Startup Lifecycle

Atlas will initialize the API in this order:

```text
process starts
      ↓
create bootstrap logger
      ↓
load and validate configuration
      ↓
initialize database pool
      ↓
verify database connectivity
      ↓
verify expected schema version
      ↓
construct application
      ↓
create HTTP server
      ↓
begin listening
      ↓
mark ready
```

The API must not accept business traffic before required initialization succeeds.

### Startup database failures

Temporary database unavailability may receive bounded retry:

```text
connect
  ↓ fails
backoff
  ↓ retry
startup deadline reached
  ↓
log fatal and exit non-zero
```

Invalid configuration and incompatible schema must not be retried indefinitely. They require intervention.

Exact retry duration and backoff values remain deferred.

### Startup cleanup

If initialization creates resources and a later startup step fails, already-created resources must be cleaned up where safely possible before process exit.

## 7. Migration Coordination

Atlas does not automatically apply database migrations during API startup.

The lifecycle is:

```text
migration deployment
        ↓
API startup
        ↓
schema compatibility verification
        ↓
API readiness
```

This preserves the migration strategy established by ADR-010 and ADR-011.

Startup verifies compatibility; migration execution remains a separate operational step.

## 8. Graceful Shutdown

Atlas handles at least:

```text
SIGTERM → deployment termination
SIGINT  → local interruption
```

Shutdown begins by making the instance unready.

The recommended sequence is:

```text
shutdown signal
       ↓
mark readiness false
       ↓
stop accepting new connections
       ↓
allow in-flight requests to finish
       ↓
close database pool and other resources
       ↓
flush required logs
       ↓
exit
```

Node's HTTP server shutdown behavior supports stopping new connections and waiting for active work to finish, but a deadline remains necessary because active requests may never complete.

### Shutdown deadline

```text
graceful deadline expires
        ↓
log forced-shutdown event
        ↓
close remaining HTTP connections
        ↓
exit non-zero
```

`server.closeAllConnections()` may be used only after the graceful shutdown attempt reaches its deadline.

Upgraded protocols such as WebSockets require separate lifecycle handling and are deferred.

A second termination signal may request immediate forced shutdown.

## 9. Unexpected Process Failures

Unhandled rejections and uncaught exceptions are treated as fatal process conditions.

Atlas will:

- log one fatal structured event;
- stop accepting new work;
- attempt only bounded best-effort cleanup;
- terminate with a non-zero status;
- rely on the process supervisor to restart the API.

The process must not continue operating as though an uncaught exception had no effect.

## 10. app.ts and server.ts

This ADR reinforces the separation established by ADR-008:

```text
app.ts
→ constructs Express routes and middleware
→ does not listen
→ testable through Supertest

server.ts
→ configuration
→ resources
→ HTTP listener
→ signals
→ startup/shutdown lifecycle
```

Health handlers receive lifecycle state through explicit dependencies.

They must not inspect scattered process globals or independently reconstruct startup state.

## 11. Logging and Probe Volume

Health endpoints should not generate ordinary request-log volume for every successful probe.

Successful probes may be suppressed or sampled later if infrastructure generates excessive traffic.

Failures and meaningful readiness/lifecycle state transitions remain observable.

This preserves useful operational signal without allowing infrastructure polling to dominate application logs.

## 12. Testing Strategy

### Liveness

Tests must verify:

- `200` response;
- no PostgreSQL dependency;
- no sensitive information exposed.

### Readiness

Tests must verify:

- `503` before initialization;
- `200` when required resources are available;
- `503` when database readiness fails;
- `503` after shutdown begins;
- recovery to `200` when a temporary dependency recovers.

### Lifecycle

Where practical, automated tests must verify:

- the API does not listen after failed initialization;
- shutdown stops new traffic;
- resources close after in-flight work completes;
- the shutdown deadline forces termination behavior;
- repeated signals do not execute cleanup concurrently.

## 13. Consequences

### Positive

- Health semantics are explicit and operationally useful.
- Database outages do not automatically trigger cascading process restarts through liveness probes.
- Readiness can remove unhealthy instances from traffic without implying process failure.
- Startup ordering prevents business traffic before required initialization.
- Migrations remain independently controlled.
- Graceful shutdown protects in-flight requests while still providing a bounded termination path.
- `app.ts` remains independently testable.
- Lifecycle state can be tested without relying on deployment infrastructure.

### Negative

- The API now has explicit lifecycle state and shutdown coordination.
- Readiness checks require careful dependency handling.
- Startup retry and shutdown deadline behavior require additional implementation and tests.
- WebSocket lifecycle will require a later decision.
- Health endpoints introduce another operational contract that must remain stable.

## 14. Deferred Decisions

The following are intentionally deferred:

- deployment-platform-specific probe configuration;
- exact startup retry and backoff values;
- exact readiness timeout and caching strategy;
- termination grace period;
- load-balancer propagation delay;
- WebSocket shutdown;
- Redis readiness;
- metrics and tracing;
- production HTTP timeout values.

## 15. Related Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-011 — PostgreSQL Runtime and Local Development Strategy](ADR-011-postgresql-runtime-and-local-development-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)

## 16. Status

**Proposed**

This ADR remains Proposed until the referenced ADR chain exists in the repository and all related links resolve. The architectural decisions above are the intended baseline for implementation; deployment-specific probe configuration and other deferred lifecycle details will be decided separately.
