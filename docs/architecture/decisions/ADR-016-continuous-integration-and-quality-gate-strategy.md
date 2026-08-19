# ADR-016 — Continuous Integration and Quality-Gate Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-19  
**Last reviewed:** 2026-08-19  
**Canonical owner/source:** ADR-016

## 1. Context

CI must reproduce the repository's documented verification contract rather than define a separate hidden development workflow.

Atlas CI must prove that a clean machine can:

- install the committed dependency graph;
- validate static quality rules;
- compile every production artifact;
- create PostgreSQL from committed migrations;
- run non-E2E tests;
- enforce architectural boundaries;
- operate without developer-local files or production secrets.

A local workflow that passes because of stale `node_modules`, generated `dist/`, or an existing database is insufficient evidence of repository correctness.

## 2. Decision

Atlas will initially use one sequential CI quality-gate job for pull requests and pushes to `main`.

The initial validation contract is:

```text
checkout
    ↓
install approved Node version
    ↓
install approved pnpm version
    ↓
restore pnpm store cache
    ↓
pnpm install --frozen-lockfile
    ↓
wait for PostgreSQL service health
    ↓
apply committed migrations
    ↓
pnpm verify
    ↓
pnpm build
```

The workflow will initially run for:

```text
pull_request
push to main
workflow_dispatch
```

Scheduled, deployment, and release workflows are deferred until a demonstrated requirement exists.

Pull-request runs should use concurrency cancellation so superseded commits do not consume unnecessary CI resources. Main-branch validation should not be casually cancelled.

## 3. Quality-Gate Job Topology

Atlas considered parallel jobs for static checks, tests, and production builds, but selects one sequential quality-gate job for Sprint 1.

The repository is small, there is one primary developer, and the target is pull-request completion within ten minutes. CI should be split only when measurements demonstrate meaningful benefit.

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
```

The build remains separate because passing type checks and tests does not prove that Vite production bundling, API production emission, contracts compilation, and workspace build coordination succeed from a clean checkout.

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

Playwright and browser E2E infrastructure are not introduced into the initial quality gate.

When meaningful E2E journeys exist, `pnpm test:e2e` will become a distinct CI job or workflow.

E2E testing requires coordinated web, API, PostgreSQL, and browser infrastructure. It must therefore not silently become part of ordinary `pnpm test`.

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

A full commit SHA is preferred because it provides an immutable action reference.

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

- CI approaches or exceeds the ten-minute target;
- static checks could fail substantially earlier;
- build and test execution benefit materially from parallelism;
- browser E2E infrastructure is introduced;
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
- A future E2E workflow will require additional infrastructure and startup orchestration.
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

## 17. Status

**Proposed**

This ADR establishes the initial CI quality-gate architecture. It should be accepted after the referenced ADR chain exists in the repository and the corresponding repository commands and runtime versions are confirmed against the implementation.
