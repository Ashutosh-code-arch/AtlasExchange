# ADR-001: Repository Strategy
## Date: 2026-08-15

## Status

Accepted

## Context

Atlas needs to choose a repository strategy that supports rapid development as a solo developer while keeping the codebase maintainable, testable, and easy to evolve as the product grows.

The repository structure should allow frontend, backend, shared contracts, infrastructure, documentation, and future services to evolve without introducing unnecessary operational complexity.

The decision should balance developer productivity, clear ownership boundaries, deployment flexibility, CI/CD complexity, and the possibility of extracting services later if Atlas requires independent scaling, deployment, security, or team ownership.

A repository boundary should be treated independently from module and deployment boundaries:

* **Repository boundary** determines what is versioned, reviewed, permissioned, and changed together.
* **Module boundary** determines responsibility, encapsulation, ownership, and allowed dependencies.
* **Deployment boundary** determines what can be built, configured, released, scaled, and rolled back independently.

These boundaries may align in some cases, but Atlas should not assume that they must.

## Decision

Atlas will use a **monorepo strategy**.

The repository will contain the primary application components and shared development resources under a single version-controlled repository, with clear directory boundaries between major components.

The initial structure will follow a modular organization, for example:

```text
apps/       - independently runnable applications such as web frontend and API
packages/   - shared libraries, types, schemas, utilities, and contracts
infra/      - infrastructure and deployment configuration
docs/       - architecture decisions and technical documentation
scripts/    - development and automation scripts
tests/      - cross-application or integration testing where appropriate
```

Atlas will not begin with separate repositories for individual services or domains.

The monorepo decision does **not** prescribe a modular-monolith architecture or a specific deployment topology. Applications and modules may have different deployment boundaries while remaining within the same repository.

Internal architectural boundaries should therefore be designed independently of repository boundaries. Components should expose explicit interfaces, maintain controlled dependencies, and avoid leaking implementation details across boundaries.

If a component later requires independent deployment, scaling, reliability isolation, security isolation, or team ownership, it may become a separate deployment while remaining in the monorepo.

If a later organizational or technical requirement justifies repository-level isolation, that component may also be extracted into a separate repository.

The principle is:

> **Atlas will optimize repository boundaries for developer productivity and code ownership, while allowing module and deployment boundaries to evolve independently.**

## Alternatives Considered

### 1. Multiple repositories

Separate repositories for frontend, backend, infrastructure, and future services.

**Rejected initially** because it introduces additional coordination, dependency management, CI/CD configuration, versioning, and local-development complexity without providing sufficient benefits at Atlas's current scale.

Independent deployment does not require independent repositories, so repository splitting is not justified solely by deployment requirements.

### 2. Monorepo with tightly coupled code

A single repository where applications and modules freely import and depend on one another.

**Rejected** because a monorepo should not imply uncontrolled coupling.

Atlas requires explicit module boundaries, dependency rules, ownership boundaries, and stable interfaces so that code can remain independently understandable and changeable.

### 3. Microservice-per-repository

Each domain or service receives its own repository from the beginning.

**Rejected** because Atlas does not yet have sufficient scale, team ownership requirements, operational complexity, or isolation requirements to justify the additional distributed-system and repository-management overhead.

Microservices may become appropriate later, but their introduction should be driven by demonstrated requirements rather than repository structure.

## Positive Consequences

* One source of truth for the product.
* Easier local development and onboarding.
* Shared types, schemas, utilities, and contracts can be versioned together.
* Cross-component changes can be implemented atomically when necessary.
* Easier refactoring while the architecture is evolving.
* Simpler initial CI/CD management.
* Easier code search and architectural exploration.
* Lower repository-management overhead for a solo developer.
* Module boundaries can remain strong without requiring separate repositories.
* Applications can be deployed independently while remaining in the same repository.
* A component can later become an independent deployment without requiring an immediate repository split.
* Infrastructure and application changes can be reviewed together.
* Repository, module, and deployment boundaries can evolve independently as Atlas grows.

## Negative Consequences

* The repository can become difficult to manage if architectural and dependency boundaries are not enforced.
* CI/CD pipelines may become slower as the repository grows.
* Poor dependency discipline could create circular or tightly coupled modules.
* Repository tooling and build configuration may become more sophisticated over time.
* Shared repository conventions can become harder to maintain as the number of applications and teams increases.
* A monorepo provides less repository-level isolation if different teams eventually require substantially different permissions or release processes.
* Independent deployment within a monorepo still requires appropriate build, CI/CD, configuration, and operational tooling.

## Reconsider When

Review this decision when one or more of the following conditions become true:

* Atlas has multiple engineering teams that require genuinely independent repository ownership and release processes.
* Repository-level permissions or security isolation become necessary.
* Repository size or CI/CD performance becomes a significant engineering bottleneck.
* Independent components require substantially different development workflows that are difficult to manage within one repository.
* Organizational requirements make separate repositories preferable.
* The cost of coordinating changes inside the monorepo becomes greater than the cost of managing multiple repositories.
* A component has become sufficiently mature and independently owned that repository extraction provides a clear operational or organizational benefit.

Importantly, **the need for independent deployment alone is not sufficient reason to split the repository**. Deployment boundaries and repository boundaries should remain separate decisions.

## Approval Criteria

This ADR should be considered approved when the following principle is accepted:

> **Atlas will keep repository boundaries, module boundaries, and deployment boundaries conceptually independent. The initial repository will be a monorepo, while modules and deployments may evolve independently as scaling, reliability, security, or organizational requirements emerge.**
