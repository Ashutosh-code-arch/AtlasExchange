# ADR-070 — Render Staging Blueprint Generation and Promotion

**Classification:** Canonical

**Status:** Superseded by ADR-075

**Date:** 2026-08-31

**Last reviewed:** 2026-08-31

**Canonical owner/source:** ADR-070

ADR-075 replaces this paid Render project Blueprint with a separate zero-cost demo deployment
contract. The generator remains historical, tested infrastructure and must not be applied to the
initial demo.

## Context

ADR-067 selects Render and defines the intended staging topology, but correctly refuses to commit a
deployable Blueprint containing invented domains, credentials, costs, or release artifacts. ADR-068
and ADR-069 now define the Cloudflare Access and Grafana Cloud boundaries. Atlas therefore needs a
repeatable way to turn exact external inputs and one reviewed candidate release into a deployment
contract without weakening those blockers.

A handwritten generic `render.yaml` would either contain placeholders that can accidentally be
deployed or leave security-critical fields to dashboard interpretation. A release-specific manifest
also cannot be committed permanently with mutable tags or reused for another candidate.

Accepting this decision creates no Render resource, domain, credential, account, deployment, or
recurring cost.

## Decision Drivers

The staging deployment contract should:

1. fail closed when an external value or prerequisite is missing, stale, malformed, or invented;
2. bind API, web, and collector services to immutable digests from one readiness record;
3. preserve fixed resource, network, health, migration, and database boundaries in reviewable code;
4. keep every secret value outside the generator inputs, output, Git, and logs;
5. support public or least-authority private registry access explicitly;
6. produce deterministic YAML that can be reviewed and validated before provider mutation;
7. require fresh live-cost approval instead of treating an ADR estimate as purchasing authority; and
8. keep generation, validation, provider application, staging readiness, and production approval as
   separate actions.

# Decision

Atlas will generate a **release-specific Render Blueprint** with the deterministic, fail-closed
generator in `scripts/deployment/generate-render-blueprint.mjs`.

No generated `render.yaml` is committed now. Generation is blocked until the exact external input,
fresh candidate readiness evidence, and a current cost approval exist. The generator is deployment
infrastructure; its output is a promotion artifact.

## 1. Input and evidence boundary

The operator supplies one JSON document conforming to
`infra/render/staging-input.schema.json`. It contains only exact non-secret deployment facts:

- Atlas-owned registrable, web, and API domains;
- Cloudflare Access team domain and application audience;
- Grafana Cloud remote-write URL and metrics username;
- SMTP transport and sender metadata;
- public-registry selection or the name of an existing read-only Render registry credential; and
- a USD monthly ceiling approved by a named operator for no more than thirty days.

Reserved example, provider-default, cross-site, placeholder, credential-bearing, and unknown values
are rejected. The generator separately validates a staging readiness record and requires fresh
passed evidence for runtime/database selection, candidate vulnerability scanning, and release
provenance. All three image digests, the release version, and the source revision come only from that
validated record.

The cost approval gates generation but is not rendered into the Blueprint. Provider pricing must
still be reconciled in Render immediately before application.

## 2. Fixed Blueprint topology

The generated project contains one protected and network-isolated `staging` environment in
Singapore:

| Resource | Type | Fixed plan | Count/storage |
|---|---|---|---:|
| `atlas-api-staging` | image-backed web service | `1c-2g` | 1 |
| `atlas-web-staging` | image-backed web service | `0.5c-512mb` | 1 |
| `atlas-metrics-collector-staging` | image-backed private service | `0.5c-512mb` | 1 |
| `atlas-postgres-staging` | PostgreSQL 18 | `0.5c-1g` | 15 GB |

Autoscaling is disabled. The database has no public IP allow-list and no platform connection pool.
The API uses the internal database reference, runs the compiled migration command once as a
pre-deploy step, and gates on `/health/ready`. The web gates on `/health/live`. Render private
services support TCP rather than HTTP path health checks, so the collector uses Render's private
service TCP health behavior on its listening port.

The web and API receive exact custom domains and disable their default Render subdomains. The
collector receives the API private `hostport` reference and has no public route. Automatic source
builds, preview environments, mutable image tags, and deploy-on-push are not part of the Blueprint.

## 3. Secret and registry boundary

Secret values never enter the input document or generated YAML.

- Render generates the dedicated metrics bearer token. The operator enters the API's required
  Base64URL CSRF HMAC key as a secure initial-sync value because Render-generated secrets use padded
  standard Base64.
- The collector references the generated API metrics variable through Render's service reference.
- SMTP credentials and the Grafana metrics-write token are declared `sync: false` for secure entry at
  initial Blueprint application.
- Public images require no registry credential. Private images name one pre-existing, rotatable,
  read-only Render registry credential; the credential value remains external state.
- The managed password-blocklist secret file remains a deliberate manual activation prerequisite.

The generator writes a new output file with owner-only permissions, refuses to overwrite inputs or
an existing output, and logs only the event, output path, source revision, and version.

## 4. Promotion sequence

The accepted sequence is:

1. produce the exact input and fresh readiness record;
2. verify the live Render estimate is below the unexpired approved ceiling;
3. generate a new Blueprint with `pnpm staging:render:generate`;
4. review the complete YAML and its source candidate;
5. validate it with the current Render CLI and target workspace;
6. deliberately commit or otherwise preserve the reviewed release-specific manifest;
7. obtain explicit authority before applying provider changes or accepting recurring cost;
8. enter external secret values, upload the password blocklist, and execute the runbook; and
9. collect provider evidence and evaluate staging readiness independently.

Generation success does not mean the Blueprint has been applied. Blueprint validation does not mean
the application is ready. A healthy staging environment does not approve production.

## 5. Drift and change ownership

Stable topology changes belong in the generator, schema, ADR, and tests. Release or environment
facts belong in the exact input/readiness evidence. Secret values, provider identifiers, domain
verification, notification destinations, Access policies, and provider-generated state remain
external and must be reconciled against the reviewed manifest in the runbook.

Dashboard edits that differ from the generated contract are drift, not an architectural change.
Correct the provider state or accept a reviewed source change; do not silently update the generator
to match an unexplained dashboard mutation.

## Alternatives Considered

### Commit a placeholder Blueprint

Rejected because placeholder domains, digests, or credentials can produce an apparently deployable
but unsafe public environment.

### Use mutable tags in one permanent Blueprint

Rejected because the provider would no longer prove which scanned, attested release was promoted.

### Configure Render only through its dashboard

Rejected because security, resource, migration, and configuration drift would not be reviewable or
reproducible.

### Provision directly through the Render API

Rejected initially because a Blueprint provides a smaller, provider-supported review surface. A
direct API/IaC client can be reconsidered when Blueprint limitations become measurable.

### Put secret values in the template or input JSON

Rejected because promotion artifacts, logs, reviews, and source history are not secret stores.

## Consequences

### Positive Consequences

- One command converts reviewed external facts and release evidence into deterministic infrastructure.
- Immutable candidate identity and fixed topology are enforced rather than remembered.
- Missing prerequisites and unexpected fields fail closed before provider mutation.
- Secret material remains outside Git and ordinary generator output.
- Public and private registry choices remain explicit and independently rotatable.

### Negative Consequences

- Every promoted release produces another manifest that must be reviewed and preserved.
- Initial secret entry, blocklist upload, domain verification, and provider evidence remain manual.
- Render CLI validation requires current provider tooling and target-workspace access.
- Stable topology changes require coordinated generator, schema, test, and documentation updates.

## Reconsider When

Review this decision when Render cannot validate or safely apply the generated contract, Blueprint
service references cannot preserve the secret boundary, provider drift becomes frequent, multiple
environments require composition, the fixed plans change materially, or a mature IaC provider gives
Atlas a more reliable preview/apply/state workflow.

## External References

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render Blueprint validation](https://render.com/docs/cli-reference)
- [Render health checks](https://render.com/docs/health-checks)
- [Render prebuilt image deployment](https://render.com/docs/deploying-an-image)
- [Render custom domains](https://render.com/docs/custom-domains)

## Related Decisions

- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-058 — Application Metrics and Protected Scrape Boundary](ADR-058-application-metrics-and-protected-scrape-boundary.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-065 — Software Supply-Chain, Vulnerability, and Secret Response](ADR-065-software-supply-chain-vulnerability-and-secret-response.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
- [ADR-067 — Initial Staging Platform and Managed PostgreSQL Provider](ADR-067-initial-staging-platform-and-managed-postgresql-provider.md)
- [ADR-068 — Staging Domain and Access-Control Boundary](ADR-068-staging-domain-and-access-control-boundary.md)
- [ADR-069 — Staging Observability Collection, Alerting, and Availability](ADR-069-staging-observability-collection-alerting-and-availability.md)
