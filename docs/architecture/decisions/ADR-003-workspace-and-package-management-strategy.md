# ADR-003: Workspace and Package-Management Strategy

## Status

Accepted

## Date

2026-08-16

## Last reviewed

2026-08-30

## Context

Atlas is a TypeScript monorepo containing multiple independently owned projects:

```text
apps/web
apps/api
packages/contracts
tests/e2e
```

Each workspace needs its own dependencies, scripts, build behavior, and tests, while the repository needs:

* One reproducible dependency installation.
* One root lockfile.
* Explicit dependency ownership.
* Local linking of internal packages.
* Independent commands for individual workspaces.
* Repository-wide commands.
* Consistent local and CI behavior.
* Clear workspace boundaries that support the architectural boundaries established by the repository structure.

The package manager, workspace system, and task orchestrator are separate responsibilities:

| Responsibility     | Atlas decision                      |
| ------------------ | ----------------------------------- |
| Package manager    | pnpm                                |
| Workspace system   | pnpm workspaces                     |
| Task orchestration | No dedicated orchestrator initially |

Atlas also needs dependency declarations to remain an architectural source of truth.

Every workspace must explicitly declare the dependencies required to build, test, and run it.

A package manager can support this invariant but cannot enforce every architectural rule by itself. Developers can still bypass workspace boundaries through direct relative imports, so dependency and import boundaries must be treated separately.

## Decision

Atlas will use **pnpm workspaces without Turborepo or another dedicated task orchestrator initially**.

The repository will use a single pnpm workspace and a single root lockfile.

Initial workspace patterns will include:

```text
apps/*
packages/*
tests/e2e
```

`tests/e2e` is a reserved workspace location. It becomes the `@atlas/e2e` workspace when its `package.json` and test implementation are created. Including its path in the workspace configuration does not require creating an empty workspace during Sprint 1.

The initial workspace identities are:

```text
@atlas/web
@atlas/api
@atlas/contracts
@atlas/e2e
```

The `@atlas/e2e` identity applies once the E2E workspace is created.

Folder names describe repository organization, while package names provide the canonical identity used by workspace tooling and commands.

### Private packages

The root package and all initial workspaces will be marked `private` to prevent accidental publication to a package registry.

Publishing an internal package requires a separate deliberate architectural decision.

### Dependency ownership

Every workspace must explicitly declare all dependencies required to build, test, and run it.

For example:

```text
@atlas/web
    └── @atlas/contracts

@atlas/api
    └── @atlas/contracts

@atlas/e2e
    └── its own E2E dependencies
```

Internal workspace dependencies must use the `workspace:` protocol.

Applications must not rely on dependencies installed for another workspace.

The package manifest is therefore treated as an architectural declaration:

> **A workspace's manifest must accurately describe the dependencies required by that workspace.**

### Internal package consumption

Applications must consume internal packages through their declared package identity and public exports.

For example:

```text
@atlas/contracts
```

is the supported dependency.

The following pattern is forbidden:

```text
import { schema } from "../../../packages/contracts/src/schema";
```

Relative imports across workspace boundaries are not allowed.

Consumers must not bypass a package's public API by importing internal source files directly.

pnpm provides dependency and workspace mechanisms that support this model, but additional linting or architectural boundary checks may eventually be introduced to enforce the import rule.

### E2E workspace ownership

`tests/e2e` is a repository-level test location because it tests behavior across application boundaries.

Once implemented, `@atlas/e2e` will own its:

* test runner;
* browser driver;
* configuration;
* dependencies;
* scripts.

Its repository-level scope does not mean its dependencies belong implicitly to the repository root.

### Root lockfile

Atlas will maintain exactly one committed root:

```text
pnpm-lock.yaml
```

The lockfile represents the reproducible dependency graph for the repository.

Individual workspaces will not maintain separate lockfiles.

### Tool version

The repository will declare the expected pnpm version so that local development and CI use a known package-manager version.

The exact version will be selected during implementation.

### CI installation

CI must install dependencies from the committed lockfile using a frozen-lockfile installation.

CI must not silently modify dependency resolution or regenerate the lockfile during ordinary builds and tests.

### Deployable workspace artifacts

Atlas enables pnpm's injected workspace dependency mode. Internal workspace dependencies are copied
into their consumers' virtual store entries rather than represented only as development-time
symlinks. Successful `build` scripts synchronize those injected copies.

This preserves the explicit `workspace:` dependency graph while allowing `pnpm deploy --prod` to
create an isolated production dependency tree for a deployable application. A production artifact
must not depend on the monorepo source tree or on another workspace's installed dependencies.

Injected dependencies do not make internal packages private implementation details. Applications
continue to consume only their declared package identity and public exports.

### Commands

Each workspace must provide independently runnable commands for its relevant lifecycle operations.

Examples:

```text
pnpm --filter @atlas/web test
pnpm --filter @atlas/api test
pnpm --filter @atlas/contracts test
pnpm --filter @atlas/e2e test
```

The repository must also provide one root-level entry point for repository-wide testing:

```text
pnpm test
```

The exact scripts will be defined during implementation.

The root test command must:

* provide one canonical repository-wide test entry point;
* fail when a selected workspace test fails;
* allow individual workspace tests to run independently;
* avoid requiring E2E infrastructure during ordinary unit/integration test execution unless explicitly requested.

The root command's behavior is an explicit repository script contract; it is not assumed from pnpm itself.

## Alternatives Considered

### 1. npm workspaces

npm workspaces provide workspace linking, dependency installation, and workspace-oriented commands with minimal additional tooling.

**Rejected** because Atlas places significant value on explicit dependency visibility and workspace boundaries.

npm can support a disciplined monorepo, but pnpm provides a dependency layout that better supports Atlas's goal of preventing accidental access to undeclared dependencies.

The decision is therefore based on dependency correctness rather than installation benchmarks.

### 2. Modern Yarn workspaces

Yarn provides sophisticated workspace functionality, filtering, constraints, and other monorepo features.

**Rejected initially** because its additional capabilities are not necessary for Atlas's current size and introduce more concepts than required.

Atlas can reconsider Yarn if its workspace requirements materially change.

### 3. pnpm with Turborepo

pnpm could be combined with Turborepo for dependency-aware task scheduling, parallel execution, and caching.

**Rejected initially** because Atlas has only a small number of workspaces and does not yet have a measurable task-orchestration problem.

The package manager can provide sufficient workspace-level command execution at the current scale.

### 4. Separate package managers per application

Each application could manage its own dependencies independently.

**Rejected** because this would remove the benefits of a unified workspace:

* no single dependency graph;
* multiple lockfiles;
* more complicated local linking;
* inconsistent dependency resolution;
* more difficult CI reproducibility;
* weaker repository-wide dependency visibility.

## Positive Consequences

* One reproducible dependency installation.
* One root lockfile.
* Explicit dependency ownership for every workspace.
* Local packages can be referenced through `workspace:`.
* Canonical workspace names make commands unambiguous.
* Stronger protection against accidental phantom dependencies.
* Applications remain independently testable.
* E2E dependencies remain owned by the E2E workspace.
* Repository-wide commands remain available without requiring a task orchestrator.
* Workspace boundaries reinforce the architectural boundaries established in ADR-002.
* The repository can grow without immediately introducing additional orchestration tooling.
* Dependency versions can be centrally coordinated while dependency ownership remains explicit in each workspace.
* Initial packages cannot be accidentally published.

## Negative Consequences

* Developers must learn pnpm-specific workspace commands and behavior.
* pnpm introduces an additional tool requirement beyond basic Node.js/npm workflows.
* Some poorly behaved tools may have compatibility issues with pnpm's dependency layout.
* Import boundaries cannot be guaranteed by pnpm alone.
* Additional linting or architectural checks may be required to prevent relative imports across workspace boundaries.
* Root scripts must be deliberately maintained because pnpm does not automatically define the semantics of `pnpm test`.
* As the repository grows, package-manager task execution may become insufficient for efficient builds and tests.
* Shared configuration or testing needs may eventually justify additional packages.

## Reconsider When

### Replacing pnpm

Reconsider the package-manager decision when:

* pnpm creates persistent compatibility problems with Atlas's tooling.
* CI or local installation reliability becomes a recurring issue specifically attributable to pnpm.
* Required ecosystem tooling provides substantially better support for another package manager.
* Workspace dependency semantics no longer meet Atlas's architectural requirements.
* The operational or maintenance cost of pnpm becomes materially greater than viable alternatives.

A simple preference for another package manager is not sufficient reason to replace pnpm. The replacement must provide a meaningful architectural, reliability, or operational benefit.

### Adding a Task Orchestrator

Reconsider adding Turborepo, Nx, or another task orchestrator when measurable repository complexity creates a need for it.

Relevant signals include:

* CI build/test times become a significant bottleneck.
* Atlas has substantially more applications or packages.
* Tasks repeatedly execute for unaffected workspaces.
* Dependency-aware task ordering becomes difficult to maintain manually.
* Parallel execution requires increasingly complex custom scripts.
* Local or remote caching would provide a measurable reduction in development or CI time.
* Repository-wide task execution becomes difficult to reason about using pnpm alone.

The existence of a monorepo is not itself sufficient justification for adding a task orchestrator.

### Introducing Shared Testing or Configuration Packages

Reconsider creating packages such as:

```text
packages/test-utils
packages/testing-config
packages/typescript-config
packages/eslint-config
```

when there is a demonstrated reusable boundary.

Relevant signals include:

* Multiple workspaces require the same configuration preset.
* Multiple workspaces duplicate substantial test setup.
* Shared utilities have multiple stable consumers.
* Copying configuration or test infrastructure creates measurable maintenance problems.
* Centralized configuration or testing behavior needs to be versioned and consumed as an explicit package.
* The package has a clear owner and public contract.

Duplication alone is not sufficient justification if extracting the package would create unnecessary coupling.

## Deferred Decisions

The following decisions are intentionally outside this ADR:

* Specific frontend test framework.
* Specific backend/API test framework.
* Unit-test colocation strategy.
* Integration-test strategy.
* Contract-testing methodology.
* Performance and load-testing strategy.
* Security-testing strategy.
* Shared test utility design.
* Exact E2E environment lifecycle.
* Exact build/test/lint scripts.
* CI pipeline implementation.
* Whether Atlas eventually uses Turborepo, Nx, or another orchestrator.

These will be addressed by the appropriate future architectural decisions.

## Final Principle

> **Atlas will use pnpm as the repository's package manager and workspace system because explicit dependency ownership is an architectural invariant. Every workspace must declare the dependencies required to build, test, and run it. Internal packages must be consumed through explicit workspace dependencies and public exports. Task orchestration and additional shared packages will be introduced only when measurable complexity justifies them.**

No package manifests or dependencies will be created as part of this ADR. Those belong to the implementation phase after the workspace strategy is approved.
