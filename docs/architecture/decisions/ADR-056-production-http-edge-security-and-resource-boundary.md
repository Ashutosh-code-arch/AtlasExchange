# ADR-056 — Production HTTP Edge Security and Resource Boundary

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-056

## Context

Atlas has strict domain, authentication, authorization, CSRF, input, output, and application-level
rate-limit boundaries. Phase 7 begins by hardening the process boundary that receives untrusted HTTP
traffic.

The API currently uses Helmet, exact application routes, a 32 KiB JSON-body limit, structured
errors, and graceful shutdown. However, its header behavior is implicit in library defaults, CORS
uses a static reflected value rather than an explicit origin decision, forwarded client identity is
not recorded as a deliberate trust boundary, and Node's connection-resource defaults are not part of
validated Atlas configuration.

Production readiness requires these controls to be explicit, tested, environment-aware, and safe
before Atlas introduces a reverse proxy, multiple replicas, or public deployment.

## Decision Drivers

The HTTP boundary should:

1. treat every request and forwarded identity header as untrusted by default;
2. allow credentialed browser access only from the configured exact web origin;
3. use a small deny-by-default browser security-header policy for JSON API responses;
4. enable strict transport policy only when Atlas is deployed behind managed TLS;
5. bound incomplete, slow, header-heavy, and indefinitely reused HTTP connections;
6. validate operational limits once during startup;
7. keep health, error, and authentication responses non-cacheable where appropriate;
8. avoid trusting proxy topology before deployment defines it; and
9. preserve existing business, WebSocket, authentication, and public-cache contracts.

# Decision

Atlas will establish an explicit HTTP edge-security and connection-resource baseline at the API
composition boundary.

## 1. Direct-client trust boundary

Express `trust proxy` remains explicitly disabled. `request.ip` represents the direct peer, and
Atlas ignores `Forwarded` and `X-Forwarded-For` when deriving process-local resource keys.

This is safe for the current direct local/test topology. A future deployment may enable a fixed
proxy hop count or a narrowly defined trusted proxy range only after the ingress topology is known.
Atlas will not set `trust proxy` to a blanket truth value merely because a load balancer exists.

Application authentication and authorization never depend on client IP.

## 2. Exact-origin credentialed CORS

The API grants CORS access only when the request `Origin` exactly equals configured `WEB_ORIGIN`.
Requests without that exact origin receive no CORS permission headers. Server-to-server and
same-origin requests do not require CORS permission.

Accepted browser methods are:

~~~text
GET, POST, PUT, PATCH, DELETE, OPTIONS
~~~

Accepted request headers are:

~~~text
Content-Type
X-CSRF-Token
Idempotency-Key
X-Request-ID
~~~

Only `X-Request-ID` and `Retry-After` are exposed to browser code. Credential support remains
enabled because Atlas uses secure HTTP-only session cookies. Successful preflight decisions may be
cached by the browser for ten minutes. CORS remains a browser boundary, not authentication, CSRF
protection, or authorization.

## 3. API response security headers

Every API response receives an explicit policy:

- `Content-Security-Policy` denies all content and prohibits base, form, and frame ancestors;
- `Cross-Origin-Opener-Policy: same-origin`;
- `Cross-Origin-Resource-Policy: same-site`;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY`;
- origin-agent isolation and legacy defensive headers supplied by the pinned Helmet version; and
- `Permissions-Policy` disables camera, geolocation, microphone, payment, and USB capabilities.

The CSP protects JSON error documents and accidental future document responses. It is not the
browser application's final static-asset CSP; the web hosting boundary must define that separately
when deployment selects asset, font, and connection origins.

`X-Powered-By` remains disabled.

## 4. Strict transport policy

HSTS is emitted only when `ATLAS_ENV` is `staging` or `production`, where Atlas already requires
secure cookies, an explicit CSRF signing key, SMTP configuration, and a managed password blocklist.
The policy is one year and includes subdomains. Preload is not asserted.

Local, test, and CI HTTP responses do not emit HSTS. Atlas derives this decision from validated
environment identity, never from a request's forwarded protocol header.

TLS termination, redirect-to-HTTPS behavior, certificate ownership, and preload eligibility belong
to the deployment ingress decision.

## 5. Node HTTP connection limits

The API applies validated limits directly to its Node HTTP server:

| Limit | Default | Accepted range |
|---|---:|---:|
| Complete request timeout | 30,000 ms | 1,000–120,000 ms |
| Header timeout | 10,000 ms | 1,000–60,000 ms |
| Keep-alive timeout | 5,000 ms | 1,000–30,000 ms |
| Header count | 100 | 16–200 |
| Requests per socket | 1,000 | 1–10,000 |

The header timeout must be greater than the keep-alive timeout, and the request timeout cannot be
shorter than the header timeout. Invalid relationships fail startup with variable names only.

The existing 32 KiB JSON-body limit remains. WebSocket message, buffer, connection, subscription,
heartbeat, and origin limits remain independently governed by ADR-042.

These process limits reduce exposure to slow or excessive direct connections. They do not replace
ingress limits, distributed quotas, or capacity testing.

## 6. Error caching and containment

All structured API error responses carry `Cache-Control: no-store`, including validation,
authorization, rate-limit, missing-route, and unexpected-error responses. Existing public success
routes retain their deliberately accepted caching contracts.

Unexpected errors remain generic to clients and detailed only in redacted structured logs.

## 7. Scope

This slice does not introduce TLS termination, a trusted proxy, a WAF, distributed rate limiting,
DDoS protection, dependency scanning, container hardening, secret rotation, static-web hosting
headers, penetration testing, vulnerability disclosure, security dashboards, or deployment ingress
configuration. Each requires a later focused Phase 7 or Phase 8 decision.

## Alternatives Considered

### Keep Helmet defaults implicit

Rejected because library defaults can change during upgrades and do not express Atlas's managed-TLS
or API-only document policy.

### Trust all forwarded headers

Rejected because an internet client could forge its apparent address or protocol whenever traffic
bypasses or is misrouted around the expected proxy.

### Reject every hostile-origin request at the API

Rejected as a CORS strategy because CORS controls browser response access, not general HTTP client
authorization. Sensitive routes already enforce authentication, authorization, CSRF, and strict
input independently.

### Emit HSTS in local development

Rejected because browsers may persist HSTS and make ordinary local HTTP development unexpectedly
unreachable.

### Rely exclusively on future ingress limits

Rejected because direct process limits are inexpensive defense in depth and keep local, test, and
misconfigured deployment behavior bounded.

## Consequences

### Positive Consequences

- The API's direct-client and proxy trust boundary is explicit.
- Hostile browser origins receive no credentialed CORS permission.
- Security headers are stable, reviewed, and covered by tests.
- HSTS cannot be enabled by spoofing request metadata.
- Slow, header-heavy, and indefinitely reused connections have bounded resource budgets.
- Invalid operational relationships fail before the server listens.
- Error responses cannot be reused by intermediary or browser caches.

### Negative Consequences

- New legitimate browser origins require an explicit configuration-policy change.
- Conservative timeouts may require measurement and tuning under real load.
- One exact web origin does not yet support preview deployments or multiple frontends.
- Direct-peer rate-limit identity will group traffic when Atlas is later placed behind a proxy until
  the trusted topology is configured.
- The static web application still requires deployment-owned security headers.

## Reconsider When

Review this decision when Atlas selects an ingress, supports multiple web origins, deploys multiple
API replicas, introduces long-running HTTP uploads, measures different connection behavior under
load, enables an additional browser capability, or establishes a static-asset CSP and trusted proxy
policy.

## Related Decisions

- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-014 — Structured Logging and Request Correlation Strategy](ADR-014-structured-logging-and-request-correlation-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
