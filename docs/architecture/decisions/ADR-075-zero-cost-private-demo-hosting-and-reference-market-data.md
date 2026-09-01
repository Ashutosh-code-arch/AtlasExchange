# ADR-075 — Zero-Cost Private Demo Hosting and Reference Market Data

**Classification:** Canonical

**Status:** Accepted; access and origin-authentication sections amended by ADR-076

**Date:** 2026-08-31

**Last reviewed:** 2026-08-31

**Canonical owner/source:** ADR-075

> **Amendment:** Live provider setup showed that Cloudflare Zero Trust Free required payment-card
> authorization for overage. ADR-076 therefore replaces this ADR's Cloudflare Access boundary with
> Atlas invitation-only sessions plus a Worker-to-Render shared origin secret. The zero-cost
> topology, Neon, Render, Coinbase reference-data, and simulation decisions remain in force.

## Context

Atlas is a solo learning project and will not launch publicly, accept real money, custody assets, or
route orders to an external venue. Its first hosted environment exists to demonstrate the product,
support interviews, and let explicitly invited reviewers exercise simulated exchange behavior.

ADRs 067–070 selected a production-shaped Render staging environment with a Pro workspace, three
paid services, paid PostgreSQL, purchased-domain assumptions, Cloudflare Access, and Grafana Cloud.
Current public pricing puts that fixed topology above Atlas's acceptable budget. The user has now
made zero recurring hosting cost a hard requirement.

The current Atlas order book and candles are derived from simulated Atlas trades. A polished demo
also needs recognizable real-world prices and charts. External market data must not silently become
matching, settlement, custody, or execution authority.

Free plans and provider limits change. This decision uses official documentation reviewed on
2026-08-31. A free allowance is a capacity constraint, not an availability or production guarantee.

## Decision Drivers

The initial hosted environment should:

1. have a zero-dollar recurring-cost ceiling and require no custom domain;
2. remain invitation-only even though its infrastructure uses public provider endpoints;
3. reuse the published Atlas application and PostgreSQL architecture;
4. preserve origin-side validation so the Render URL is not an access bypass;
5. support HTTP, WebSocket, and static React assets through one browser origin;
6. survive beyond Render's thirty-day free-database lifetime;
7. display real BTC-USD and ETH-USD reference prices and candles without API credentials;
8. keep all Atlas orders, balances, fills, and settlement explicitly simulated; and
9. stop instead of silently incurring cost when a free allowance is exhausted.

# Decision

Atlas will deploy an **invitation-only zero-cost demo** using:

```text
invited browser
      ↓ Cloudflare Access
Cloudflare Worker + static assets (*.workers.dev)
      ├── React application assets and runtime configuration
      ├── same-origin HTTP proxy ──────────────┐
      └── same-origin WebSocket proxy ─────────┤
                                                ↓
                                  Render Free API web service
                                                ↓ TLS
                                      Neon Free PostgreSQL 18

Render API ── read-only outbound feed ── Coinbase public market data WebSocket
```

No provider account may have paid overage enabled for this environment. If a provider requires a
paid plan, payment method, purchased domain, or paid add-on to satisfy the contract, deployment
stops and this ADR is reconsidered.

## 1. Environment and product boundary

The environment is `demo`, not `staging` or `production`.

- Access is limited to exact invited identities.
- All balances, deposits, withdrawals, orders, and trades remain simulated.
- External custody, fiat payments, broker connectivity, and order routing remain absent.
- The interface must continuously identify the environment as a simulation.
- Demo evidence cannot satisfy production readiness, availability, recovery, capacity, or
  regulatory controls.

The production-shaped staging decisions in ADRs 067–070 are superseded for initial hosting. They
remain historical design material if Atlas later adopts a non-zero budget.

## 2. Cloudflare Worker gateway

One Cloudflare Worker on its provider-owned `workers.dev` hostname is the only supported browser
entry point. It serves the immutable React build through Workers Static Assets, provides the
runtime API-origin document, and proxies Atlas HTTP and WebSocket traffic to the Render API.

Cloudflare Access protects the Worker **by Worker name**, so no purchased or Atlas-owned domain is
required. The application uses an exact-email allow policy and denies every other identity. The
Worker forwards the signed Access assertion to the API. It contains no Atlas, database, or market
data secret.

The browser uses the Worker origin for both assets and API/WebSocket requests. This avoids a
cross-site cookie/CORS deployment and keeps one visible demo URL.

## 3. Render Free API

Atlas deploys only the API image as one Render Free web service. The service:

- uses an immutable GHCR digest;
- accepts Render's injected `PORT`;
- runs exactly one instance;
- enables no persistent disk, autoscaling, private service, collector, or paid plan;
- validates the Cloudflare issuer and audience for protected HTTP and WebSocket traffic;
- keeps narrowly scoped health endpoints available to Render; and
- rejects direct requests that lack a valid Cloudflare assertion.

The free service may sleep after fifteen idle minutes, take about one minute to wake, restart, lose
ephemeral files, or be suspended after free allowances are exhausted. The UI must explain cold
starts instead of presenting them as an outage. Atlas will not use the Render Free PostgreSQL
offering because it expires after thirty days and has no backups.

## 4. Neon Free PostgreSQL

Neon Free supplies PostgreSQL 18 through an external TLS connection. Atlas keeps committed
migrations authoritative and uses the pooled connection string with its existing bounded
application pool. Migrations run deliberately from a controlled operator command before the API
digest is promoted; API startup still does not migrate.

The free plan's 0.5 GB storage, 100 CU-hours per month, scale-to-zero behavior, 5 GB transfer
allowance, and short restore window are accepted only for synthetic demo data. Atlas must monitor
those limits, retain no irreplaceable data, and export before destructive experiments. Exceeding a
free limit blocks or suspends the demo; it does not authorize an upgrade.

## 5. External reference market data

Coinbase Advanced Trade's public Market Data WebSocket is the initial reference source for Atlas's
existing `BTC-USD` and `ETH-USD` markets. Atlas uses unauthenticated public channels:

- `ticker_batch` for bounded five-second reference quotes;
- `candles` for five-minute OHLCV chart updates;
- `heartbeats` for connection liveness; and
- `level2` only if a later measured UI slice needs external depth.

The adapter is infrastructure inside Market Data. It validates every untrusted message, uses
bounded reconnect/backoff behavior, exposes source and freshness metadata, and never imports into
Trading or Financial application services.

External reference data cannot:

- match or price an Atlas order automatically;
- create a trade, journal, reservation, deposit, or withdrawal;
- alter Atlas's authoritative simulated order book or Market Data sequence;
- imply that an Atlas order exists on Coinbase; or
- require a Coinbase trading account or credential.

If the feed is unavailable or stale, the UI marks reference data unavailable. It never invents,
interpolates, or silently substitutes an Atlas simulated price.

## 6. Chart and interface contract

The trading workspace will show a professional light/gray candlestick chart and current reference
quote for the selected market. Every reference surface names `Coinbase`, its last update time, and
its stale/live state. Atlas's simulated book, user orders, fills, and balances remain visually
separate and carry a persistent `Simulation` label.

Chart data uses exact decimal strings at the contract boundary. Rendering may convert bounded
display-only values to browser numbers, but no resulting floating-point value becomes Financial or
Trading authority.

## 7. Email and demo identities

Render Free blocks outbound SMTP on common ports. Atlas will not weaken verification or log tokens
as a workaround. Before hosting identity flows, Atlas must either:

- select a zero-cost HTTPS email provider with a narrowly scoped secret; or
- add a controlled operator command that creates a bounded pre-verified demo identity and disables
  public registration/recovery in `demo`.

The second option is preferred for a one-user private demo because it creates no email-provider
dependency. Credentials and identity details remain outside Git and command history.

## 8. Observability and operations

The paid Render private collector is not deployed. The demo uses bounded structured provider logs,
health/readiness, build identity, and the existing protected metrics endpoint for operator-driven
diagnostics. Grafana Cloud can be reconsidered only if collection can remain within free allowances
without exposing metrics or running another paid service.

The zero-cost environment has no uptime, recovery, support, or latency objective. Cold starts,
free-tier suspension, and provider maintenance are accepted demo limitations. Production-readiness
controls remain `no-go`.

## 9. Promotion and cost guard

The demo deployment contract will be generated separately from ADR-070's paid Blueprint. It must
fix the API image digest, Worker source revision, allowed Cloudflare audience, Neon schema version,
and zero-dollar ceiling. It must not contain credentials or database URLs.

Account setup and resource creation remain explicit external actions. Before any provider action,
confirm that:

- the selected plan displays `$0`;
- paid overage is disabled or no payment method is attached;
- no custom domain or paid service is selected; and
- exhausting an allowance suspends service rather than billing.

## Alternatives Considered

### Keep the paid Render staging topology

Rejected for initial hosting because its fixed recurring cost conflicts with the user's explicit
zero-cost requirement.

### Render Static Site + Render Free API directly

Rejected as the access topology because two public Render origins would lose the accepted
invitation-only edge and same-origin browser boundary. The Worker gateway adds both within a free
allowance.

### Render Free PostgreSQL

Rejected because it expires after thirty days, has no backups, and would make the demo disposable
on a provider schedule rather than Atlas's schedule.

### Browser connects directly to Coinbase

Rejected because schema validation, source health, reconnect policy, provider substitution, and
truthful normalization belong at an Atlas-controlled boundary rather than in every browser.

### Use Coinbase prices for Atlas matching

Rejected because reference data is not execution authority. Doing so would misrepresent simulated
liquidity and couple Financial settlement to an external feed.

## Consequences

### Positive

- The accepted recurring-cost ceiling is zero dollars.
- No domain purchase, registry credential, or Coinbase key is required.
- The browser sees one Access-protected origin for assets, HTTP, and WebSocket.
- PostgreSQL data does not expire after thirty days.
- Real reference prices and charts improve the demonstration without changing simulated execution.

### Negative

- Render cold starts can take about a minute.
- The free database and compute allowances are small and unsuitable for sustained use.
- Free endpoints and policies can change or disappear.
- The Worker gateway and external feed add new adapters and failure states.
- The environment cannot provide production-grade recovery, availability, or monitoring evidence.

## Reconsider When

Review this decision when any required free plan is withdrawn, limits repeatedly suspend the demo,
the application exceeds 0.5 GB of database storage, more than a few invited reviewers need reliable
access, Coinbase terms or channel behavior changes, cold starts materially harm demonstrations, or
Atlas receives an explicitly approved non-zero hosting budget.

## External References

- [Render free-service limitations](https://render.com/docs/free)
- [Render prebuilt-image deployment](https://render.com/docs/deploying-an-image)
- [Neon pricing and Free limits](https://neon.com/pricing)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/)
- [Coinbase public WebSocket channels](https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels)

## Related Decisions

- [ADR-030 — Market Data Projection and Sequencing Foundation](ADR-030-market-data-projection-and-sequencing-foundation.md)
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
- [ADR-067 — Initial Staging Platform and Managed PostgreSQL Provider](ADR-067-initial-staging-platform-and-managed-postgresql-provider.md)
- [ADR-068 — Staging Domain and Access-Control Boundary](ADR-068-staging-domain-and-access-control-boundary.md)
- [ADR-069 — Staging Observability Collection, Alerting, and Availability](ADR-069-staging-observability-collection-alerting-and-availability.md)
- [ADR-070 — Render Staging Blueprint Generation and Promotion](ADR-070-render-staging-blueprint-generation-and-promotion.md)
- [ADR-073 — Initial Product Scope Approval and Evidence](ADR-073-initial-product-scope-approval-and-evidence.md)
