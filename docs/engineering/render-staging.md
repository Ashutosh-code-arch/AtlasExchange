# Atlas Render Staging Runbook

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-08-31

This runbook implements ADR-067's provider-selection boundary. No Render account or resource is
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
GHCR visibility/pull authority:  not verified
Deployment manifest:             deliberately deferred
Private metrics collector:       selected and implemented; not deployed
Grafana Cloud destination:        selected; no stack evidence
Production approval:             no-go
```

## Pre-provisioning blockers

- [ ] Record the Render workspace and project owner.
- [ ] Review the current Pro workspace and resource estimate in Render's billing UI.
- [ ] Set and record the approved monthly ceiling and billing alert.
- [ ] Supply an Atlas-controlled registrable domain and choose exact staging web/API hostnames.
- [x] Select an access boundary protecting both staging origins without a browser-embedded secret.
- [ ] Supply the exact Cloudflare team domain, multi-domain application audience, and approved email
      allow-list required by ADR-068.
- [ ] Decide whether GHCR release packages are public or use a rotatable read-only pull credential.
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
| `atlas-metrics-collector-staging` | Image-backed private service | live estimate required | 1 instance |
| `atlas-postgres-staging` | Render Postgres 18 | `0.5c-1g` | 15 GB |

Autoscaling is disabled. Database public access uses an empty allow-list. Services consume the
database's internal connection string. API, web, and collector images use exact GHCR digests from
the same release record. The collector has no public route; its plan remains a live cost input
because this runbook must not invent a Render SKU.

## Intended non-secret API configuration

The future manifest will set or reference:

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

Secret values configured outside Git are:

```text
CSRF_HMAC_KEY
METRICS_BEARER_TOKEN
SMTP_USERNAME       # only when required
SMTP_PASSWORD       # only when required
registry credential # only while GHCR images remain private
```

The collector separately receives the same `METRICS_BEARER_TOKEN`, its exact private API target,
Grafana Cloud's HTTPS remote-write URL and username, and a metrics-write-only Grafana token. Follow
the [Grafana Cloud staging observability runbook](grafana-cloud-staging-observability.md); none of
those values belong in the future Blueprint.

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
- private health path: `/` on port `12345`;
- target: exact API private hostname and effective private port; and
- no public route, autoscaling, or overlapping collector during rollout.

Automatic source builds and deploy-on-push remain disabled. Deployment begins from a reviewed release
record and promotes immutable digests.

## First deployment order

After a later slice commits and validates the Render manifest:

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
12. execute identity, Financial, Trading, Market Data, ownership, WebSocket, and stale-recovery smoke
    checks with synthetic identities; and
13. keep the readiness outcome `no-go` until monitoring, alert delivery, recovery, capacity, security,
    incident exercise, and remaining ADR-066 controls pass.

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
