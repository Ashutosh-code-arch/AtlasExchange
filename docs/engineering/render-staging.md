# Atlas Render Staging Runbook

**Classification:** Canonical  
**Status:** Archived
**Last reviewed:** 2026-08-31

This historical runbook implements the superseded ADR-067 provider-selection boundary. ADR-075 and
the zero-cost demo runbook now govern initial hosting. No Render account or resource is
currently configured by this repository. Do not provision from this document until every blocker
below is resolved and the user explicitly approves the live cost.

## Current state

```text
Provider selected for staging: Render
Account/project created:         no evidence
Recurring cost approved:         no
Owned staging domains:           not supplied
Staging access boundary:         Cloudflare Access selected; not configured
Proxy chain:                     not verified
GHCR visibility/pull authority:  public anonymous digest pulls verified
Candidate release:               v0.1.1 published and provenance verified
Deployment manifest generator:   implemented; exact output blocked
Private metrics collector:       selected and implemented; not deployed
Grafana Cloud destination:        selected; no stack evidence
Production approval:             no-go
```

## Pre-provisioning blockers

- [ ] Record the Render workspace and project owner.
- [ ] Review the current Pro workspace and resource estimate in Render's billing UI.
- [ ] Set and record the approved monthly ceiling and billing alert.
- [ ] Supply a schema-valid exact staging input document and unexpired cost approval.
- [ ] Supply an Atlas-controlled registrable domain and choose exact staging web/API hostnames.
- [x] Select an access boundary protecting both staging origins without a browser-embedded secret.
- [ ] Supply the exact Cloudflare team domain, multi-domain application audience, and approved email
      allow-list required by ADR-068.
- [ ] Create separate bounded Cloudflare service identities for continuous availability and ADR-071
      release smoke execution.
- [x] Confirm all three `v0.1.1` GHCR packages accept anonymous digest pulls; use public registry
      configuration without a Render registry credential.
- [ ] Confirm the SMTP provider and staging sender identity.
- [ ] Prepare a production-grade offline password-blocklist file.
- [x] Define the private metrics collector and external retention destination.
- [ ] Obtain an authoritative answer or controlled test plan for Render forwarding semantics.

Do not create placeholder public services merely to discover their URLs. Domain, CORS, secure-cookie,
CSRF, access, and proxy behavior are one reviewed boundary.

## Intended resource contract

All resources belong to one Render staging project in `singapore`:

| Name | Type | Plan | Count/storage |
|---|---|---|---:|
| `atlas-api-staging` | Image-backed web service | `1c-2g` | 1 instance |
| `atlas-web-staging` | Image-backed web service | `0.5c-512mb` | 1 instance |
| `atlas-metrics-collector-staging` | Image-backed private service | `0.5c-512mb` | 1 instance |
| `atlas-postgres-staging` | Render Postgres 18 | `0.5c-1g` | 15 GB |

Autoscaling is disabled. Database public access uses an empty allow-list. Services consume the
database's internal connection string. API, web, and collector images use exact GHCR digests from
the same release record. The collector has no public route. These fixed plans remain cost hypotheses;
the current Render estimate must fit the unexpired approved ceiling before generation or application.

## Intended non-secret API configuration

The generated Blueprint will set or reference:

```text
NODE_ENV=production
ATLAS_ENV=staging
ATLAS_APPLICATION_VERSION=<stable release version>
WEB_ORIGIN=https://<exact staging web hostname>
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUDIENCE=<multi-domain application audience>
HTTP_TRUST_PROXY_HOPS=<only after verification>
DATABASE_URL=<Render internal database reference>
DATABASE_POOL_MAX_CONNECTIONS=10
EXPECTED_SCHEMA_VERSION=15
LOG_LEVEL=info
METRICS_ENABLED=true
PASSWORD_BLOCKLIST_PATH=/etc/secrets/atlas-password-blocklist.sha256
SIMULATED_FUNDING_ENABLED=false
SIMULATED_WITHDRAWALS_ENABLED=false
SMTP_HOST=<selected provider>
SMTP_PORT=<selected provider>
SMTP_SECURE=<selected provider>
SMTP_FROM=<verified staging sender>
```

Render injects `PORT`; do not hardcode it in the manifest. All other bounded HTTP, projection, and
stream values initially use validated application defaults and become explicit only when staging
evidence requires a change.

Secret values generated or entered through Render outside Git are:

```text
CSRF_HMAC_KEY              # sync:false; Base64URL with at least 256 bits
METRICS_BEARER_TOKEN       # generated for API; collector uses a service reference
SMTP_USERNAME              # sync:false, only when required
SMTP_PASSWORD              # sync:false, only when required
GRAFANA_CLOUD_METRICS_TOKEN # sync:false, metrics-write only
registry credential        # named existing read-only credential only when images are private
```

The collector separately receives the same `METRICS_BEARER_TOKEN`, its exact private API target,
Grafana Cloud's HTTPS remote-write URL and username, and a metrics-write-only Grafana token. The
private API target and metrics bearer are Render service references rather than copied input. Follow
the [Grafana Cloud staging observability runbook](grafana-cloud-staging-observability.md); none of
those secret values belong in generated Blueprint output.

Database URLs and secret values must not enter shell history, deployment logs, screenshots, ADRs, or
readiness evidence. Seal or otherwise restrict provider variables after initial configuration.

## Intended service lifecycle

API:

- image: `ghcr.io/ashutosh-code-arch/atlas-api@sha256:<candidate>`;
- pre-deploy command:
  `node --enable-source-maps dist/platform/database/migrate.js`;
- start command: image default;
- deploy health path: `/health/ready`;
- graceful shutdown allowance: at least 30 seconds; and
- one instance.

Web:

- image: `ghcr.io/ashutosh-code-arch/atlas-web@sha256:<candidate>`;
- runtime variable:
  `ATLAS_WEB_API_BASE_URL=https://<exact staging API hostname>`;
- environment/access variables: `ATLAS_ENV=staging`, the same Cloudflare team domain, and the same
  multi-domain application audience used by the API;
- start command: image default;
- deploy health path: `/health/live`; and
- one instance.

Metrics collector:

- image: `ghcr.io/ashutosh-code-arch/atlas-metrics-collector@sha256:<candidate>`;
- service type: private, image-backed, exactly one instance;
- start command: image default;
- Render private-service TCP health behavior on port `12345` (no HTTP health path);
- target: exact API private hostname and effective private port; and
- no public route, autoscaling, or overlapping collector during rollout.

Automatic source builds and deploy-on-push remain disabled. Deployment begins from a reviewed release
record and promotes immutable digests.

## Generate and validate the Blueprint

Do not put credentials, tokens, database URLs, or secret-file contents in the input JSON. Validate
the exact non-secret input against `infra/render/staging-input.schema.json`, then generate a new,
release-specific output:

```bash
pnpm staging:render:generate -- \
  --config /path/to/staging-input.json \
  --readiness /path/to/staging-readiness.json \
  --output /path/to/render.yaml

render blueprints validate --workspace <workspace-id> /path/to/render.yaml
```

The generator refuses placeholders, unknown fields, stale prerequisite evidence, expired cost
approval, mutable image identity, existing output, and input overwrite. Review the entire generated
YAML before preserving or applying it. Render CLI validation is necessary but does not authorize a
provider mutation, recurring spend, traffic, staging `go`, or production promotion.

## First deployment order

After exact inputs produce a reviewed and Render-validated release manifest:

1. validate the candidate release and staging readiness record;
2. confirm the access boundary is active before exposing either custom hostname;
3. provision PostgreSQL 18 with no public ingress;
4. enable the seven-day-or-greater PITR policy before durable state;
5. enter and seal secrets, upload the blocklist, and wire the internal database reference;
6. deploy the API digest without enabling normal browser traffic;
7. run the migration job once and require `/health/ready`;
8. deploy the collector digest privately and prove remote `up == 1` before traffic;
9. deploy the web digest and require `/health/live`;
10. disable both default `onrender.com` subdomains after custom-domain verification;
11. execute hostile-forwarded-header and direct-bypass tests;
12. execute ADR-071's read-only staging suite and inspect its sanitized candidate-bound artifact;
13. execute invited-browser, Financial, Trading, ownership, WebSocket, and stale-recovery checks with
    synthetic identities;
14. rehearse and validate ADR-074's exact first-release or previous-release rollback plan;
15. validate ADR-073's invited, simulated-only product scope and tested support path; and
16. keep the readiness outcome `no-go` until monitoring, alert delivery, recovery, capacity,
    security, incident exercise, product scope, and remaining ADR-066 controls pass.

## Mandatory provider evidence

Record without secret or user data:

- workspace/project/resource identifiers and owners;
- selected region, plans, storage, PostgreSQL major, and monthly ceiling;
- exact source revision and image digests;
- Render deployment and migration results;
- custom-domain ownership, certificate renewal, and subdomain-disable results;
- private database reachability and failed public connection evidence;
- proxy-chain and hostile-forwarding results;
- WebSocket connection, heartbeat, reconnect, and graceful-shutdown results;
- built-in notification delivery and continuous external probe results;
- provider PITR status, available window, timed isolated drill, RPO, and RTO;
- aggregate connection/capacity and representative load results; and
- cleanup/suspension ownership and current recurring cost.

Render's dashboard showing a healthy deployment is not evidence for application correctness,
recovery, access isolation, or production approval.

## Stop conditions

Do not continue provisioning or traffic when:

- the live estimate exceeds the approved ceiling;
- a service requires a mutable image tag or source rebuild;
- the database needs public ingress for normal application operation;
- the proxy path permits forged client identity or direct bypass;
- either default service subdomain bypasses the access boundary;
- the PITR window is below seven days or cannot restore to a separate target;
- the migration job could run concurrently;
- application metrics cannot be scraped privately;
- secrets would need to enter the Blueprint or repository; or
- a required smoke, recovery, security, or readiness control fails.

Stop, preserve evidence, and revise ADR-067 or select another provider instead of weakening the
accepted Atlas boundary.
