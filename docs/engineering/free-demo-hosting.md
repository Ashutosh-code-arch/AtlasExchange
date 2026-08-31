# Atlas Zero-Cost Demo Hosting Runbook

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-08-31

This runbook implements ADR-075. It does not claim production readiness and does not authorize a
paid plan, paid overage, custom domain, public launch, real custody, or external order execution.

## Current state

```text
Environment contract:          accepted; implementation pending
Recurring-cost ceiling:        $0
Cloudflare account/Worker:     no evidence
Cloudflare Access policy:      no evidence
Render account/Free API:       no evidence
Neon account/Free PostgreSQL:  no evidence
Demo identity path:            not implemented
Coinbase reference adapter:    not implemented
Reference chart:               not implemented
Candidate API image:           v0.1.1 published and verified
Production approval:           no-go
```

## Zero-cost topology

| Resource | Required plan | Purpose |
| --- | --- | --- |
| Cloudflare Worker + Static Assets | Free | React assets, runtime config, HTTP/WebSocket gateway |
| Cloudflare Access | Free allowance | Exact invited-identity admission by Worker name |
| Render web service | Free | One digest-pinned Atlas API instance |
| Neon project | Free | PostgreSQL 18 with scale to zero |
| Coinbase Market Data WebSocket | Public unauthenticated | Read-only BTC-USD/ETH-USD reference feed |

Do not attach a custom domain or enable a paid provider plan. Do not add a payment method merely to
increase a limit. When an allowance is exhausted, accept suspension or revise ADR-075.

## Repository work before provider setup

- [ ] Add `demo` configuration without weakening `staging` or `production` validation.
- [ ] Add the Cloudflare Worker static/gateway application and tests.
- [ ] Add an operator-only pre-verified demo-identity command and disable public demo registration.
- [ ] Add the Coinbase reference-data adapter, contracts, freshness, and reconnect tests.
- [ ] Add the labeled real-price/candlestick surface.
- [ ] Add a zero-cost deployment manifest/input validator.
- [ ] Publish and verify a new release containing the demo runtime.

## External setup inputs

- [ ] Cloudflare account and unique `workers.dev` subdomain.
- [ ] Exact invited email allow-list and Access team administrator.
- [ ] Render Hobby workspace with no paid service or overage authority.
- [ ] Neon Free project in the nearest suitable region.
- [ ] Restricted storage for the Neon connection string, CSRF key, and demo-user bootstrap material.

No secret or invited identity belongs in Git, generated manifests, shell history, screenshots, or
readiness records.

## Intended activation order

1. Validate all repository checks and publish the exact candidate images.
2. Create the Neon Free project and apply committed migrations from a controlled local command.
3. Create the pre-verified demo identity through the operator command.
4. Create one Render Free web service from the exact API image digest.
5. Enter the Neon URL and application secrets through Render's secret UI.
6. Require `/health/live`, `/health/ready`, and the exact application version.
7. Create the Cloudflare Worker with static assets and the exact Render origin as a secret/config
   binding.
8. Protect the Worker by name with one exact-email Cloudflare Access policy.
9. Configure the Render API with the exact Access issuer and Worker application audience.
10. Prove direct Render requests fail while Worker-proxied HTTP and WebSocket traffic pass.
11. Prove public registration/recovery are disabled and the prepared demo identity can sign in.
12. Prove Coinbase reference prices/candles are labeled, fresh, and unable to affect Atlas matching.
13. Record provider allowance dashboards and confirm every selected resource displays `$0`.

## Stop conditions

Stop when a provider requests a paid upgrade, a payment method is required for the selected path,
direct Render access bypasses assertion validation, the Worker cannot proxy WebSockets, public
registration remains open, a secret would enter source, external data affects simulated execution,
or the UI fails to distinguish Coinbase reference data from Atlas simulated state.

## Accepted demo limitations

- The first request after idle may take about one minute.
- Render, Neon, and external market-data providers can restart, throttle, or suspend free services.
- Demo data is synthetic and replaceable.
- There is no uptime, latency, recovery, or support SLA.
- This environment provides demonstration evidence only and cannot produce a production `go`.
