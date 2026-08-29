# ADR-057 — API Admission Rate Limiting and Abuse Protection

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-057

## Context

Atlas already protects sensitive capabilities with module-owned rate limits. Identity limits
registration, login, refresh, verification, recovery, reset, and logout-all independently.
Financial and Trading preserve idempotent retries while limiting new value-moving or order intents.
Market Data, Portfolio, Notifications, and Administration have separate read or mutation policies.

Those controls protect business semantics, but they do not provide a coarse admission boundary for
unknown routes, low-cost public routes, or request floods spread across modules. A caller can force
HTTP parsing, routing, authentication, and application-specific limit evaluation without first
passing a process-wide resource budget.

ADR-056 deliberately leaves forwarded identity untrusted and notes that process-local controls are
not distributed DDoS protection. This decision adds bounded defense in depth for the current direct
connection topology without replacing the more precise module-owned policies.

## Decision Drivers

The admission boundary should:

1. bound HTTP work before JSON parsing, authentication, or module routing;
2. prevent high-volume reads from consuming the complete mutation budget and vice versa;
3. derive identity only from the direct peer while proxy trust is disabled;
4. keep memory use bounded under high-cardinality traffic;
5. fail safely and return deterministic retry guidance;
6. preserve health checks and browser preflight behavior;
7. retain stricter module-owned and retry-preserving policies;
8. validate operational settings before the process listens; and
9. emit useful security evidence without logging client addresses or credentials.

# Decision

Atlas will apply a process-local API admission limiter at the `/api/v1` composition boundary.

## 1. Two independent admission classes

Requests use one of two fixed-window budgets:

| Class | Methods | Default per direct peer | Purpose |
|---|---|---:|---|
| Read | `GET`, `HEAD` | 600 per 60 seconds | Queries, catalogues, status, and unknown read routes |
| Mutation | Every other method reaching the boundary | 120 per 60 seconds | Commands and hostile or unsupported method traffic |

Independent stores ensure ordinary polling cannot exhaust mutation admission and a command flood
cannot make all reads unavailable. These are coarse process-resource budgets, not product quotas.
They do not authorize a request and do not replace authentication, CSRF, permission, validation,
idempotency, or module-specific limits.

Successful exact-origin CORS preflights terminate at the CORS boundary and consume no application
admission capacity. A preflight that receives no CORS permission may continue as ordinary unsupported
method traffic and can consume mutation capacity.

## 2. Ordering and route scope

Request correlation and structured request logging are established before admission. The limiter
runs before the 32 KiB JSON parser, authentication, and module routers. This gives rejected requests
a correlation identifier while avoiding avoidable parsing and business work.

Only `/api/v1` traffic is admitted through this policy. `/health/live` and `/health/ready` remain
independent so orchestrator health decisions cannot be exhausted by public API traffic. WebSocket
connections retain the connection, per-client, subscription, message, heartbeat, and backpressure
limits accepted by ADR-042.

## 3. Direct-peer identity

The key is Express's direct `request.ip`, with the socket address as a defensive fallback. Because
`trust proxy` is explicitly disabled, `Forwarded` and `X-Forwarded-For` cannot create or select a
rate-limit identity.

Atlas does not use this identity for authentication, authorization, financial ownership, or audit
attribution. It is only a transient process-resource key.

A deployment behind a reverse proxy will initially aggregate requests under the direct proxy peer.
Phase 8 must define exact trusted hops or networks before Atlas derives client identity from a
forwarded header.

## 4. Bounded fixed-window storage

Each class stores at most 10,000 active client windows by default. Expired windows are removed when
new identities arrive. If the store remains full, an untracked identity is rejected until the
earliest active window expires rather than allocating unbounded memory or evicting an active
attacker's counter.

The limiter returns a positive whole-second `Retry-After` value both for request-budget exhaustion
and tracking-capacity exhaustion. Tracking-capacity exhaustion is visible only in internal event
metadata; the public response remains identical to avoid exposing process state.

Fixed windows are accepted for this single-process defensive layer because they are deterministic,
small, dependency-free, and bounded. Exact product-operation policies remain independently owned by
their modules.

## 5. Configuration

The following variables are validated once during startup:

| Variable | Default | Accepted range |
|---|---:|---:|
| `HTTP_RATE_LIMIT_WINDOW_MS` | 60,000 | 1,000–3,600,000 |
| `HTTP_READ_RATE_LIMIT_MAX_REQUESTS` | 600 | 10–100,000 |
| `HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS` | 120 | 5–20,000 |
| `HTTP_RATE_LIMIT_MAX_TRACKED_CLIENTS` | 10,000 | 100–100,000 |

The read budget cannot be lower than the mutation budget. Invalid values or relationships fail
startup and disclose variable names only.

These defaults are initial safety bounds, not measured production capacity. Load testing and real
traffic evidence must inform later tuning.

## 6. Rejection contract and evidence

Admission rejection returns:

~~~text
HTTP 429
Retry-After: <positive integer seconds>
Cache-Control: no-store

{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Request rate limit exceeded.",
    "requestId": "<correlation identifier>"
  }
}
~~~

The API logs a warning event named `http.admission_rate_limit.exceeded` with the request method,
path, admission class, internal rejection reason, and retry interval. It does not log the raw peer
address, forwarded-address headers, cookies, bodies, or credentials.

## 7. Relationship to module policies

Admission and module-owned limiting are intentionally overlapping:

~~~text
HTTP admission budget
        ↓
request parsing and security boundaries
        ↓
module-owned semantic limit
        ↓
application capability
~~~

A request admitted by this policy may still be rejected by a stricter business-operation limiter.
Retry-preserving Identity, Financial, and Trading behavior does not change. The admission layer may
count an identical retry because it protects process work rather than new business intent.

## 8. Scope

This decision does not add distributed coordination, account billing quotas, adaptive risk scoring,
CAPTCHA, IP reputation, geographic policy, automated account suspension, a reverse-proxy trust
configuration, WAF rules, CDN controls, or volumetric DDoS mitigation. It also does not make
process-local request counts a durable audit record.

## Alternatives Considered

### Rely only on existing module limits

Rejected because unknown routes and work performed before module admission remain unbounded, and a
caller can distribute traffic across independent module policies.

### Use one shared budget for every method

Rejected because polling or catalogue traffic could exhaust mutation capacity and mutation floods
could remove all diagnostic and recovery reads.

### Trust `X-Forwarded-For` immediately

Rejected because the current topology has no accepted trusted proxy boundary. A direct caller could
forge identities and evade limits.

### Evict active keys when tracking capacity is full

Rejected because rotating identities could continuously evict counters and bypass the limiter. The
bounded store instead fails closed until capacity naturally expires.

### Add Redis-backed distributed limiting now

Rejected because Atlas has one API process and no selected managed runtime or replica topology.
Distributed coordination belongs with the deployment architecture and measured scaling need.

## Consequences

### Positive Consequences

- Every version-one API route and unknown API path receives bounded coarse admission.
- Read and mutation resource budgets cannot starve one another.
- Oversized or invalid bodies must pass admission before consuming parsing or module work.
- Forwarded-header spoofing cannot create new limiter identities.
- Attacker-controlled key cardinality cannot grow process memory without limit.
- Rejections use the established safe envelope, correlation, caching, and retry contract.
- Existing semantic and idempotency-aware limits remain intact.

### Negative Consequences

- Fixed windows permit a burst near a window boundary.
- Process-local counters reset on restart and are not coordinated across replicas.
- A full tracking store temporarily rejects previously unseen peers.
- Direct peers behind an untrusted proxy are aggregated until deployment defines trusted forwarding.
- Default budgets require performance evidence and operational tuning.

## Reconsider When

Review this decision when Atlas selects an ingress, enables trusted forwarded identity, runs more
than one API replica, observes false positives, measures different safe capacity, needs customer
quotas, or requires coordinated abuse response across processes and regions.

## Related Decisions

- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-023 — Financial HTTP API and Error Contract](ADR-023-financial-http-api-and-error-contract.md)
- [ADR-029 — Public Trading HTTP API and Read Contract](ADR-029-public-trading-http-api-and-read-contract.md)
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
