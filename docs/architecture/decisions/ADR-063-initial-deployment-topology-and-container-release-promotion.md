# ADR-063 — Initial Deployment Topology and Container Release Promotion

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-063

## Context

ADR-062 produces separate API and web images, but producing a local image is not a release or a
deployable topology. Atlas still needs to decide how public traffic reaches those images, when
forwarded client identity is trustworthy, which current single-process assumptions constrain
replicas, how image identity is tied to source, and how one verified artifact moves between
environments.

Atlas is maintained by one developer and has no selected production compute, ingress, database, or
secret-manager vendor. The decision must create a safe portable contract without pretending that a
cloud account, domain, backup system, or operating team already exists.

## Decision Drivers

The initial deployment and release boundary should:

1. preserve secure cookie, CORS, CSRF, and same-site assumptions;
2. derive client network identity only through a bounded trusted ingress;
3. acknowledge process-local limiting, WebSockets, and embedded projection ownership;
4. keep the API container unreachable directly from the public internet;
5. publish one source-identifiable API/web release pair;
6. support Linux AMD64 and ARM64 without per-platform release versions;
7. publish SBOM and provenance without long-lived registry credentials;
8. promote and roll back by immutable digest rather than mutable tags; and
9. defer runtime-vendor and production-database selection until their requirements are explicit.

# Decision

Atlas adopts a vendor-neutral initial topology and GitHub Container Registry release boundary.

```text
public internet
      ↓ HTTPS
managed ingress (exactly one trusted hop)
      ├── web image deployment
      └── API image deployment (private ingress reachability only)
                    ↓ private encrypted connection
             managed PostgreSQL primary

external SMTP provider ← API
protected metrics scraper → API /internal/metrics
```

## 1. Public origin and ingress topology

Web and API use distinct HTTPS origins under the same registrable site, conceptually:

```text
https://app.atlas.example
https://api.atlas.example
```

The exact domains are deployment configuration, not source constants. Same-site placement preserves
the accepted secure host-cookie and cross-origin CSRF model. `WEB_ORIGIN` is the exact HTTPS web
origin; `ATLAS_WEB_API_BASE_URL` is the exact public HTTPS API base.

The initial API network path contains exactly one managed TLS ingress hop. The API has no direct
public route. Staging and production set `HTTP_TRUST_PROXY_HOPS=1`, allowing Express to use the
client address supplied across that hop for process-resource limiting. Local/test defaults remain
zero and distrust forwarded headers.

Configuration accepts at most three fixed hops for future reviewed topologies. The number must equal
every possible network path. Atlas never uses blanket proxy trust. If a future platform has variable
paths or cannot prevent direct access, this hop-count policy is invalid and must be replaced by
explicit trusted networks or a signed edge-identity mechanism.

Forwarded identity remains irrelevant to authentication, authorization, ownership, financial
accounting, and audit attribution.

## 2. Initial replica topology

The initial production-like topology runs:

- one or more stateless web replicas;
- exactly one API replica containing HTTP, WebSocket, and Market Data projection loops; and
- one managed PostgreSQL primary sized for that API pool plus migration/operational connections.

One API replica is deliberate. Admission and module limiters are process-local; WebSocket connection
limits are process-local; every API replica would start projection loops and contend for advisory
locks. Multiple replicas would therefore change effective limits and operational behavior even
though PostgreSQL preserves domain correctness.

Horizontal API scaling requires a later decision covering distributed admission, aggregate database
connections, projection leadership or separation, WebSocket routing/fan-out, deployment concurrency,
and observability aggregation. Until then, availability comes from platform restart and health
routing, not concurrent API replicas.

## 3. Registry and release event

GitHub Container Registry (`ghcr.io`) is selected because Atlas source and CI already live on GitHub,
and `GITHUB_TOKEN` can publish packages without a long-lived third-party credential.

Publication occurs only when a non-prerelease GitHub Release is published. Its tag must:

- match exact stable `vMAJOR.MINOR.PATCH` syntax;
- contain no prerelease suffix;
- equal the root `package.json` version after removing `v`; and
- resolve to a commit reachable from `origin/main`.

The release workflow repeats frozen dependency installation, migrations, the complete non-E2E
verification contract, and production artifact builds before publication. A GitHub Release is a
deliberate publication action; branch pushes and pull requests never receive registry write
permission.

## 4. Image names, platforms, and immutable identity

Every release publishes:

```text
ghcr.io/<owner>/atlas-api:<version>
ghcr.io/<owner>/atlas-api:sha-<full-commit>
ghcr.io/<owner>/atlas-web:<version>
ghcr.io/<owner>/atlas-web:sha-<full-commit>
```

Each tag points to one multi-platform index containing Linux AMD64 and ARM64 images. Atlas does not
publish `latest`; its meaning is mutable and provides no release intent.

Dockerfiles accept and attach OCI source URL, semantic version, full source revision, and creation
time. Creation uses the source commit timestamp, making metadata stable for the same release source.
The API also receives that semantic version as `ATLAS_APPLICATION_VERSION` for logs and metrics.
Local builds use the root version with a `local` suffix and visibly add `dirty` when the build
context differs from `HEAD`.

## 5. SBOM, provenance, and action authority

BuildKit publishes an SBOM and maximum-mode provenance with each multi-platform image. GitHub's
attestation action additionally creates short-lived OIDC/Sigstore-signed provenance bound to the
published image digest and pushes it to GHCR.

Every third-party action is pinned to a full commit SHA with a readable version comment. The publish
job alone receives:

```text
contents: read
packages: write
id-token: write
attestations: write
```

No cloud runtime credential, production secret, database credential, or private signing key enters
the image build. Provenance establishes where an image came from; it does not prove that the
application is defect-free or that its dependencies contain no vulnerability.

## 6. Promotion and deployment contract

Tags aid discovery, but deployment resolves and records the immutable multi-platform digest. The
same API and web digests are promoted through staging and production; environment configuration and
secrets are injected at runtime. Images are never rebuilt merely to change an endpoint or secret.

A release record must preserve:

- semantic release version and source commit;
- API and web image digests;
- migration result and schema version;
- target environment and deployment time; and
- previous known-good digests.

The runtime platform and release-record store remain deferred, so the repository publishes images
but performs no automatic staging or production deployment in this slice.

## 7. Migration, rollout, and rollback ordering

The generic rollout order is:

1. resolve and verify both release digests and provenance;
2. confirm database recovery prerequisites and capacity;
3. run the API image's compiled migration entry point once as a controlled job;
4. start the API digest with traffic disabled;
5. require liveness and readiness before enabling ingress traffic;
6. start the web digest with the target public API URL; and
7. run bounded smoke checks for health, session, and public Market Data.

API startup never migrates. A failed application rollout returns traffic to the previous known-good
digest only when the forward schema remains compatible. Applied migrations are never edited or
automatically reversed. An incompatible database change requires a corrective forward migration and
an explicit recovery decision.

Web and API may roll back independently only when their public contracts remain compatible. The
release record still treats their source version and digests as one reviewed pair.

## 8. Production prerequisites not satisfied here

Publishing images does not declare Atlas ready for real money or public customers. Before production
traffic, Atlas still requires a selected runtime and database, tested backup/restore, secret storage
and rotation, DNS/certificate ownership, monitoring collection and alerting, capacity validation,
vulnerability response, and operational runbooks.

Simulated funding and withdrawals remain off by default in managed environments. This topology does
not introduce real custody, external market connectivity, or regulatory readiness.

## Alternatives Considered

### Publish on every `main` push

Rejected because ordinary integration commits are not release intent and would create a noisy
package history with write authority on every merge.

### Publish `latest`

Rejected because it is mutable, ambiguous, and encourages deployments that cannot identify or
reproduce their source.

### Deploy automatically when a GitHub Release is published

Rejected until the runtime platform, environment approval, secret manager, database recovery, and
rollback mechanisms are selected.

### Begin with multiple API replicas

Rejected because process-local limiting, projection loops, WebSocket ownership, and aggregate pool
capacity do not yet have a coordinated multi-replica contract.

### Trust every proxy

Rejected because public bypass or a forged forwarding chain could create arbitrary client identities
and evade process controls.

### Publish only the runner's AMD64 image

Rejected because the accepted Node base and Atlas native dependencies support both common Linux
architectures, while a single multi-platform release keeps deployment choice open.

## Consequences

### Positive Consequences

- The initial edge path and forwarded-identity authority are explicit and tested.
- Release images are tied to stable version, source commit, and commit timestamp.
- API and web support AMD64 and ARM64 under one immutable digest each.
- Registry publication uses short-lived repository authority and pinned actions.
- SBOM and signed provenance are available before a runtime vendor is selected.
- Deployment can promote the same bytes and roll back to recorded digests.

### Negative Consequences

- One API replica limits availability and horizontal throughput.
- Multi-platform builds use QEMU and consume more release time.
- GHCR becomes a release dependency even though compute hosting remains portable.
- Release verification repeats work already performed by the main quality workflow.
- Numeric proxy-hop trust depends on deployment network invariants outside application code.
- No automated deployment or rollback exists yet.

## Reconsider When

Review this decision when Atlas selects a runtime platform, adds a CDN or second ingress hop, cannot
guarantee private API reachability, requires preview origins, needs API horizontal scaling, separates
projection or WebSocket processes, changes registry, adopts prereleases, requires key-managed
signatures, or adds automated staging/production deployment.

## Related Decisions

- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-016 — Continuous Integration and Quality Gate Strategy](ADR-016-continuous-integration-and-quality-gate-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-033 — Market Data Projection Worker Lifecycle and Lag Observability](ADR-033-market-data-projection-worker-lifecycle-and-lag-observability.md)
- [ADR-042 — Realtime Market Data WebSocket Protocol and Server Delivery](ADR-042-realtime-market-data-websocket-protocol-and-server-delivery.md)
- [ADR-056 — Production HTTP Edge Security and Resource Boundary](ADR-056-production-http-edge-security-and-resource-boundary.md)
- [ADR-057 — API Admission Rate Limiting and Abuse Protection](ADR-057-api-admission-rate-limiting-and-abuse-protection.md)
- [ADR-060 — PostgreSQL Runtime Capacity, Timeout, and Saturation Policy](ADR-060-postgresql-runtime-capacity-timeout-and-saturation-policy.md)
- [ADR-062 — Production Application Packaging and Runtime Web Configuration](ADR-062-production-application-packaging-and-runtime-web-configuration.md)
