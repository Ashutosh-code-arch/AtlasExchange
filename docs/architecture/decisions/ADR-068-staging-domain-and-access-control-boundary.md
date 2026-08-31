# ADR-068 — Staging Domain and Access-Control Boundary

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-31  
**Last reviewed:** 2026-08-31  
**Canonical owner/source:** ADR-068

## Context

ADR-067 selects Render for Atlas's first production-shaped staging environment but blocks public
provisioning until both staging origins have an application-independent access boundary. Atlas must
remain shareable with specifically invited reviewers without publishing a simulated exchange, test
identities, operational endpoints, or incomplete workflows to every internet user.

The browser and API are separate HTTPS origins under one registrable site. The browser uses
credentialed CORS, Atlas session cookies, CSRF tokens, and a direct API WebSocket. Any access product
must protect both origins without embedding a reusable secret in browser code or replacing Atlas
identity. Because Render custom-domain traffic still reaches a public origin, DNS proxying alone does
not prove that the edge cannot be bypassed.

## Decision Drivers

The boundary should:

1. deny every uninvited user before Atlas application routes execute;
2. support explicit sharing without requiring a VPN client;
3. preserve the two-origin SPA, credentialed CORS, and WebSocket contracts;
4. prevent direct-to-Render requests from forging edge identity;
5. keep Atlas authentication and authorization independent from staging admission;
6. preserve Render's direct health checks and private metrics collection;
7. fail API and web startup when staging access configuration is absent;
8. avoid a new paid product before measured need; and
9. keep the exact domain, invited identities, and provider account outside source.

# Decision

Atlas selects **Cloudflare Access on Cloudflare-proxied custom hostnames** as the initial staging
access boundary.

Cloudflare's free Zero Trust plan is sufficient for the initial small reviewer set, but current
pricing and limits must be rechecked before activation. This decision creates no Cloudflare account,
zone, user, DNS record, identity provider, or paid subscription.

## 1. Domain topology

The operator supplies one Atlas-controlled registrable domain. Staging uses two concrete hostnames:

```text
https://app.staging.<owned-domain>  → Cloudflare Access → Render web origin
https://api.staging.<owned-domain>  → Cloudflare Access → Render API origin
                                      └── HTTP + WebSocket
```

Both names remain same-site and are registered as custom domains on their respective Render services.
The DNS CNAME records are DNS-only only while Render verifies ownership and issues certificates;
afterward they must be Cloudflare-proxied. Both Render `onrender.com` subdomains are then disabled.

The exact domain is an external input and must not be invented or committed as if it were owned.
Wildcard Access hostnames are prohibited initially. Concrete hostnames let Access eagerly issue the
per-domain authorization cookies the SPA needs before its first cross-origin API request.

## 2. One multi-domain Access application

One self-hosted Access application contains both concrete hostnames and one shared audience tag. It
uses:

- deny by default;
- one Allow policy containing exact invited email addresses;
- one separate Service Auth policy containing only the dedicated ADR-069 availability-probe token;
- one-time PIN for the initial small external reviewer set;
- no `Everyone`, email-domain-wide, login-method-only, or permanent Bypass rule;
- an eight-hour application and policy session;
- eager redirect cookies enabled;
- `HttpOnly` enabled and `SameSite=Lax` for Access cookies; and
- the binding cookie enabled after browser and WebSocket validation.

An organizational identity provider and enforced MFA are preferred when Atlas has a stable team.
OTP is a staging-sharing convenience, not Atlas account authentication and not a production identity
decision. Removing a reviewer from the exact allow-list is the revocation mechanism; session
revocation evidence must also be tested.

The monitoring Service Auth policy is machine admission, not user admission. It must select one exact
service token and must not use `Any Access Service Token`, `Everyone`, or Bypass. Its credentials live
only in the synthetic-monitoring secret store and grant no Atlas identity or application authority.

## 3. CORS and browser behavior

Access is configured to bypass unauthenticated `OPTIONS` requests to the API origin. Atlas's existing
exact-origin CORS middleware remains authoritative and returns the bounded methods, headers,
credential flag, and cache duration. No business route accepts an unauthenticated request merely
because preflight is allowed.

The multi-domain application's eager-cookie flow must be tested in the supported normal browser
profile before traffic. Private/incognito modes that block required cross-origin Access cookies are
not an Atlas compatibility promise. The browser continues to use `credentials: include`; no Access
token or service credential enters JavaScript storage.

## 4. Origin-side signed assertion enforcement

Cloudflare-proxied DNS and Access policy are insufficient on their own because Atlas does not connect
to Cloudflare through a private Tunnel. The web and API origins therefore validate the
`Cf-Access-Jwt-Assertion` header using Cloudflare's remotely rotated JWKS, exact HTTPS team issuer,
the shared application audience, expiry, and `RS256`.

The API applies the same verifier to normal HTTP requests and WebSocket upgrades. Missing, malformed,
expired, incorrectly scoped, or incorrectly signed assertions receive a generic `403`; the token is
never logged. The web origin independently performs the same validation before serving runtime
configuration, application HTML, or static assets.

The only origin-side exceptions are:

- API `/health/live` and `/health/ready`, for Render lifecycle checks;
- web `/health/live`, for Render lifecycle checks;
- API `OPTIONS`, which remains constrained by Atlas CORS; and
- API `/internal/metrics`, which remains private-network-only and bearer-authenticated.

These exceptions expose no account, trading, financial, browser artifact, or application-metrics
payload without its existing control. Public probes must authenticate through Access with a scoped
service identity rather than widening the exceptions.

## 5. Configuration and startup

Both deployables use the same non-secret values:

```text
ATLAS_ENV=staging
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUDIENCE=<one multi-domain application AUD>
```

The team domain must be a credential-free HTTPS origin under `cloudflareaccess.com`. The audience is
bounded opaque identifier data. Staging startup fails if either value is absent, invalid, or
unpaired. Local and test execution remain Access-free by default.

Atlas uses the maintained `jose` implementation and Cloudflare's remote signing-key endpoint instead
of committing keys. Key-fetch or validation failure denies access; it does not fall open.

## 6. Proxy identity remains a separate proof

Adding Cloudflare creates a path containing Cloudflare and Render edge components. This ADR does not
guess a numeric Express proxy-hop count. Before traffic, hostile-header tests must observe every
reachable path and prove which component overwrites or appends forwarded identity. Only that evidence
may set `HTTP_TRUST_PROXY_HOPS`.

The signed Access assertion proves staging admission; it does not prove the browser's source IP and
must not be reused as Atlas user identity or authorization.

## Alternatives Considered

### Render custom domains without an access layer

Rejected because custom-domain TLS and hidden `onrender.com` names do not authenticate invited users
or prove that direct origin traffic is denied.

### HTTP Basic Authentication in Atlas

Rejected because it introduces shared credentials, awkward cross-origin browser behavior, weak
reviewer revocation, and application-owned staging admission. It also risks placing reusable secrets
in browser or test configuration.

### Cloudflare Access without origin JWT validation

Rejected because a direct-to-origin request could forge the assertion header or bypass the Cloudflare
policy. Cloudflare explicitly requires origins not connected by Tunnel to verify token signatures.

### Cloudflare Tunnel from Render

Deferred. It could remove the public-origin route but adds a second managed process, tunnel lifecycle,
health, and deployment ownership to each service. Reconsider if signed assertion enforcement is
insufficient or Render can support a simple private tunnel topology.

### VPN or Cloudflare One Client only

Rejected initially because invited reviewers should not need installed device software. Reconsider
for administrative or private infrastructure surfaces.

## Consequences

### Positive Consequences

- Atlas can be shared with an explicit reviewer list while remaining deny-by-default.
- Browser API calls and WebSockets retain their existing architecture.
- Signed origin validation closes the most important public-origin bypass.
- Atlas identity remains independently testable behind the staging gate.
- Staging configuration fails closed and uses no browser-visible shared secret.
- The initial Access plan can remain free for a small reviewer set.

### Negative Consequences

- Staging now depends on Cloudflare in addition to Render.
- Two edge layers complicate forwarded client identity and debugging.
- Cross-origin Access cookies and preflight configuration require real-browser evidence.
- JWKS reachability can deny cold requests during provider/network failure.
- Health endpoints remain intentionally reachable at the Render origin.
- Free-plan logs have short retention and do not satisfy Atlas's durable audit needs by themselves.

## Reconsider When

Review this decision when the invited set approaches the plan limit, a stable workforce IdP exists,
OTP is inadequate, device posture becomes required, Access disrupts CORS or WebSockets, origin bypass
cannot be closed, longer access-log retention is needed, Render proxy evidence is unsafe, staging
moves providers, or production access requirements are being selected.

## References

- [Cloudflare Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
- [Cloudflare Access authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
- [Cloudflare Access CORS behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Access one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare proxied WebSockets](https://developers.cloudflare.com/network/websockets/)
- [Cloudflare Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/)
- [Render Cloudflare DNS configuration](https://render.com/docs/configure-cloudflare-dns)

## Related Decisions

- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-019 — Identity HTTP API, Cookie, CSRF, and Error Contract](ADR-019-identity-http-api-cookie-csrf-and-error-contract.md)
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
- [ADR-067 — Initial Staging Platform and Managed PostgreSQL Provider](ADR-067-initial-staging-platform-and-managed-postgresql-provider.md)
- [ADR-069 — Staging Observability Collection, Alerting, and Availability](ADR-069-staging-observability-collection-alerting-and-availability.md)
