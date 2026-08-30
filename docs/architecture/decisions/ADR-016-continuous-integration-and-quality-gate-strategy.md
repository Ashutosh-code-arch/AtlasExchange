# ADR-016 — Continuous Integration and Quality-Gate Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-19  
**Last reviewed:** 2026-08-31
**Canonical owner/source:** ADR-016

## 1. Context

CI must reproduce the repository's documented verification contract rather than define a separate hidden development workflow.

Atlas CI must prove that a clean machine can:

- reject likely credential material before dependency installation;
- install the committed dependency graph;
- audit the complete workspace graph against current advisories;
- validate static quality rules;
- compile every production artifact;
- build both production application images;
- scan both production images for known High and Critical vulnerabilities;
- create PostgreSQL from committed migrations;
- run non-E2E tests;
- enforce architectural boundaries;
- operate without developer-local files or production secrets.

A local workflow that passes because of stale `node_modules`, generated `dist/`, or an existing database is insufficient evidence of repository correctness.

## 2. Decision

Atlas uses one sequential CI quality-gate job plus a separate browser-system-test job for pull
requests and pushes to `main`. The quality job also runs weekly to refresh time-varying security
evidence; the browser job is skipped on that schedule.

The initial validation contract is:

```text
checkout
    ↓
lint GitHub workflows with digest-pinned actionlint
    ↓
install approved Node version
    ↓
install approved pnpm version
    ↓
pnpm security:secrets
    ↓
restore pnpm store cache
    ↓
pnpm install --frozen-lockfile
    ↓
pnpm security:dependencies
    ↓
wait for PostgreSQL service health
    ↓
apply committed migrations
    ↓
pnpm verify
    ↓
pnpm build
    ↓
pnpm containers:build
    ↓
pnpm security:containers

parallel E2E job
    ↓
install Chromium and system dependencies
    ↓
pnpm test:e2e
```

The workflow will initially run for:

```text
pull_request
push to main
weekly security refresh
workflow_dispatch
```

ADR-063 adds a separate release-publication workflow for stable published GitHub Releases. Its
preparation job repeats the security boundary before image-publication jobs receive write authority.

Pull-request runs should use concurrency cancellation so superseded commits do not consume unnecessary CI resources. Main-branch validation should not be casually cancelled.

## 3. Quality-Gate Job Topology

Atlas keeps static checks, non-E2E tests, production builds, and image builds in one sequential
quality-gate job. Browser E2E runs separately because it owns Chromium plus isolated PostgreSQL and
Mailpit infrastructure and is independently diagnosable.

The repository is small, there is one primary developer, and the quality job has a twenty-minute
timeout. It should be split further only when measurements demonstrate meaningful benefit.

## 4. Canonical Verification Contract

`pnpm verify` is the repository's non-E2E verification contract:

```text
typecheck
+ lint
+ format:check
+ dependency-boundary checks
+ non-E2E tests
```

CI runs both:

```text
pnpm verify
pnpm build
pnpm containers:build
pnpm security:containers
```

The build remains separate because passing type checks and tests does not prove that Vite production bundling, API production emission, contracts compilation, and workspace build coordination succeed from a clean checkout.

The container build remains separate because ordinary build output does not prove that each
Dockerfile can create its isolated, non-root runtime artifact from the committed lockfile and
workspace dependency graph.

The security commands remain separate from `pnpm verify` because registry advisories and the image
scanner database are time-varying network evidence. ADR-065 owns their severity, scanner authority,
schedule, and response policy.

## 5. Runtime Pinning

CI must use:

```text
Node.js 24.19.0
```

This remains the CI runtime until the approved execution version changes under ADR-006.

CI must install the exact pnpm version declared by the repository's `packageManager` field.

The workflow must not silently select a latest pnpm release or broad major range.

The exact setup action depends on the pnpm version selected by the repository:

- `pnpm/action-setup` remains applicable to pnpm 10 and earlier;
- `pnpm/setup` applies to pnpm 11 and later.

ADR-016 defines version ownership; implementation must use the action compatible with the declared pnpm version.

## 6. Dependency Installation

CI always uses:

```bash
pnpm install --frozen-lockfile
```

Requirements:

- the root lockfile is committed;
- CI fails when manifests and lockfile disagree;
- workspaces do not resolve dependencies independently;
- CI never repairs or rewrites the lockfile;
- generated `node_modules` is not committed;
- caches do not substitute for installation verification.

Initially cache only the pnpm content-addressable store.

Do not initially cache:

- `node_modules`;
- `dist/`;
- test results;
- TypeScript output;
- Vite output.

Avoiding generated-output caches reduces stale-artifact risk and keeps the clean-build contract explicit.

## 7. PostgreSQL Service

CI uses a Linux GitHub-hosted runner with a PostgreSQL service container matching ADR-011:

```text
postgres:18.4
```

The CI database is disposable and test-only.

The workflow will:

- provide test-only database credentials;
- wait for PostgreSQL readiness using `pg_isready`;
- use an empty database;
- apply the complete committed migration history;
- provide `DATABASE_URL` explicitly to the test process;
- allow the runner to destroy the database environment after the job.

PostgreSQL becoming healthy does not prove that the Atlas schema is current. Migration execution remains a separate explicit step.

Database integration tests therefore exercise the migration history against a fresh PostgreSQL instance, consistent with ADR-004, ADR-010, and ADR-011.

## 8. Environment Isolation

CI must not depend on:

- `.env`;
- `.env.local`;
- developer-local databases;
- host-installed PostgreSQL;
- generated artifacts from previous runs;
- production credentials.

Required test configuration is supplied explicitly by the workflow or deterministic test setup.

This preserves the configuration boundary established by ADR-012.

## 9. E2E Boundary

Playwright browser E2E runs as a distinct mandatory CI job through `pnpm test:e2e`.

E2E testing requires coordinated web, API, PostgreSQL, and browser infrastructure. It must therefore not silently become part of ordinary `pnpm test`.

The E2E harness provisions disposable PostgreSQL and Mailpit services, applies committed migrations,
builds the web artifact, starts the API and production web server on reserved ports, runs Chromium
journeys, and removes its infrastructure. It must not reuse the quality job's database or a
developer-local service.

## 10. Security and Workflow Permissions

The validation workflow initially requires only:

```yaml
permissions:
  contents: read
```

Additional permissions require a demonstrated need.

The workflow must:

- use least-privilege token permissions;
- pin every third-party action to a verified full commit SHA;
- place a readable version comment beside each SHA;
- update action SHAs deliberately;
- avoid exposing secrets to untrusted pull-request code;
- never use `pull_request_target` to execute proposed repository code;
- avoid interpolating untrusted pull-request metadata directly into shell commands;
- avoid write permissions for the validation workflow.

Workflow syntax and expressions are checked by the version-and-digest-pinned official actionlint
container before dependency installation. This keeps release-authority changes inside the same
reviewed quality boundary without adding actionlint to application dependencies.

A full commit SHA is preferred because it provides an immutable action reference.

### Release publication

The release workflow is not a pull-request validation path. It runs only for a published,
non-prerelease GitHub Release, repeats source-secret scanning, frozen installation, dependency
auditing, migrations, `pnpm verify`, `pnpm build`, production image builds, and image scanning, then
publishes both images from the tagged source.

The release tag must be stable semantic `vMAJOR.MINOR.PATCH`, match the root package version, and
resolve to a commit reachable from `origin/main`. Publication actions are pinned by full SHA. Only
the publishing matrix receives `packages: write`, `id-token: write`, and `attestations: write`; the
quality workflow remains read-only.

## 11. Runner Strategy

The initial runner is an explicit supported Linux runner line:

```yaml
runs-on: ubuntu-24.04
```

Atlas will not rely indefinitely on `ubuntu-latest`.

The explicit runner line stabilizes the operating-system major version while accepting that the hosted image receives maintenance updates.

A fully immutable CI runner is not required for Sprint 1.

## 12. Failure and Timeout Policy

The quality-gate job must:

- stop after a failed mandatory step;
- define an explicit workflow/job timeout;
- preserve readable test output;
- avoid retries for deterministic lint, type-check, build, or test failures;
- permit infrastructure retries only when evidence demonstrates a transient platform failure.

Flaky-test retries must not be enabled globally. Retries must not conceal nondeterminism.

## 13. Branch Protection

Once the repository is hosted, `main` should require the CI quality-gate check before merge.

This remains useful for a solo developer because it:

- prevents accidental broken `main`;
- preserves pull-request discipline;
- demonstrates a production-style workflow;
- makes the repository's quality contract visible.

Administrative bypass remains an emergency mechanism rather than the normal development path.

## 14. Reconsideration Criteria

The initial sequential job should be reconsidered when measurable evidence shows that:

- CI approaches or exceeds its explicit job timeouts;
- static checks could fail substantially earlier;
- build and test execution benefit materially from parallelism;
- browser or container execution benefits materially from further parallelism;
- multiple supported Node or PostgreSQL versions require a matrix;
- deployment workflows require artifacts from validated builds;
- additional caching produces measured benefit without introducing stale-artifact risk.

Splitting jobs is an optimization decision, not an architectural requirement for Sprint 1.

## 15. Consequences

### Positive

- CI mirrors the documented repository verification contract.
- Clean-checkout failures caused by missing generated artifacts are exposed.
- Dependency installation is reproducible from the committed lockfile.
- PostgreSQL integration is exercised against a fresh database and committed migration history.
- Production artifact construction is explicitly verified.
- Developer-local environment state cannot silently make CI pass.
- The initial workflow remains understandable and inexpensive to maintain.
- Security permissions remain minimal.

### Negative

- A sequential quality gate may take longer than parallel jobs as the repository grows.
- Dependency installation follows the clean lockfile contract on each non-cached run.
- Generated-output caching is intentionally sacrificed for correctness simplicity.
- Browser and container verification consume more CI time and external image bandwidth.
- Action SHA maintenance introduces an explicit update responsibility.

## 16. Related Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-011 — PostgreSQL Runtime and Local Development Strategy](ADR-011-postgresql-runtime-and-local-development-strategy.md)
- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-013 — Static Analysis, Formatting, and Git-Hook Strategy](ADR-013-static-analysis-formatting-and-git-hook-strategy.md)
- [ADR-062 — Production Application Packaging and Runtime Web Configuration](ADR-062-production-application-packaging-and-runtime-web-configuration.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-064 — PostgreSQL Backup, Restore, and Recovery Validation](ADR-064-postgresql-backup-restore-and-recovery-validation.md)
- [ADR-065 — Software Supply-Chain, Vulnerability, and Secret Response](ADR-065-software-supply-chain-vulnerability-and-secret-response.md)
