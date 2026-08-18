# ADR-002: Project Folder Structure
## Date: 2026-08-15
## Status

Accepted

## Context

Atlas needs a repository structure that makes code ownership, dependency direction, application boundaries, and placement of new code obvious.

The repository contains different responsibilities:

* React/Vite browser application
* Express API application
* PostgreSQL schema and migrations
* Shared API contracts
* Infrastructure and deployment configuration
* Engineering documentation
* Application-owned tests
* Cross-application tests
* Repository-level scripts and configuration

The structure must avoid speculative domain folders and unnecessary top-level directories. A directory should represent a meaningful ownership or lifecycle boundary rather than merely a technology or tool.

The repository must also distinguish application code from infrastructure configuration and application-owned database schema from database infrastructure.

## Decision

Atlas will use an **application-oriented top-level structure with domain-oriented organization inside applications when domain implementation begins**.

The initial structure will be:

```text
atlas/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   └── tests/
│   │
│   └── api/
│       ├── src/
│       ├── tests/
│       └── migrations/
│
├── packages/
│   └── contracts/
│       ├── src/
│       └── tests/
│
├── infra/
├── docs/
│   └── architecture/
│       └── decisions/
│
├── scripts/
├── tests/
│   └── e2e/
│
├── eslint.config.js
└── tsconfig.base.json
```

### Top-level ownership rules

#### `apps/`

Contains independently runnable or deployable applications.

It does not contain reusable cross-application libraries, infrastructure provisioning, or repository-wide documentation.

#### `apps/web/`

Contains the React/Vite browser application.

It owns its UI, frontend application logic, browser-specific infrastructure, and frontend tests.

The web application must not import internal implementation code from `apps/api`.

Communication with the API occurs through the API's external interface.

#### `apps/api/`

Contains the Express backend application.

It owns API handlers, backend application logic, persistence access, external-service adapters, and backend tests.

When domain modules are introduced, they will be organized inside:

```text
apps/api/src/
└── modules/
```

Domain directories will be created only when their implementation and ownership have been designed.

No speculative domain directories will be created during Sprint 1.

#### `apps/api/migrations/`

Contains PostgreSQL schema migrations owned by the backend component responsible for the persisted business data.

The durable ownership rule is:

> **The backend component responsible for persisted business data owns its schema and migrations.**

For the initial Atlas architecture, that component is the API.

If a future worker or independently deployed service becomes the owner of a distinct persisted data domain, that component may own its corresponding schema and migrations.

#### `packages/`

Contains deliberately reusable code with a clearly defined cross-application consumer boundary.

It must not become a generic dumping ground for code that happens to be shared temporarily.

#### `packages/contracts/`

Contains API contracts shared between consumers such as the web application and API.
Shared packages must expose deliberate public APIs through their package exports; consumers may import only those public exports and must not import internal package files directly.
It may contain contract-level types, schemas, and validation definitions.

It must not contain:

* PostgreSQL models
* ORM entities
* database queries
* API business logic
* API implementation details

The dependency direction is therefore:

```text
apps/web ───────► packages/contracts
                       ▲
                       │
apps/api ──────────────┘
```

The web application must never depend directly on internal API implementation.

#### `infra/`

Contains environment provisioning and deployment configuration.

Examples include:

* containers
* hosting configuration
* networking
* environment provisioning
* deployment configuration
* infrastructure-as-code

It does not own application business logic or application database migrations.

The distinction between:

```text
apps/api/src/infrastructure/
```

and:

```text
infra/
```

is intentional.

`apps/api/src/infrastructure/` contains **runtime adapters used by the API**, such as:

* PostgreSQL repositories
* logging adapters
* external-service clients
* other infrastructure-facing application code

`infra/` contains **environment and deployment infrastructure**, such as:

* container configuration
* networking
* hosting
* environment provisioning

The first is application code; the second is operational infrastructure.

#### `docs/`

Contains engineering and architectural documentation.

Architecture decisions are organized under:

```text
docs/architecture/decisions/
```

It does not contain application source code or deployment configuration.

#### `scripts/`

Contains repository-level automation used by development, CI/CD, migrations, code generation, or other repository workflows.

Scripts should not become an alternative location for application business logic.

#### `tests/e2e/`

Contains tests that exercise behavior across application boundaries.

For example:

```text
Browser → API → PostgreSQL
```

It does not contain unit tests or tests that belong exclusively to one application.

Application-specific tests remain owned by their application:

```text
apps/web/tests/
apps/api/tests/
packages/contracts/tests/
```

The exact placement of unit tests relative to source files will be established by the testing strategy.

### Root configuration

Atlas will initially keep shared configuration simple:

```text
eslint.config.js
tsconfig.base.json
```

Individual applications can extend the base TypeScript configuration.

Separate configuration packages or directories will not be introduced until multiple reusable configuration presets create a genuine ownership or reuse requirement.

For example, `packages/typescript-config` may become appropriate later if Atlas requires distinct reusable presets for browser, Node.js, libraries, and tests.

## Dependency Rules

The repository structure establishes the following initial rules:

```text
apps/web
    │
    └────► packages/contracts

apps/api
    │
    └────► packages/contracts
```

`apps/web` must not import:

```text
apps/api/src/*
apps/api/migrations/*
```

`packages/contracts` must not depend on application implementation.

`infra/` must not become a dependency of application business logic.

Application modules should depend on explicit interfaces rather than reaching into another module's internal implementation.

## Alternatives Considered

### 1. Technology-first structure

```text
frontend/
backend/
shared/
```

Rejected because it provides weak guidance once Atlas introduces additional applications, workers, infrastructure, and reusable packages.

### 2. Domain-first repository structure

```text
identity/
trading/
financial/
market-data/
```

Rejected because repository organization should not be confused with backend module organization.

A business domain may eventually contribute to the API, workers, frontend, contracts, and other components. Making domains top-level repository boundaries would therefore mix multiple architectural concepts.

### 3. Separate configuration directories

```text
tsconfig/
eslint/
```

Rejected initially because these are configuration concerns rather than meaningful ownership boundaries. Root configuration files provide sufficient structure until multiple reusable configuration presets justify a dedicated package.

### 4. Generic shared directories

```text
shared/
common/
utils/
database/
```

Rejected because their ownership is ambiguous and they encourage unrelated code to accumulate in catch-all locations.

Reusable code must have a precise purpose and ownership boundary.

## Positive Consequences

* An engineer can quickly identify what applications can be run and deployed.
* Application ownership is explicit.
* Database schema ownership is explicit.
* Cross-application contracts have a clear location.
* Infrastructure is separated from application runtime adapters.
* Application tests remain close to their owning application.
* Cross-application tests have a dedicated location.
* Domain structure can evolve without creating speculative folders.
* The repository avoids unnecessary top-level directories.
* Configuration remains simple during Sprint 1.
* The structure preserves flexibility for future workers or independently deployed services.
* New code has a clear placement rule instead of relying on generic `shared`, `common`, or `utils` folders.

## Negative Consequences

* Some decisions about internal module organization are intentionally deferred.
* As Atlas grows, additional packages or applications may require new boundaries.
* The distinction between application infrastructure and deployment infrastructure must remain documented and enforced.
* The monorepo may eventually require more sophisticated workspace and build tooling.
* Developers must actively maintain dependency rules to prevent architectural drift.

## Reconsider When

Review this structure when:

* A new independently runnable or deployable application is introduced.
* A genuinely reusable package has multiple consumers.
* A backend domain requires an explicit module boundary.
* A worker or service becomes the owner of a distinct persisted data domain.
* Infrastructure requirements become complex enough to require additional organizational boundaries.
* Configuration becomes sufficiently complex to justify reusable configuration packages.
* Existing boundaries no longer accurately represent ownership or lifecycle.

## Final Rule

> **A new top-level directory requires a distinct ownership or lifecycle boundary; technology names alone do not justify one.**

This rule applies throughout Atlas's evolution.

A technology such as PostgreSQL, TypeScript, ESLint, Redis, or Docker does not automatically deserve a top-level directory.

The question must always be:

> **Does this represent a distinct responsibility, ownership boundary, or lifecycle that cannot be expressed cleanly within an existing boundary?**

If the answer is no, the new code belongs inside an existing boundary.

## Approval Criteria

This decision is ready for acceptance when the following principles are agreed upon:

1. Top-level directories represent meaningful ownership or lifecycle boundaries.
2. Applications are organized under `apps/`.
3. Deliberately reusable code is organized under `packages/`.
4. PostgreSQL migrations are owned by the backend component responsible for the persisted business data.
5. Application runtime adapters and deployment infrastructure remain distinct.
6. Application tests remain owned by their application.
7. Cross-application behavior belongs under `tests/e2e/`.
8. Domain directories are introduced only when their design and implementation begin.
9. Technology names alone do not justify new top-level directories.
