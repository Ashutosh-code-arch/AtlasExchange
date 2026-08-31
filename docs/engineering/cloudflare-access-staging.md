# Atlas Cloudflare Access Staging Runbook

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-08-31

This runbook implements ADR-068. It records a safe activation sequence; it does not authorize domain
transfer, DNS changes, invited-user access, paid service, or staging exposure.

## Current state

```text
Access provider selected:          Cloudflare Access
Origin JWT validation implemented: API HTTP + WebSocket, web HTTP
Owned domain supplied:             no
Cloudflare zone/team created:      no evidence
Monitor service token/policy:      no evidence
Exact invited emails approved:     no
Access application/AUD created:    no
DNS records changed:               no
Render origins provisioned:        no
Staging publicly reachable:        no
```

## Required external inputs

- [ ] Atlas-controlled registrable domain and accountable owner.
- [ ] Exact web and API staging hostnames beneath that site.
- [ ] Cloudflare account, zone, team domain, and accountable administrator.
- [ ] Exact invited email addresses approved by the user.
- [ ] Live confirmation that the Zero Trust Free plan covers the intended reviewer count and features.
- [ ] Render service hostnames used only as CNAME targets and certificate-verification inputs.
- [ ] Approved Access application/policy session duration if eight hours is unsuitable.
- [ ] Dedicated ADR-069 availability-probe service token and approved expiry.

Do not commit email addresses, provider account identifiers, DNS verification values, or access-event
exports merely to satisfy this checklist.

## Intended Access application

Create one self-hosted application named `Atlas staging` with both concrete public hostnames. Do not
use a wildcard.

```text
Application action:       deny by default
Allowed identities:       exact approved email addresses only
Initial login method:     one-time PIN
Application session:      8 hours
Policy session:           8 hours
Eager redirect cookies:   enabled
HttpOnly:                 enabled
SameSite:                 Lax
Binding cookie:           enable, then test HTTP and WebSocket
Bypass policies:          none
Machine policy:           Service Auth, exact availability-probe token only
API OPTIONS behavior:     bypass Access to Atlas origin CORS
```

Never create an Allow rule containing `Everyone`, only `One-time PIN`, or an entire public email
domain. OTP sends mail only to identities already allowed by the exact-email policy.
Never select `Any Access Service Token` for monitoring. The machine policy must name only the
dedicated probe token and must not become a Bypass policy.

## Activation sequence

1. Record current Cloudflare plan, reviewer limit, and log retention.
2. Add the owned zone without changing unrelated records or account-wide access behavior.
3. Add both concrete custom domains to their Render services.
4. Create DNS-only CNAME records to the exact Render service hostnames.
5. Wait for Render domain verification and valid certificates.
6. Create the single two-host Access application and exact-email policy.
7. Enable eager cookies, bounded sessions, API `OPTIONS` bypass, and the reviewed cookie settings.
8. Add the exact-token Service Auth policy only when the ADR-069 synthetic secret store is ready.
9. Set both CNAMEs to Cloudflare Proxied and use Full TLS mode.
10. Put the same team origin and application audience into both Render services:

   ```text
   ATLAS_ENV=staging
   CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
   CLOUDFLARE_ACCESS_AUDIENCE=<application audience>
   ```

11. Deploy the exact candidate digests and confirm both services start fail-closed.
12. Disable both Render `onrender.com` subdomains.
13. Complete every proof below before inviting a reviewer.

If Render requires DNS-only mode again for certificate renewal, stop reviewer access and establish a
documented maintenance path before weakening the proxy boundary.

## Mandatory proof

### Admission and bypass

- An unlisted email cannot obtain Access admission.
- A listed email can complete OTP and reaches the web origin once.
- Removing that email and revoking its session denies the next request.
- Direct requests to both Render origins cannot retrieve web assets, runtime configuration, API data,
  or open a WebSocket without a valid signed assertion.
- Missing, malformed, expired, wrong-audience, wrong-issuer, and incorrectly signed assertions fail
  with generic `403` behavior.
- Render health checks still pass, and private metrics still require their independent bearer token.
- The external readiness probe succeeds only with the exact service token, fails after its policy is
  removed/revoked, and still reaches an origin-validated Cloudflare assertion.

### Browser and protocol

- Eager cookie redirects issue credentials for both concrete hosts without a second login.
- Registration, login, refresh, logout, CSRF-protected mutation, and password-reset navigation pass.
- Atlas cookies remain `Secure`, `HttpOnly`, host-scoped, and separate from Access cookies.
- API preflight reaches Atlas and returns only its exact origin/method/header policy.
- The Market Data WebSocket opens through Access, negotiates `atlas.market-data.v1`, receives
  heartbeat/snapshots, reconnects, and fails when Access admission is absent or revoked.
- Supported normal Chrome, Firefox, and Safari profiles are recorded; private browsing is not assumed.

### DNS, TLS, and proxy identity

- DNS resolves through Cloudflare after Render certificate issuance.
- Both custom hostnames present valid certificates and redirect HTTP to HTTPS.
- Default Render subdomains return `404` after being disabled.
- Host-header and direct-resolution bypass attempts fail at origin assertion validation.
- Hostile `X-Forwarded-For`, `Forwarded`, and provider-specific identity headers are exercised through
  every reachable path.
- `HTTP_TRUST_PROXY_HOPS` is set only from the observed fixed chain and cannot be used to spoof rate
  limit identity.

## Evidence to retain

Record timestamps, reviewer/policy revision identifiers, application audience fingerprint, source
revision, image digests, DNS/TLS results, Access decision IDs, browser versions, WebSocket results,
origin-bypass results, and proxy observations. Redact assertion tokens, cookies, OTPs, email addresses,
provider credentials, service-token values, and complete DNS-account screenshots.

Cloudflare's short free-plan log retention is operational evidence only. Exported durable audit
retention remains a later observability decision.

## Rollback

1. Remove all reviewer Allow policies or disable the Access application.
2. Keep origin-side validation enabled so direct Render traffic stays denied.
3. Disable the custom domains or remove their proxied DNS records if exposure continues.
4. Revoke active Access sessions.
5. Preserve sanitized evidence and identify whether policy, DNS, cookies, WebSocket, JWT, or proxy
   behavior failed.
6. Do not enable `onrender.com` access or remove origin validation as a workaround.

## Stop conditions

Stop activation when any hostname bypasses Access, origin assertion validation fails open, Access
requires a browser-visible service secret, eager cookies do not support the API flow, preflight is
broader than Atlas CORS, WebSockets fail through the gate, the proxy chain remains ambiguous, a
reviewer policy grants more than exact approved identities, or the live plan exceeds approved cost.
