# Atlas Release and Deployment Runbook

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-09-04

This runbook implements ADR-063 and ADR-083 without assuming a production runtime vendor. ADR-075 and the
[zero-cost demo runbook](free-demo-hosting.md) govern the initial hosted environment. Paid Render
staging instructions below are retained for historical/future production-shaped use and must not be
applied to the demo.

Before selecting a new stable version for the routed brokerage interface, complete the
[authenticated interface release acceptance](interface-release-acceptance.md). A successful local
build or visual review alone does not authorize a tag, image publication, database migration, or
provider change.

## Prepare a stable release

1. Set the root `package.json` version to the intended stable semantic version.
2. Commit the version and all release source on `main`.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm verify
   pnpm build
   pnpm test:e2e
   pnpm test:performance
   pnpm containers:build
   pnpm security:check
   ```

4. Create and push an annotated `vMAJOR.MINOR.PATCH` tag at that commit.
5. Publish a non-prerelease GitHub Release for the existing tag.
6. Explicitly dispatch image publication, selecting the intended artifact:

   ```bash
   gh workflow run publish-release-images.yml --ref main \
     -f release_tag=v1.2.3 -f application=api
   ```

   Supported selections are `api`, `web`, `metrics-collector`, and `all`. Record the selected scope
   and any omitted/blocked artifacts in the release notes. Do not dispatch again to overwrite an
   already published version; investigate a partial failure and preserve existing digest evidence.

Publishing the GitHub Release alone does not publish images. The explicit workflow
fails if the tag format is unstable, the root package version differs, or the tagged commit is not
reachable from `origin/main`. It also verifies the exact checkout and a published stable release.
Shared preparation repeats tracked-secret scanning, the live workspace dependency audit, migrations,
verification, and production builds. Each selected image then builds and scans both runtime
architectures before registry login or push. Failures block that image without cancelling sibling
image jobs; SBOM/provenance and signed attestations remain required.

For a deliberately scoped release, replace the final two all-image commands above with:

```bash
pnpm security:secrets
pnpm security:dependencies
pnpm containers:build -- api
pnpm security:containers -- api
```

This is artifact-scoped evidence, not a waiver of failures elsewhere. The no-argument commands and
repository-wide quality workflow still scan all images. ADR-083 amends the coupled publication gate;
it does not authorize deployment of a failing artifact or relax the High/Critical threshold.

The security checks require live advisory evidence. Do not bypass a failed lookup or a finding to
make a release proceed. For a confirmed credential, revoke or rotate it before removing it from
source. See
[ADR-065](../architecture/decisions/ADR-065-software-supply-chain-vulnerability-and-secret-response.md)
for response and exception rules.

## Published artifacts

For release `1.2.3`, selecting `all` can publish these version and source tags. A narrower selection
publishes only its chosen image, and a failed image job publishes nothing:

```text
ghcr.io/ashutosh-code-arch/atlas-api:1.2.3
ghcr.io/ashutosh-code-arch/atlas-api:sha-<full-commit>
ghcr.io/ashutosh-code-arch/atlas-web:1.2.3
ghcr.io/ashutosh-code-arch/atlas-web:sha-<full-commit>
ghcr.io/ashutosh-code-arch/atlas-metrics-collector:1.2.3
ghcr.io/ashutosh-code-arch/atlas-metrics-collector:sha-<full-commit>
```

Do not deploy these tag strings directly. Resolve and record each multi-platform digest.

Verify signed provenance with GitHub CLI:

```bash
gh attestation verify \
  oci://ghcr.io/ashutosh-code-arch/atlas-api:1.2.3 \
  --repo Ashutosh-code-arch/AtlasExchange
```

Repeat verification for every other published image. Inspect OCI metadata and the attached
SBOM/provenance before promotion.

## Deployment configuration

The initial topology requires:

- HTTPS web and API origins under the same registrable site;
- exactly one private ingress hop and `HTTP_TRUST_PROXY_HOPS=1`;
- no direct public route to the API container;
- one API replica;
- explicit managed PostgreSQL and SMTP configuration;
- runtime-injected application secrets;
- `ATLAS_WEB_API_BASE_URL` set to the public HTTPS API base; and
- simulated funding and withdrawals disabled unless an explicitly approved non-custodial
  environment requires them.

The complete variable inventory remains in `apps/api/.env.example` and `apps/web/.env.example`.
Example files are documentation only and must not be supplied as production secret stores.

## Prepare the zero-cost demo promotion

The demo promotes one exact API digest to Render Free and one exact Worker/static-assets revision to
Cloudflare. Neon schema migration remains a deliberate operator action. Generate the strict
zero-cost contract from the accepted schema rather than adapting ADR-070's paid Blueprint:

```bash
pnpm demo:deployment:generate -- \
  --config /absolute/restricted/path/demo-deployment-input.json \
  --output /absolute/restricted/path/demo-deployment-manifest.json
```

The input fixes the full source revision, immutable API image digest, Access audience, exact
provider origins, PostgreSQL/schema versions, free plans, disabled paid features, and zero-cent
ceiling. The generated mode-`0600` manifest records required secret names without accepting secret
values.

Follow the [zero-cost demo runbook](free-demo-hosting.md). Provider activation remains separate from
release publication and must stop if any required resource is not actually free.

## Historical Render staging promotion artifact

ADR-070 implements the first provider-specific promotion boundary. Once exact non-secret staging
input, fresh candidate readiness evidence, and an unexpired cost approval exist, run:

```bash
pnpm staging:render:generate -- \
  --config /path/to/staging-input.json \
  --readiness /path/to/staging-readiness.json \
  --output /path/to/render.yaml
render blueprints validate --workspace <workspace-id> /path/to/render.yaml
```

Review and preserve the release-specific YAML before any deliberate provider application. The input
and output contain no secret values: Render generates the compatible internal metrics secret,
service references share it where required, and format-constrained or external credentials remain
secure initial-sync values.
Generation or CLI validation does not authorize provider changes, recurring spend, staging traffic,
or production promotion. Follow the [Render staging runbook](render-staging.md) for the complete
activation and evidence sequence.

## Promote by digest

Before a production promotion, complete and validate the exact candidate's go/no-go record under the
[operational readiness and incident runbook](operational-readiness.md). A successful release workflow
or image scan is not approval. A missing, stale, blocked, or changed control is a `no-go`.

Record the API, web, and metrics-collector digests, source revision, version, target environment,
schema version, and previous known-good digests. After an explicit `go`:

1. verify a recent recovery point, successful backup evidence, latest accepted restore drill, and
   database capacity under ADR-064;
2. run the API image migration entry point once using the API digest;
3. start the API digest without public traffic;
4. wait for `/health/live` and `/health/ready`;
5. start the metrics-collector digest privately and prove remote collection;
6. enable API ingress traffic;
7. start the web digest with its runtime API URL; and
8. run `pnpm test:staging`, inspect its sanitized partial artifact, and complete the remaining
   browser, ownership, Financial/Trading, WebSocket, bypass, and external-readiness evidence.

Do not run migrations from ordinary API startup and do not run concurrent migration jobs.

Before the first production-like deployment, and after a material backup/provider change, complete
the provider PITR procedure in the
[database recovery runbook](database-recovery.md). The local logical drill is useful regression
evidence but does not satisfy the production PITR requirement.

## Rollback

Prepare and rehearse the exact candidate plan through the
[rollback planning runbook](rollback-planning.md), then require:

```bash
pnpm rollback:validate -- /restricted/path/rollback-plan.json
```

Route back to the recorded previous release set only when it is compatible with the applied schema
and transition contracts. For a first release, remove traffic instead of naming fictional prior
digests. Never edit or automatically reverse an applied migration. If schema compatibility is lost,
stop the rollout and use a reviewed corrective forward migration or the separately tested database
recovery procedure.

The initial rollback unit is the API, web, and collector release set. Independent component rollback
requires a later reviewed compatibility decision.
