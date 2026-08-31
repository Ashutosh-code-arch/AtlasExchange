# ADR-067 — Initial Staging Platform and Managed PostgreSQL Provider

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-31  
**Last reviewed:** 2026-08-31  
**Canonical owner/source:** ADR-067

## Context

ADR-063 defines a portable deployment topology but deliberately leaves the runtime and database
provider unselected. ADR-066 now requires environment-specific evidence before traffic, so Atlas
needs a real staging target on which to prove ingress behavior, runtime configuration, recovery,
capacity, observability, security, and release promotion.

Atlas is operated by one developer. The first environment should teach production operations without
immediately requiring a Kubernetes cluster, cloud network design, registry mirroring, or a collection
of separately billed control-plane products. It must still preserve the accepted image, migration,
database, WebSocket, privacy, and recovery boundaries.

Provider features and prices change. This decision uses documentation reviewed on 2026-08-31 and
selects a staging provider only. No account, domain, paid resource, secret, or deployment is created
by accepting this ADR.

## Decision Drivers

The initial staging platform should:

1. run the already-built API and web images by immutable digest;
2. support Node HTTP and long-lived WebSocket connections;
3. provide managed TLS, custom domains, health-gated deploys, and graceful shutdown;
4. keep PostgreSQL 18 traffic on a private network and block public database access;
5. provide isolated point-in-time recovery with at least a seven-day window;
6. support a separate migration command and one API replica;
7. expose enough runtime/database telemetry for Atlas's operational controls;
8. offer a Singapore region close to the initial developer/operator;
9. keep configuration reviewable and future migration possible; and
10. avoid spending or public exposure before explicit user approval.

# Decision

Atlas selects **Render for its initial production-shaped staging environment**, subject to the
pre-provisioning blockers in this decision.

This is not a production-provider commitment. Production must reconsider the choice using measured
staging cost, reliability, restore, support, capacity, and operational evidence.

## 1. Staging topology

The intended Render project is:

```text
public browser
      ↓ HTTPS + access boundary
Render managed edge
      ├── atlas-web-staging  (one image-backed web service)
      └── atlas-api-staging  (one image-backed web service, HTTP + WebSocket)
                                      ↓ private connection only
                              atlas-postgres-staging

private collector service → API /internal/metrics → external telemetry store
```

All resources use Render's Singapore region. Web and API remain separate deployable services. The
web service is not a Render static site because Atlas injects its public API origin at container
startup and promotes one unchanged image between environments.

The API remains exactly one instance. Render does not change Atlas's current process-local rate
limits, embedded projection leadership, WebSocket ownership, or aggregate database-connection
assumptions.

## 2. Initial resource envelope

The first measured staging envelope is:

| Resource | Render plan | Instances/storage | Reason |
|---|---|---:|---|
| API web service | `1c-2g` | 1 | Leaves observable headroom for Node, Argon2, projections, and WebSockets |
| Web service | `0.5c-512mb` | 1 | Serves immutable assets and runtime configuration only |
| Render Postgres | `0.5c-1g` | 15 GB | Small paid PostgreSQL 18 baseline with recovery support |

These are capacity hypotheses, not production sizing. Staging load evidence may reduce or increase
them. Autoscaling remains disabled. PostgreSQL uses no platform connection pool initially because
Atlas owns transaction/session behavior through Kysely and `pg`; application pool capacity remains
ten connections for the single API replica until measurements justify a change.

Before creating resources, the operator must review Render's live estimate, set an account spending
alert where available, and explicitly approve the monthly ceiling. This ADR does not authorize a
purchase.

## 3. Workspace and recovery plan

The staging workspace must provide Render's seven-day PITR window, which currently requires a Pro
workspace or higher. A Hobby workspace's three-day window does not satisfy ADR-064's minimum
seven-day PITR requirement.

The paid PostgreSQL instance uses PostgreSQL major version 18, encrypted provider storage, continuous
provider backups, and an empty public IP allow-list. The API receives the internal connection string.
A pre-traffic drill must restore PITR to a new database, run Atlas's recovery validator, and measure
the accepted five-minute RPO and sixty-minute RTO objectives. A separate encrypted portable logical
archive with 35 daily recovery points remains required; Render PITR alone is insufficient.

No high-availability standby is purchased for initial staging. Production availability, failover,
and support evidence may require a different plan or provider.

## 4. Release artifact and migration authority

Render services use `runtime: image` and pull the GHCR API/web artifacts published by ADR-063. The
deployment reference is the exact multi-platform digest, never `latest`, a branch, or a mutable
semantic tag. Render currently executes Linux AMD64 from the published index.

If Atlas source and release artifacts are intentionally public, the GHCR runtime packages may also be
public so staging needs no long-lived registry pull credential. Package visibility must be reviewed
before deployment. If the images stay private, only a read-only pull credential may be stored in
Render, and its rotation must satisfy ADR-065 and ADR-066.

Source-backed Render builds and automatic deploy-on-push are prohibited. A GitHub Release publishes
artifacts; an explicit promotion supplies the reviewed digest. The API image's compiled migration
entry point runs once as the pre-deploy command before the new API instance can receive traffic.
Ordinary API startup still never migrates.

## 5. HTTP, port, and health boundary

Render injects `PORT`. Atlas API now treats that platform value as authoritative when present while
retaining `API_PORT` for local and explicitly configured runtimes. The API container health check
uses the same effective port. The web runtime already follows this contract.

Render gates API deployment on `/health/ready` and web deployment on `/health/live`. API readiness
checks the database and expected schema. Liveness remains process-only. Platform health gating does
not replace continuous external availability monitoring.

The API and browser continue to use HTTPS origins under the same Atlas-controlled registrable site,
for example `app.staging.<owned-domain>` and `api.staging.<owned-domain>`. The exact domain is an
external input and must not be invented in source. After custom domains work, the default
`onrender.com` service subdomains must be disabled so the reviewed ingress and access boundary cannot
be bypassed.

## 6. Proxy and staging-access blockers

The Render container port is not directly reachable from the public internet, but the exact
forwarded-address chain is not sufficiently specified by the reviewed public documentation to treat
`HTTP_TRUST_PROXY_HOPS=1` as proven. Before Atlas accepts traffic, a controlled staging test must
establish that:

- every possible request path traverses exactly the trusted Render edge;
- direct container bypass is impossible;
- Render overwrites or safely appends forwarded identity; and
- Express derives the expected peer when hostile forwarding headers are supplied.

If that test fails, Atlas must change to an explicit trusted-network or provider-authenticated edge
identity policy before deployment. The hop count must not be increased until a request appears to
work.

Staging must also have an access boundary before custom domains become reachable. A reviewed edge
identity product, allow-list, or application-independent access proxy must protect both web and API
without placing a reusable secret in browser source. The access provider is a separate decision.
Unprotected staging is a `no-go`, even when it contains only synthetic data.

## 7. Configuration and secrets

Non-secret environment configuration will be generated from a reviewed, versioned deployment
manifest in the next slice. Secret values are entered only through Render environment/secret-file
facilities and are never committed, printed by deployment tooling, or embedded in images.

Required staging secret material includes:

- CSRF HMAC key;
- dedicated metrics bearer token;
- SMTP credential when the selected provider requires authentication;
- registry pull credential only if images remain private; and
- the managed password-blocklist file when it is not packaged as a reviewed public resource.

The database internal connection string is a provider reference, not a copied source value. Simulated
funding and withdrawals remain disabled. Enabling them for a bounded staging exercise requires an
explicit temporary configuration decision and synthetic identities only.

## 8. Observability and alerts

Render's built-in service/database metrics and failure notifications are useful platform signals,
but they do not collect Atlas's protected application metrics or prove alert delivery. ADR-069 now
selects one image-backed private Grafana Alloy service that scrapes `/internal/metrics` over Render's
private network and forwards bounded telemetry to Grafana Cloud.

The staging go/no-go remains blocked until platform and application signals have retention,
dashboards, actionable thresholds, and a tested delivery path. Render's continuing routing/restart
health checks are useful platform signals, but they do not replace an external availability probe or
Atlas application alerts.

## 9. Infrastructure ownership and drift

Render Blueprint infrastructure is selected for the stable staging resource topology. The committed
manifest will define service types, region, plans, instance counts, health paths, PostgreSQL major,
storage, private database policy, and non-secret configuration. Release-specific image digests will
be supplied by controlled generation rather than hand-edited mutable tags.

Secrets, domain verification, access-provider configuration, registry visibility, notification
destinations, and provider-generated identifiers remain controlled external state. The runbook must
reconcile those fields against the committed contract. Dashboard convenience changes do not become
architecture until represented in source or recorded as an approved exception.

No Blueprint is added in this slice because an exact owned domain, staging access boundary, live
cost approval, registry visibility, and Render account/project identity do not exist yet. Committing
a deployable manifest with invented values would create false confidence and an unsafe public path.

## Alternatives Considered

### Railway

Railway is the strongest alternative. It offers Singapore compute, environment-scoped private
networking, injected ports, custom domains, sealed variables, usage controls, and roughly four weeks
of PostgreSQL PITR. It was not selected for the first staging target because its PostgreSQL remains a
service assembled from an image, volume, bucket, and pgBackRest rather than the more integrated
managed database boundary Atlas wants to learn first. Its project-level TypeScript infrastructure
model is also new while the older config-as-code mechanism is being retired in December 2026.

Reconsider Railway if Render's measured cost, registry workflow, proxy behavior, or staging-access
options are poor.

### Fly.io

Fly offers strong private networking, global machines, and managed PostgreSQL with backup and high
availability. Rejected initially because its managed service currently targets PostgreSQL 16 rather
than Atlas's accepted PostgreSQL 18 baseline, and its documentation still lists customer-facing
alerting and security patch/version upgrades as unfinished capabilities.

### Cloud Run with Cloud SQL

This is a credible production alternative with strong identity, secret, database, monitoring, and
network controls. Rejected for the first staging environment because it introduces Artifact Registry
mirroring, IAM/service accounts, Cloud SQL connectivity, load-balancer/domain configuration, and a
larger infrastructure surface before Atlas has deployed once. Cloud Run WebSocket request lifetime
and multi-instance behavior also require more platform-specific tuning.

### VPS with Docker Compose

Rejected because one inexpensive server would make the solo developer responsible for host patching,
database operations, encrypted backup automation, failover, TLS, ingress, and monitoring. It would
not satisfy the managed-database learning boundary.

## Consequences

### Positive Consequences

- Atlas gets one coherent staging control plane without changing application architecture.
- The existing digest, migration, health, WebSocket, PostgreSQL 18, and recovery contracts fit.
- Singapore reduces operator-to-staging latency.
- The provider can be replaced because application images and logical backups remain portable.
- Paid resource creation and public exposure remain explicit user decisions.

### Negative Consequences

- A Pro workspace plus three paid resources creates meaningful recurring cost.
- Render becomes an operational dependency before production is selected.
- The public edge's forwarding semantics still require empirical proof.
- Staging access protection and custom domains need at least one additional provider/configuration.
- A seven-day provider PITR window meets only Atlas's minimum and portable retention remains separate.
- One API and one database instance do not provide staging high availability.

## Reconsider When

Review this decision when the proxy test fails, estimated cost exceeds the approved ceiling, Render
cannot pull/roll back candidate digests safely, PostgreSQL recovery misses RPO/RTO, monitoring cannot
reach the private API, the access boundary can be bypassed, Singapore is unsuitable, production
requires high availability, or another provider materially reduces operational risk.

## External References

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render prebuilt image deployment](https://render.com/docs/deploying-an-image)
- [Render web service port boundary](https://render.com/docs/web-services)
- [Render health checks](https://render.com/docs/health-checks)
- [Render WebSockets](https://render.com/docs/websocket)
- [Render private networking](https://render.com/docs/private-network)
- [Render PostgreSQL recovery and backups](https://render.com/docs/postgresql-backups)
- [Render compute plans](https://render.com/docs/compute-plans)
- [Render custom domains](https://render.com/docs/custom-domains)
- [Railway PostgreSQL backup and restore](https://docs.railway.com/guides/postgres-backups-restores)
- [Fly.io Managed Postgres](https://fly.io/docs/mpg/)
- [Cloud Run WebSockets](https://cloud.google.com/run/docs/triggering/websockets)

## Related Decisions

- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
- [ADR-058 — Application Metrics and Protected Scrape Boundary](ADR-058-application-metrics-and-protected-scrape-boundary.md)
- [ADR-060 — PostgreSQL Runtime Capacity, Timeout, and Saturation Policy](ADR-060-postgresql-runtime-capacity-timeout-and-saturation-policy.md)
- [ADR-062 — Production Application Packaging and Runtime Web Configuration](ADR-062-production-application-packaging-and-runtime-web-configuration.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-064 — PostgreSQL Backup, Restore, and Recovery Validation](ADR-064-postgresql-backup-restore-and-recovery-validation.md)
- [ADR-065 — Software Supply-Chain, Vulnerability, and Secret Response](ADR-065-software-supply-chain-vulnerability-and-secret-response.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
