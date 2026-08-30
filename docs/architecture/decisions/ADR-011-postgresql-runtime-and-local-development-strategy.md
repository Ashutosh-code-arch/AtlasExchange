# ADR-011 — PostgreSQL Runtime and Local Development Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-17  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-011

## 1. Context

Atlas requires a PostgreSQL runtime baseline and a predictable local-development environment that support:

- consistent PostgreSQL versions across developers and CI;
- real PostgreSQL integration testing;
- persistent local development data;
- isolated disposable test databases;
- explicit and reviewable migrations;
- controlled PostgreSQL upgrades;
- fast native Node.js development.

The database access, transaction, and migration architecture is defined separately by ADR-010. This decision establishes which PostgreSQL runtime Atlas uses and what Docker Compose owns during local development.

## 2. Decision Drivers

The decision prioritizes:

1. Supported PostgreSQL lifecycle and security maintenance.
2. Reproducible development and CI behavior.
3. Fast developer feedback for the web and API.
4. Real PostgreSQL behavior during database-dependent testing.
5. Clear separation between development, test, and production concerns.
6. Explicit upgrade procedures rather than accidental major-version changes.
7. Minimal infrastructure complexity for a solo developer.

## 3. PostgreSQL Runtime Baseline

Atlas selects:

```text
Architectural baseline:
PostgreSQL 18.x

Initial approved execution version:
PostgreSQL 18.4
```

PostgreSQL supports each major release for five years and recommends staying current within the supported release line.

[PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)

PostgreSQL 18 is preferred over PostgreSQL 17 because it provides the newer supported major release with a longer remaining support window. PostgreSQL 19 is not selected while it is still a beta release.

The architectural baseline is the major release line. The exact approved execution version is pinned separately for coordinated maintenance.

## 4. Why PostgreSQL 18

Atlas chooses PostgreSQL 18.x instead of PostgreSQL 17 because:

- PostgreSQL 18 is the current stable major release;
- it has a longer remaining support period;
- Atlas is early enough in development to adopt the newer major without an existing production compatibility burden;
- the baseline avoids starting a new system on an older major solely for conservatism;
- PostgreSQL 19 is not yet an appropriate production baseline while it remains beta.

The decision does not imply that every future minor release must be adopted immediately.

## 5. Local Development Strategy

Atlas adopts a hybrid local-development model:

```text
Web/API → native Node.js processes
PostgreSQL → Docker container
```

The normal developer workflow is:

```text
Host
├── Vite web process
├── tsx API process
│       ↓ localhost:mapped-port
└── Docker
        └── PostgreSQL 18.4
                └── named development volume
```

This provides:

- fast Vite and `tsx` feedback;
- direct debugger access;
- a controlled PostgreSQL version;
- no machine-level PostgreSQL installation;
- a straightforward path to real PostgreSQL integration tests;
- a future migration path to full containerization if a demonstrated requirement emerges.

Docker is infrastructure for the database environment, not the primary TypeScript development runtime.

Production API and web images are defined by ADR-062. This does not change the fast native Node.js
local workflow selected here. A containerized API connects through deployment configuration rather
than a source-code `localhost` assumption.

## 6. Why Not Fully Native PostgreSQL

A fully native setup would require each developer to install and maintain PostgreSQL locally.

That approach can be fast after setup, but it increases the risk of:

- different PostgreSQL major/minor versions;
- different local configuration;
- inconsistent extensions;
- difficult onboarding;
- divergence from CI.

Docker provides a controlled PostgreSQL runtime without requiring the application itself to run inside containers.

## 7. Why Not Fully Containerized Development

Running web, API, and PostgreSQL entirely through Compose would provide stronger environmental consistency, but it would initially add complexity to:

- filesystem watching;
- debugger configuration;
- dependency installation;
- rebuild cycles;
- Node.js development workflows.

Fully containerized local development is therefore deferred until a measurable requirement justifies
it. Production application packaging is a separate concern and is defined by ADR-062.

Potential triggers include:

- production/runtime parity becoming operationally important;
- host-environment differences causing recurring defects;
- CI/development divergence that hybrid development cannot reasonably control;
- deployment architecture requiring container-native workflows;
- materially improved developer productivity from containerized tooling.

## 8. Docker Image Policy

Atlas uses the official PostgreSQL image with an explicit minor version.

Conceptually:

```yaml
image: postgres:18.4
```

Atlas must not use:

```yaml
image: postgres
image: postgres:latest
```

The standard Debian-based image is selected initially. Alpine is deferred because its smaller image size does not provide enough demonstrated benefit for a local PostgreSQL service to justify another operating-system variation.

[Official PostgreSQL Docker image](https://hub.docker.com/_/postgres)

### Image reproducibility

An explicit minor tag stabilizes the PostgreSQL software version but does not provide content-addressed image reproducibility. Digest pinning may be introduced for CI or deployment when byte-level reproducibility is required. Digest maintenance and multi-platform behavior must be considered before adoption.

Accordingly:

```text
PostgreSQL architectural baseline
→ 18.x

Approved PostgreSQL execution version
→ 18.4

Container image
→ postgres:18.4
```

## 9. Development and Test Database Isolation

Development and test databases have separate lifecycles.

```text
Development database
├── named persistent volume
└── survives normal container restarts

Test database
├── isolated
├── initialized from committed migrations
└── disposable
```

Tests must never run against the developer's ordinary development database.

Removing the development volume must require an explicit destructive command.

A Docker volume is not a backup.

ADR-064 defines the production recovery layers and the isolated local logical restore drill. Docker
Compose does not schedule or retain backups; it only supplies the pinned PostgreSQL client/server
used by that local tooling check.

Database-dependent integration tests build their schema from the committed migration history using real PostgreSQL, consistent with ADR-004.

## 10. Migration Startup Behavior

Atlas does not use the PostgreSQL container initialization directory as its ongoing migration system.

Container initialization scripts run only when the PostgreSQL data directory is first created. They therefore cannot serve as Atlas's authoritative mechanism for evolving an existing database.

Instead:

```text
PostgreSQL container ready
        ↓
explicit migration command
        ↓
API development/test startup
```

Database readiness and schema readiness are separate conditions.

The migration history defined by ADR-010 remains authoritative.

## 11. PostgreSQL Health and Readiness

Compose uses `pg_isready` as the PostgreSQL health check.

A successful health check proves that PostgreSQL is accepting connections.

It does not prove that:

- Atlas migrations have been applied;
- the database schema is current;
- required application data exists;
- application-level dependencies are healthy.

Docker Compose may use `service_healthy` dependency conditions where appropriate, while the API remains responsible for handling temporary connection failures.

[Docker Compose startup ordering](https://docs.docker.com/compose/how-tos/startup-order/)

## 12. Upgrade Policy

### 12.1 Non-Major PostgreSQL 18 Updates

Updates within PostgreSQL 18.x are maintenance changes.

For example:

```text
18.4 → future 18.x
```

Atlas should:

1. Review PostgreSQL release notes.
2. Update the explicit image version.
3. Create a fresh database from the complete committed migration history.
4. Verify that an existing PostgreSQL 18 development/test volume starts correctly.
5. Run database integration tests against the upgraded runtime.
6. Verify the migration history on an existing database.
7. Update CI and local version pins consistently.
8. Record compatibility or operational findings.

A non-major update does not require a new ADR when the architectural major-version baseline remains PostgreSQL 18.x.

### 12.2 Major PostgreSQL Upgrade

A major upgrade, such as:

```text
18.x → 19.x
```

requires an explicit architecture and operational review.

The upgrade plan must consider:

- PostgreSQL release notes;
- extension compatibility;
- driver and query-builder compatibility;
- backup and restore testing;
- migration rehearsal;
- `pg_upgrade`, dump/restore, or another supported migration technique;
- rollback planning;
- CI and development-environment changes;
- application integration tests.

PostgreSQL major versions use incompatible data-directory formats and therefore require an upgrade mechanism such as `pg_upgrade` or dump/restore. Minor updates do not require conversion of the data directory.

[PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)

Changing only the container image's major tag while reusing an existing PostgreSQL data volume is not an upgrade plan.

## 13. Docker Compose Scope

During the initial development phase, Docker Compose owns:

- PostgreSQL service;
- explicit PostgreSQL image version;
- PostgreSQL health check;
- persistent development volume;
- internal development network;
- configurable host-port mapping.

Docker Compose does not own:

- API or web production orchestration;
- automatic application migrations;
- production secrets;
- backups;
- monitoring infrastructure.

The production API and web images are defined by ADR-062, but the registry, runtime platform,
network topology, rollout, and production database remain later deployment decisions.

## 14. PostgreSQL Extensions and Custom Images

Atlas will use the standard official PostgreSQL image during Sprint 1.

No PostgreSQL extensions or custom database image are selected by this ADR.

An extension or custom image requires a demonstrated requirement, such as:

- a business capability that cannot reasonably be implemented with standard PostgreSQL;
- a measured performance or operational requirement;
- a required PostgreSQL feature unavailable in the baseline image.

Introducing one should include compatibility, operational, upgrade, backup/restore, and CI implications in the relevant future decision.

## 15. Consequences

### Positive

- PostgreSQL version is explicit and consistent.
- Developers do not need machine-level PostgreSQL installations.
- Native Node.js development remains fast.
- Database integration tests use real PostgreSQL.
- Development and test data have distinct lifecycles.
- Migration execution remains explicit and reviewable.
- PostgreSQL major upgrades cannot occur accidentally through a floating image tag.
- The infrastructure boundary remains small during Sprint 1.

### Negative

- Developers need Docker for PostgreSQL.
- Local development requires coordination between native processes and a container.
- Explicit image versions require deliberate maintenance.
- A PostgreSQL major upgrade will require operational planning.
- Hybrid development is not identical to a future fully containerized production environment.

## 16. Deferred Decisions

The following are intentionally not selected by this ADR:

- PostgreSQL extension selection.
- Custom PostgreSQL images.
- Content-addressed image digest pinning.
- Fully containerized local development.
- Production container orchestration and registry selection.
- Production database hosting.
- Production provider, encrypted backup storage, and PITR implementation. The required recovery
  architecture and validation contract are defined by ADR-064.
- Production observability architecture.
- PostgreSQL 19 adoption.
- Detailed PostgreSQL transaction isolation policy.
- Detailed locking and concurrency strategy.
- Financial precision and scale for individual concepts.

## 17. Reconsideration Criteria

Reconsider this ADR when:

- PostgreSQL 18 approaches the end of its supported lifecycle;
- a newer stable PostgreSQL major provides a material Atlas benefit;
- PostgreSQL runtime differences cause recurring development or CI failures;
- full containerization measurably improves reliability or developer productivity;
- deployment requires container-native infrastructure;
- a required extension cannot operate within the standard official image;
- CI or deployment requires digest-level reproducibility;
- PostgreSQL hosting requirements change materially.

## 18. Related Decisions

- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)
- [ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)
- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-062 — Production Application Packaging and Runtime Web Configuration](ADR-062-production-application-packaging-and-runtime-web-configuration.md)
- [ADR-064 — PostgreSQL Backup, Restore, and Recovery Validation](ADR-064-postgresql-backup-restore-and-recovery-validation.md)
