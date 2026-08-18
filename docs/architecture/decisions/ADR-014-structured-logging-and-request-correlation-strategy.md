# ADR-014 — Structured Logging and Request Correlation Strategy

**Classification:** Canonical  
**Status:** Proposed  
**Date:** 2026-08-18  
**Last reviewed:** 2026-08-18  
**Canonical owner/source:** ADR-014

## 1. Context

Atlas requires operational visibility across HTTP requests, application behavior, database interactions, startup, shutdown, and failures.

Logging must provide useful operational context without becoming a substitute for durable business records.

Atlas distinguishes three different records:

| Record | Purpose | Authority |
|---|---|---|
| Operational log | Explains application behavior, failures, and operational state | Operational evidence only |
| Audit record | Records security/business actions requiring durable accountability | Durable accountability record |
| Financial ledger | Records authoritative movement of value | Financial source of truth |

These records are not interchangeable.

For example, an operational log stating that a balance was updated does not constitute proof that the balance changed. The financial ledger remains authoritative.

Logs may also be sampled, rotated, unavailable, or redacted.

The architecture therefore needs explicit decisions for:

- structured log output;
- stable operational event names;
- request correlation;
- logging boundaries;
- error ownership;
- severity levels;
- sensitive-data protection;
- local versus production output;
- testing of logging behavior.

## 2. Decision

Atlas will use **Pino with `pino-http`** for application and HTTP operational logging.

Production logs will be emitted as **structured JSON to stdout** and collected by the deployment/runtime environment.

Atlas will establish a stable operational event schema and request-correlation policy while keeping logging independent from domain behavior.

Request-scoped logging will initially use the request logger supplied by the HTTP boundary. A narrow logging abstraction may be passed explicitly into application orchestration where operational logging provides meaningful value.

Atlas will **not initially introduce `AsyncLocalStorage` solely for logging correlation**.

Domain code remains independent of logging frameworks.

## 3. Logging responsibilities

### 3.1 Operational logs

Operational logs explain:

- application lifecycle;
- HTTP outcomes;
- unexpected failures;
- infrastructure failures;
- degraded behavior;
- important operational events.

They are intended for diagnosis, monitoring, and operational investigation.

Operational logs are **not** authoritative business records.

### 3.2 Audit records

Audit records represent security or business actions requiring durable accountability.

They are conceptually separate from operational logs and may require different:

- retention;
- storage;
- access control;
- integrity guarantees;
- querying mechanisms.

Audit-record implementation is not selected by this ADR.

### 3.3 Financial ledger

The financial ledger remains the authoritative record for value movement.

Logs must never be treated as a financial source of truth.

## 4. Logging technology

Atlas will use:

```text
Pino
+
pino-http
```

Pino provides:

- structured JSON logging;
- child loggers;
- serializers;
- configurable redaction.

`pino-http` provides Express integration, request completion logging, request identifiers, response timing, and request-scoped child loggers.

References:

- [Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)
- [pino-http](https://github.com/pino-http/pino-http)

OpenTelemetry remains compatible with this architecture but is **deferred**.

Logs, metrics, and traces are separate observability signals. Introducing OpenTelemetry immediately would establish a broader observability system that Atlas does not yet require.

Reference:

- [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/)

## 5. Output strategy

Production logging follows:

```text
Application
    ↓
Pino
    ↓
structured JSON
    ↓
stdout
    ↓
deployment/runtime log collector
```

Atlas will not initially:

- write application log files;
- implement log-file rotation;
- send logs directly to a logging vendor;
- pretty-print production output;
- introduce multiple Pino transports.

Local development may use a development-only pretty printer to improve readability.

The production log format remains machine-readable JSON.

## 6. Operational event schema

Operational events should use stable machine-readable fields where applicable.

The baseline schema is:

```text
timestamp
level
service
environment
applicationVersion
event
message
module
requestId
method
route
statusCode
durationMs
error
```

Not every event requires every field.

Examples:

```text
http.request.completed
database.connection.failed
api.startup.completed
order.submission.rejected
```

The `event` field is the stable operational identifier.

Human-readable `message` values may evolve without changing the event identity.

Dynamic field names should be avoided.

### 6.1 Event naming

Event names should describe meaningful operational events rather than arbitrary implementation details.

Examples:

```text
api.starting
configuration.validated
database.connected
api.listening

http.request.completed

database.connection.failed

order.submission.rejected
```

Event names should remain sufficiently stable to support searching, dashboards, and alerting.

## 7. Request correlation

Every HTTP request will receive a request identifier.

The initial flow is:

```text
incoming request
       ↓
validate incoming identifier
       │
       ├── valid → use it
       └── invalid/missing → generate UUID
       ↓
X-Request-Id response header
       ↓
request-scoped logger
       ↓
related operational events
```

Atlas will use UUID-generated identifiers when a valid trusted identifier is not available.

### 7.1 Incoming request identifiers

An externally supplied request identifier must not automatically be trusted.

Atlas must validate:

- maximum length;
- permitted characters;
- safe log representation.

This prevents an arbitrary header from introducing unbounded or control-character data into operational logs.

A future trusted reverse proxy or distributed trace context may provide a more authoritative correlation identifier.

The exact future trace-propagation mechanism is deferred.

## 8. Context propagation

Two primary approaches were considered.

### Explicit logger passing

Application services receive a logging abstraction or child logger.

Advantages:

- dependencies remain visible;
- no implicit global request state;
- behavior remains easier to reason about.

Trade-off:

- logging context may need to be passed through call chains.

### `AsyncLocalStorage`

Node's asynchronous-context facilities can propagate request context through asynchronous execution.

Advantages:

- less explicit parameter passing;
- deeper asynchronous infrastructure can access request context.

Trade-offs:

- introduces implicit contextual state;
- makes dependencies less visible;
- can obscure where context originates.

### Decision

Atlas will initially use the **request-scoped logger exposed at the HTTP boundary** and pass a narrow logging abstraction explicitly where application orchestration genuinely needs logging.

Atlas will not introduce `AsyncLocalStorage` merely to avoid a small amount of explicit parameter passing.

`AsyncLocalStorage` may be reconsidered if reliable correlation becomes necessary across deeper asynchronous infrastructure.

Reference:

- [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html)

## 9. Logging dependency boundary

The concrete Pino implementation must not become a domain dependency.

Conceptually:

```text
Pino implementation
        ↓ implements
Logger interface
        ↓
HTTP / application / infrastructure

Domain behavior
        ✕
logging framework
```

Where useful, application and infrastructure code may depend on a narrow logging abstraction.

Domain behavior should instead:

- return results;
- return domain outcomes;
- raise domain errors.

The application or infrastructure boundary decides whether an operational event should be recorded.

This prevents logging from becoming part of domain behavior and helps keep domain logic deterministic.

## 10. Logging ownership and duplicate prevention

Atlas will follow a **log once at the owning boundary** policy.

A single failure should not automatically generate near-identical records at every layer:

```text
repository logs error
application logs error
controller logs error
error middleware logs error
```

Instead:

- lower layers may add useful error context to propagated errors;
- lower layers should not repeatedly log the same failure;
- the boundary converting the failure into an operational outcome logs it;
- centralized HTTP error handling logs HTTP failures;
- process lifecycle handling logs process-level failures.

## 11. Severity policy

Atlas will initially use:

| Level | Intended use |
|---|---|
| `fatal` | Process cannot continue safely |
| `error` | Unexpected operation failure or server error |
| `warn` | Degraded behavior or notable recoverable condition |
| `info` | Lifecycle and normal operational events |
| `debug` | Development and diagnostic detail |
| `trace` | Very detailed temporary diagnosis |

Severity should represent operational meaning rather than HTTP status alone.

Examples:

- Insufficient balance → expected business rejection → `info` or `warn` depending on operational meaning.
- Database unavailable → unexpected infrastructure failure → `error`.
- Invalid production configuration → process cannot safely start → `fatal`.

An HTTP `4xx` response is not automatically a warning. Ordinary validation failures and expected unauthorized requests may be normal request outcomes. Unexpected `5xx` failures should generally be recorded as errors.

## 12. HTTP request logging

Atlas will record one request-completion event containing, where applicable:

```text
requestId
method
route
statusCode
durationMs
```

The normal successful request path does not require separate “request received” and “request completed” events.

Health-check logging may be suppressed or sampled later if it creates excessive operational noise. Health-check failures must remain observable.

Request and response bodies are not logged by default.

## 13. Sensitive-data policy

Atlas must treat logging as an allowlisted operational interface rather than an opportunity to serialize arbitrary application objects.

The following must never be logged in plaintext:

- `Authorization`;
- cookies;
- `Set-Cookie`;
- passwords;
- access tokens;
- refresh tokens;
- API keys;
- database URLs containing credentials;
- private keys;
- secret configuration;
- reset tokens;
- verification tokens.

Request and response bodies are omitted by default.

Raw URLs should not normally be logged because query parameters can contain sensitive information. Prefer sanitized route paths or route templates.

For user correlation, prefer an internal opaque user identifier rather than email addresses or other unnecessary personal information.

Pino redaction may provide an additional protection layer, but redaction does **not** make arbitrary object logging safe.

References:

- [Pino redaction](https://github.com/pinojs/pino/blob/main/docs/api.md)
- [pino-http body logging](https://github.com/pino-http/pino-http#pino-http)

## 14. Request-body logging

Atlas will **not log request bodies by default**.

If request-body logging becomes necessary for a specific diagnostic incident, it requires an explicit diagnostic decision that defines:

1. the exact endpoint;
2. the exact fields permitted;
3. the retention period;
4. redaction requirements;
5. access controls;
6. how logging will be enabled;
7. how it will be disabled afterward.

Diagnostic body logging must not become a permanent default.

## 15. Startup and shutdown events

Atlas will record important lifecycle transitions.

Initial examples:

```text
api.starting
configuration.validated
database.connected
api.listening

api.shutdown.started
api.shutdown.completed
```

Lifecycle events must not include configuration contents, credentials, or secret values.

Invalid configuration should identify the affected variable and validation failure without exposing the value itself.

Uncaught exceptions and unhandled rejections should be recorded as fatal.

The process should then perform bounded shutdown or terminate rather than assume it remains safe.

The exact graceful-shutdown procedure is deferred to a separate lifecycle decision.

## 16. Application version and environment

Operational events should include stable deployment context where available:

```text
service
environment
applicationVersion
```

These fields allow logs from multiple Atlas instances or deployments to be interpreted correctly.

The logging system must consume the already validated configuration rather than independently reading environment variables.

Logging must not become another source of direct `process.env` access.

## 17. Testing strategy

Logging behavior must be testable without producing noisy test output.

Tests should support:

- silent loggers;
- capturing loggers;
- injected logging abstractions.

Important operational logging behavior should be tested.

Examples include:

- required event fields;
- request ID propagation;
- request completion metadata;
- sensitive-field redaction;
- correct severity classification for important failures;
- lifecycle events where operationally significant.

Tests should **not** generally assert complete serialized log strings.

Assertions should focus on the logging contract:

```text
event
requestId
statusCode
durationMs
redacted fields
```

Expected test failures should not unnecessarily pollute test output.

## 18. Alternatives considered

### 18.1 `console`

`console` requires no additional dependency and is immediately available.

It does not provide Atlas with a sufficiently deliberate structure for:

- stable event schemas;
- request-scoped context;
- configurable redaction;
- child loggers;
- consistent operational fields.

Therefore it is not selected as the application logging architecture.

### 18.2 Winston

Winston provides flexible logging and transport capabilities.

However, Atlas does not currently need the additional abstraction and transport model.

The simpler structured-logging model provided by Pino better fits the current requirements.

### 18.3 OpenTelemetry immediately

OpenTelemetry provides a broader observability model across logs, metrics, and traces.

It is compatible with the selected logging architecture, but adopting it immediately would introduce tracing and metrics infrastructure before Atlas has demonstrated that requirement.

It is therefore deferred.

## 19. Consequences

### Positive consequences

- Operational logs have a predictable machine-readable structure.
- HTTP requests can be correlated across related log events.
- Production output remains compatible with standard container/deployment log collection.
- Logging remains independent from financial ledger authority.
- Domain code remains independent of Pino and HTTP infrastructure.
- Sensitive values receive an explicit protection policy.
- Duplicate error logging is reduced.
- Local development can remain readable without compromising production format.
- The architecture can later incorporate tracing and broader observability.

### Negative consequences

- Atlas must define and maintain operational event names.
- Developers must understand logging ownership rather than logging from every layer.
- Explicit logger passing may introduce additional parameters in application code.
- Structured logging requires discipline around dynamic objects and sensitive fields.
- Pino redaction configuration must be maintained as new sensitive fields are introduced.
- More sophisticated distributed correlation may eventually require additional context-propagation infrastructure.

## 20. Deferred decisions

The following are intentionally not decided by this ADR:

- OpenTelemetry adoption;
- distributed tracing;
- metrics architecture;
- trace-context propagation;
- `AsyncLocalStorage` adoption;
- centralized log-storage vendor;
- log retention duration;
- log aggregation infrastructure;
- production alerting rules;
- graceful-shutdown implementation;
- audit-record storage and schema;
- financial ledger implementation.

## 21. Reconsideration criteria

This ADR should be reconsidered if any of the following becomes true:

- request correlation cannot reliably cross required asynchronous boundaries;
- Atlas introduces distributed services requiring standardized trace propagation;
- operational log volume requires centralized sampling or aggregation policy;
- current logging throughput becomes a measurable bottleneck;
- compliance requirements require stronger audit separation;
- production diagnostics require structured request-body or payload-field capture;
- multiple independently deployed services require a shared logging schema;
- OpenTelemetry becomes a concrete observability requirement.

Reconsideration should be driven by demonstrated operational requirements rather than introducing observability infrastructure speculatively.

## 22. Related decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)

## 23. Status

**Proposed**

This ADR establishes the proposed structured logging and request-correlation architecture for Atlas.

It should become **Accepted** once the referenced ADR chain exists in the repository, the relative links resolve, and the implementation follows the boundaries defined above.
