# ADR-076 — Zero-Cost Demo Gateway and Origin Authentication

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-01

**Last reviewed:** 2026-09-01

**Canonical owner/source:** ADR-076

## Context

ADR-075 selected Cloudflare Access as the invitation boundary for Atlas's zero-cost hosted demo.
During live provider setup on 2026-09-01, the Cloudflare Workers account showed the Free plan at
`$0`, but activating Zero Trust Free required authorizing a payment card for usage above free
limits. Atlas's hosting contract prohibits both a payment-method requirement and paid overage.

The demo still needs one browser origin, an invitation-only Atlas account, and protection against
using the public Render hostname to bypass the Worker. The solution must preserve the existing
Atlas session model and must not place an origin credential in browser code, Git, logs, manifests,
or screenshots.

## Decision

Atlas will not activate Cloudflare Zero Trust or Cloudflare Access for the zero-cost demo.

```text
browser
  ↓ public login shell; Atlas session for private capabilities
Cloudflare Worker Free (*.workers.dev)
  ↓ x-atlas-gateway-secret (server-side secret only)
Render Free API
  ↓ TLS
Neon Free PostgreSQL
```

The Worker remains the sole supported browser origin. It serves static assets and proxies approved
HTTP and WebSocket paths. Before every origin request, it deletes any caller-supplied
`x-atlas-gateway-secret` value and writes the configured Worker secret.

The API requires the same secret for all HTTP requests in `demo` except `/health/live`, which must
remain reachable by Render's provider health check. `/health/ready`, `/internal/metrics`, all
`/api/v1` routes, and the Market Data WebSocket upgrade are protected. Secret comparison is
constant-time, values are bounded and validated, and the header is redacted from structured logs.

`ATLAS_GATEWAY_SHARED_SECRET` is required in `demo`, prohibited outside `demo`, and stored only as:

- a Cloudflare Worker secret; and
- a Render secret environment variable.

It is never a Wrangler variable, browser runtime value, deployment-manifest value, or repository
setting. Rotation updates both providers and verifies direct-origin rejection before the old value
is retired.

Public registration, verification, resend, and password-recovery routes remain disabled in
`demo`. The only usable account is created by the operator-only provisioning command, so private
balances, orders, trades, notifications, administration, and account operations remain accessible
only with the prepared Atlas credentials.

This is origin authentication, not an edge identity provider. Static application assets and Atlas
routes intentionally classified as public may be reachable by someone who learns the
`workers.dev` URL. The demo is not advertised or launched publicly, but URL secrecy is not treated
as access control. If every byte must be identity-gated before the application loads, Atlas needs a
provider that supplies that boundary without payment authority or an explicitly approved budget.

## Health and failure contract

- Direct Render `/health/live` may return liveness only.
- Direct Render readiness, API, metrics, and WebSocket requests fail with no secret or a wrong
  secret.
- The Worker never proxies `/internal` paths.
- Missing or invalid Worker configuration produces a generic `503`.
- Origin failure produces a generic `502` without provider or secret detail.
- Free-tier exhaustion suspends the demo and never authorizes paid overage.

## Alternatives Considered

### Authorize Cloudflare Zero Trust overage

Rejected because the checkout required permission to charge for usage above free limits. That
conflicts with the accepted zero-dollar and no-payment-method boundary even if expected usage is
small.

### Expose Render directly

Rejected because it creates a second supported browser origin and makes the Worker optional. The
shared origin secret makes direct Render application traffic fail closed.

### Put the shared secret in browser code

Rejected because every browser user could extract it. The secret authenticates the Worker to the
API and therefore exists only in provider server-side secret stores.

### Build a second authentication system in the Worker

Rejected because Atlas already owns rotating server-confirmed sessions. Duplicating identity,
cookies, recovery, and authorization at the edge would add security-critical complexity for a
one-user learning demo.

## Consequences

### Positive

- No payment method or paid-overage authorization is required.
- Direct Render application traffic cannot bypass the Worker.
- HTTP and WebSocket origin authentication use one narrow mechanism.
- Atlas's existing session, CSRF, authorization, and audit controls remain authoritative.
- Staging Cloudflare Access support remains unchanged and independently testable.

### Negative

- The public shell is not protected by an edge identity challenge.
- A shared provider secret requires coordinated rotation.
- Render liveness remains intentionally public and reveals only `{ "status": "ok" }`.
- The gateway secret proves request origin, not end-user identity.

## Reconsider When

Review this decision if Cloudflare Access becomes usable without payment authority, a different
zero-cost identity edge is selected, the demo needs multiple independently revocable reviewers, a
custom domain is approved, or a non-zero hosting budget is explicitly authorized.

## Related Decisions

- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
- [ADR-075 — Zero-Cost Private Demo Hosting and Reference Market Data](ADR-075-zero-cost-private-demo-hosting-and-reference-market-data.md)
