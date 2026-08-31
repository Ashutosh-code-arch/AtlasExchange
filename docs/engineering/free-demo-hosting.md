# Atlas Zero-Cost Demo Hosting Runbook

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-08-31

This runbook implements ADR-075. It does not claim production readiness and does not authorize a
paid plan, paid overage, custom domain, public launch, real custody, or external order execution.

## Current state

```text
Environment contract:          implemented; provider values pending
Recurring-cost ceiling:        $0
Cloudflare account/Worker:     no evidence
Cloudflare Access policy:      no evidence
Render account/Free API:       no evidence
Neon account/Free PostgreSQL:  no evidence
Demo identity path:            implemented; operator execution pending
Coinbase reference adapter:    implemented; runtime activation pending
Reference chart:               implemented; deployment activation pending
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

- [x] Add `demo` configuration without weakening `staging` or `production` validation.
- [ ] Add the Cloudflare Worker static/gateway application and tests.
- [x] Add an operator-only pre-verified demo-identity command and disable public demo registration.
- [x] Add the Coinbase reference-data adapter, contracts, freshness, and reconnect tests.
- [x] Add the labeled real-price/candlestick surface.
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

## Reference-data runtime contract

The API keeps the Coinbase feed disabled unless `REFERENCE_MARKET_DATA_ENABLED=true`. When enabled,
it connects only to `wss://advanced-trade-ws.coinbase.com`, subscribes without credentials to
`ticker_batch`, `candles`, and `heartbeats`, and serves bounded read-only snapshots at:

```text
GET /api/v1/reference-market-data/markets/:marketCode/ticker
GET /api/v1/reference-market-data/markets/:marketCode/candles?interval=5m&limit=100
```

Only `BTC-USD` and `ETH-USD` are accepted. Responses name Coinbase and include observed, received,
and live/stale metadata. No response includes Atlas projection sequences or any command that can
enter Trading or Financial. Before the first valid provider message, the API returns
`REFERENCE_DATA_UNAVAILABLE` rather than substituting a simulated price.

The Trading workspace renders those snapshots in a source-labeled Coinbase quote and five-minute
candlestick surface. It keeps the Atlas order book, ticket, activity, orders, fills, balances, and
settlement visibly labeled as simulation. Provider failure produces a stale or unavailable
reference state; the browser never substitutes an Atlas simulated price.

## Demo runtime contract

`ATLAS_ENV=demo` is a managed environment. API startup fails closed unless it has an HTTPS browser
origin, at least one trusted proxy hop, an explicit password blocklist, a strong CSRF key, a paired
Cloudflare Access team domain/audience, and the Coinbase reference feed enabled. Secure transport
and cookies are mandatory. Simulated funding and withdrawals default on; no real-asset capability
is introduced.

The API hides these routes with the same `ROUTE_NOT_FOUND` contract as an absent endpoint:

```text
POST /api/v1/auth/register
POST /api/v1/auth/resend-verification
POST /api/v1/auth/verify-email
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
```

Login and authenticated session management remain enabled. The browser runtime accepts matching
public feature flags, removes registration/recovery controls, shows invitation-only guidance, and
keeps `Demo · Simulation` visible in the application header.

## Provision the prepared demo identity

Run migrations first. Then create a mode-`0600` environment file outside the repository and outside
shell history. Store it in an operator-controlled location; never commit it or paste its values into
the command line.

```dotenv
ATLAS_ENV=demo
DATABASE_URL=postgresql://...
EXPECTED_SCHEMA_VERSION=15
PASSWORD_BLOCKLIST_PATH=/absolute/restricted/path/atlas-password-blocklist.sha256
DEMO_IDENTITY_EMAIL=invited-reviewer@example.com
DEMO_IDENTITY_PASSWORD=replace-with-a-unique-long-password
```

```bash
chmod 600 /absolute/restricted/path/atlas-demo-bootstrap.env
ATLAS_DEMO_BOOTSTRAP_ENV_FILE=/absolute/restricted/path/atlas-demo-bootstrap.env \
  pnpm --filter @atlas/api identity:provision-demo
```

The command refuses non-`demo` execution, validates database schema readiness and the password
blocklist, creates one active `user` identity without verification/reset tokens, and records a
security event. An exact repeat returns `existing`; changed password, casing, state, or roles fails
without overwriting the account. Output never includes the email, password, database URL, or user
identifier.

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
