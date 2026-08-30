# Atlas Release and Deployment Runbook

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-08-31

This runbook implements ADR-063 without assuming a production runtime vendor.

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

Publishing the GitHub Release starts `.github/workflows/publish-release-images.yml`. The workflow
fails if the tag format is unstable, the root package version differs, or the tagged commit is not
reachable from `origin/main`. Before either publish job receives registry write authority, release
preparation repeats tracked-secret scanning, the live workspace dependency audit, local production
image builds, and High/Critical image scanning.

The security checks require live advisory evidence. Do not bypass a failed lookup or a finding to
make a release proceed. For a confirmed credential, revoke or rotate it before removing it from
source. See
[ADR-065](../architecture/decisions/ADR-065-software-supply-chain-vulnerability-and-secret-response.md)
for response and exception rules.

## Published artifacts

For release `1.2.3`, the workflow publishes discoverable version and source tags:

```text
ghcr.io/ashutosh-code-arch/atlas-api:1.2.3
ghcr.io/ashutosh-code-arch/atlas-api:sha-<full-commit>
ghcr.io/ashutosh-code-arch/atlas-web:1.2.3
ghcr.io/ashutosh-code-arch/atlas-web:sha-<full-commit>
```

Do not deploy these tag strings directly. Resolve and record each multi-platform digest.

Verify signed provenance with GitHub CLI:

```bash
gh attestation verify \
  oci://ghcr.io/ashutosh-code-arch/atlas-api:1.2.3 \
  --repo Ashutosh-code-arch/AtlasExchange
```

Repeat verification for the web image. Inspect OCI metadata and the attached SBOM/provenance before
promotion.

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

## Promote by digest

Before a production promotion, complete and validate the exact candidate's go/no-go record under the
[operational readiness and incident runbook](operational-readiness.md). A successful release workflow
or image scan is not approval. A missing, stale, blocked, or changed control is a `no-go`.

Record the API and web digests, source revision, version, target environment, schema version, and
previous known-good digests. After an explicit `go`:

1. verify a recent recovery point, successful backup evidence, latest accepted restore drill, and
   database capacity under ADR-064;
2. run the API image migration entry point once using the API digest;
3. start the API digest without public traffic;
4. wait for `/health/live` and `/health/ready`;
5. enable API ingress traffic;
6. start the web digest with its runtime API URL; and
7. smoke-test health, session establishment, and public Market Data.

Do not run migrations from ordinary API startup and do not run concurrent migration jobs.

Before the first production-like deployment, and after a material backup/provider change, complete
the provider PITR procedure in the
[database recovery runbook](database-recovery.md). The local logical drill is useful regression
evidence but does not satisfy the production PITR requirement.

## Rollback

Route back to the recorded previous digest only when it is compatible with the applied schema.
Never edit or automatically reverse an applied migration. If schema compatibility is lost, stop the
rollout and use a reviewed corrective forward migration or the separately tested database recovery
procedure.

Web and API may use different prior digests only when their public contracts remain compatible and
the release record explains the pair.
