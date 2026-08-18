# ADR-005: Sprint 1 Testing Toolchain

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-16  
**Last reviewed:** 2026-08-16  
**Canonical owner/source:** ADR-005

## Context

Atlas has established a risk-based testing architecture in [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md).
That architecture defines the testing requirements; this ADR selects the Sprint 1 tools that implement those requirements.
Atlas is initially a small pnpm monorepo containing:
- `@atlas/web`
- `@atlas/api`
- `@atlas/contracts`
The toolchain should minimize configuration and operational overhead while preserving clear boundaries between component behavior, HTTP behavior, TypeScript verification, and future browser-level testing.
Exact dependency versions are intentionally deferred until the Node.js runtime baseline is established.

## Decision Drivers

The toolchain should:
1. provide a consistent test-runner model across current workspaces;
2. support TypeScript and ESM without unnecessary transformation infrastructure;
3. integrate naturally with the React/Vite frontend;
4. support Node-based API and contract tests;
5. allow HTTP testing without fixed-port coupling;
6. keep dependencies and configuration workspace-owned;
7. preserve the distinction between test execution and TypeScript verification;
8. defer E2E infrastructure until a meaningful cross-application journey exists;
9. defer coverage infrastructure until it provides useful engineering information;
10. remain simple enough for a solo developer to operate and maintain.

# Decision

Atlas will use **Vitest as the common test runner** for the web, API, and contracts workspaces.

### Selected now

- Vitest
- jsdom
- React Testing Library
- user-event
- applicable DOM matchers
- Supertest

### Deferred

- E2E runner
- Coverage provider and installation
- Exact dependency versions
- PostgreSQL provisioning and isolation

### Toolchain

| Workspace | Test runner | Environment | Supporting tools |
|---|---|---|---|
| `@atlas/web` | Vitest | jsdom | React Testing Library, user-event, DOM matchers |
| `@atlas/api` | Vitest | Node | Supertest |
| `@atlas/contracts` | Vitest | Node | — |
| `@atlas/e2e` | Deferred | Real browser | Not selected |
`@atlas/e2e` is a reserved future workspace location. It is not part of the installed Sprint 1 toolchain.

## 1. Vitest as the Common Test Runner

Use Vitest for:
- `@atlas/web`
- `@atlas/api`
- `@atlas/contracts`
The decision is primarily about consistency and reduced configuration complexity, not a claim that Vitest is universally superior to other runners.
A common runner provides one repository convention for:
- test execution;
- assertions;
- mocking;
- configuration;
- reporting;
- workspace commands;
- developer workflow.
For the current repository size, that consistency outweighs the benefits of introducing specialized runners.

### Vitest versus `node:test`

Node's built-in `node:test` runner is technically capable of testing the API and contracts. Using it only for backend work would create separate testing conventions:
```text
@atlas/web
    → Vitest
@atlas/api
    → node:test
@atlas/contracts
    → Vitest
```
Atlas does not currently have a demonstrated backend requirement that justifies the additional runner, configuration, mocking, and reporting conventions.

### Vitest versus Jest

Jest is a mature and capable testing platform. It is not selected because Atlas's frontend is based on Vite and the repository uses TypeScript/ESM.
Atlas prefers the simpler alignment:
```text
Vite application
        ↓
     Vitest
```
rather than maintaining a separate Jest transformation/configuration path without a demonstrated need.
This is a complexity decision, not an ecosystem-quality judgment.

## 2. Web Testing Environment

`@atlas/web` uses Vitest with a jsdom environment for component-level browser behavior.
React Testing Library, user-event, and applicable DOM matchers provide the supporting component-testing tools.
jsdom is appropriate for fast tests of behavior such as:
- rendering;
- form interaction;
- validation;
- loading and error states;
- empty states;
- conditional rendering;
- component state transitions;
- DOM-visible behavior;
- accessible element discovery;
- keyboard-oriented behavior where jsdom provides sufficient fidelity.
jsdom is not a complete browser. It does not provide full validation of layout, rendering, browser-specific behavior, navigation, or complete browser API fidelity.
Atlas will not compensate by building increasingly complex browser mocks. Behavior that requires a real browser belongs in future E2E coverage.
The boundary is therefore:
```text
Component behavior
        ↓
      jsdom
Real browser behavior
        ↓
    Browser E2E
```
Authentication follows the same boundary principle: individual rules belong in unit tests, endpoint behavior in API tests, persistence behavior in integration tests, and browser redirects/session journeys in E2E tests where required. The detailed classification remains owned by the Testing Strategy.

## 3. React Testing Library

React Testing Library is the selected library for web component testing.
Tests should interact with and assert against the UI through behavior that resembles user interaction rather than depending on React implementation details.
The preferred pattern is:
```text
Find accessible control
        ↓
Perform user interaction
        ↓
Observe resulting UI behavior
```
Tests should avoid unnecessary coupling to component internals, private methods, or implementation-specific state.

## 4. API Testing

`@atlas/api` uses Vitest with Supertest for HTTP-level API behavior.
The Express application must be constructible for HTTP testing without invoking the production startup path or managing a fixed test port.
The intended boundary is:
```text
createApp(dependencies)
        ↓
configures Express application
startServer()
        ↓
production runtime lifecycle
        ↓
listen()
```
Tests use:
```text
createApp(...)
        ↓
Supertest
        ↓
HTTP behavior
```
Supertest may internally create and manage an ephemeral listener where appropriate.
The exact dependency-composition, startup, shutdown, worker, and database-pool lifecycle is outside the scope of this ADR and belongs to the future backend-architecture decision.

## 5. Contracts Testing

`@atlas/contracts` uses Vitest in the Node environment.
Schema tests verify individual schema behavior, including valid inputs, invalid inputs, and relevant boundary values.
Atlas distinguishes:
```text
Schema test
    → Does the schema behave correctly?
API test
    → Does the endpoint enforce the expected runtime behavior?
Producer/consumer contract test
    → Do independently interacting sides agree on
      externally observable behavior?
```
Shared schema code can support contract compatibility, but shared code alone is not sufficient evidence that runtime producer and consumer behavior is compatible.
The detailed contract-testing strategy remains owned by the Testing Strategy.

## 6. TypeScript Verification

Vitest transforms TypeScript for test execution, but test execution is not equivalent to TypeScript type-checking.
Atlas therefore keeps TypeScript verification separate:
```text
Vitest
    → executes tests
TypeScript compiler
    → checks type correctness
```
The repository's canonical verification command remains:
```text
pnpm verify
```
Its exact script composition remains a repository-scaffolding concern. The command contract established by the testing architecture remains authoritative.

## 7. Coverage

Coverage is a diagnostic and regression signal, not proof of correctness.
Atlas defers coverage-provider adoption and installation until meaningful coverage reporting is required.
When coverage tooling is introduced, Vitest's V8 coverage provider is the preferred candidate.
No global numerical coverage threshold is established by this ADR.
The detailed coverage policy remains owned by the Testing Strategy.

## 8. E2E Tooling

E2E execution remains separate from the normal test suite.
The command contract is:
```text
pnpm test
    → non-E2E workspace tests
pnpm test:e2e
    → cross-application browser tests
pnpm verify
    → mandatory static checks + non-E2E tests
```
Playwright is the leading candidate for future E2E tooling because it provides real-browser execution appropriate for cross-application testing.
It is not installed during Sprint 1 merely to create an empty E2E workspace.
It should be introduced when Atlas has a meaningful cross-application journey requiring a real browser, for example:
```text
Browser
  ↓
Web
  ↓
API
  ↓
PostgreSQL
```
The E2E suite should remain focused on high-value system behavior.

## 9. Workspace-Owned Configuration

Each workspace owns its testing configuration and dependencies.
For example:
```text
apps/web/
    package.json
    vitest.config.ts
apps/api/
    package.json
    vitest.config.ts
packages/contracts/
    package.json
    vitest.config.ts
```
The root repository invokes workspace commands through pnpm.
Atlas does not initially create shared testing packages such as:
```text
packages/testing-config
packages/test-utils
```
unless stable duplication demonstrates that a reusable boundary is justified.
Shared infrastructure should emerge from demonstrated need rather than speculative abstraction.
`@atlas/e2e` is a reserved future workspace location. It is not part of the installed Sprint 1 toolchain and does not require Playwright or another E2E runner during Sprint 1.

## 10. Dependency Ownership

Every workspace must explicitly declare the testing dependencies it requires.
For example:
```text
@atlas/web
    → vitest
    → React Testing Library
    → user-event
    → applicable DOM matchers
@atlas/api
    → vitest
    → supertest
@atlas/contracts
    → vitest
```
Dependencies must not be relied upon merely because they happen to be visible through another workspace.
This follows the existing Atlas dependency principle:
> A package manifest is an architectural declaration of what that workspace requires.

# Alternatives Considered

## Alternative 1: Vitest for web and `node:test` for API

### Benefits

- Uses Node's built-in runner for backend code.
- Avoids a dedicated runner dependency in the API workspace.
- Provides a technically capable backend testing solution.

### Rejected because

It introduces two testing conventions, including separate test APIs, mocking conventions, configuration approaches, reporting behavior, and developer workflows.
The current repository does not have a demonstrated requirement that justifies that complexity.

## Alternative 2: Jest everywhere

### Benefits

- Mature ecosystem.
- Broad community familiarity.
- Large existing library ecosystem.
- Established mocking and testing conventions.

### Rejected because

Atlas uses Vite for the web application and TypeScript/ESM across the repository. Jest would introduce another transformation/configuration path for the frontend instead of aligning the runner with the Vite-based environment.
This is not a judgment that Jest is incapable of supporting Atlas.

## Alternative 3: Different specialized runners by workspace

For example:
```text
@atlas/web
    → Vitest
@atlas/api
    → node:test
@atlas/contracts
    → another specialized runner
```

### Rejected because

The current repository is too small to justify multiple testing systems.
Specialization should be introduced only when a demonstrated technical requirement outweighs the operational cost of additional conventions.

## Alternative 4: Install Playwright during Sprint 1

### Benefits

- Establishes browser-testing infrastructure immediately.
- Allows E2E conventions to be created early.
- Provides real-browser capability.

### Rejected because

Atlas does not yet have a meaningful cross-application journey requiring browser automation.
Installing Playwright before such a journey exists would introduce browser binaries, configuration, CI infrastructure, and maintenance requirements without immediate testing value.
Playwright remains the leading candidate for future E2E tooling.

## Alternative 5: Install coverage tooling immediately

### Benefits

- Coverage reports are available from the beginning.
- Developers can observe coverage while the repository grows.

### Rejected because

Early coverage numbers provide limited useful information before meaningful application behavior has been established.
Coverage is a diagnostic signal rather than a correctness guarantee.

# Consequences

## Positive Consequences

### One test-runner model

Web, API, and contracts use Vitest, reducing the number of runner conventions a developer must maintain.

### Reduced configuration complexity

Atlas avoids maintaining separate Vitest and `node:test` systems.

### Vite alignment

The React application uses a testing toolchain aligned with its Vite environment.

### Explicit HTTP-testing boundary

The Express application can be tested without invoking the production startup path or managing a fixed test port.

### Clear browser boundary

jsdom handles fast component-level browser behavior, while real browser behavior is reserved for E2E tests.

### Explicit type verification

Vitest remains responsible for test execution while TypeScript remains responsible for static type verification.

### Deferred infrastructure

Atlas does not introduce Playwright, browser binaries, coverage infrastructure, or shared testing packages until demonstrated need exists.

## Negative Consequences

### Vitest becomes a repository convention

Future workspaces will normally use Vitest unless a later decision establishes a compelling reason to use another runner.

### jsdom is not a real browser

Some browser behavior cannot be validated reliably in jsdom and will require real-browser testing when such behavior becomes important.

### Coverage visibility is initially limited

Automated coverage reporting is unavailable until coverage tooling is deliberately introduced.

### Future specialization may require another tool

A future domain may introduce requirements poorly served by the current toolchain. Adding another runner would then create additional operational complexity.

### Application-construction discipline is required

The API must preserve the boundary between application construction and runtime process lifecycle. Tests must not accidentally reintroduce production startup behavior through imports.

# Deferred Decisions

The following decisions are intentionally outside the scope of ADR-005.

## 1. Node.js Runtime Baseline

The exact Node.js version is not yet established.
Exact test-tool dependency versions must wait until the runtime baseline is selected.
```text
Node.js runtime baseline
        ↓
supported package versions
        ↓
workspace dependencies
```

## 2. Exact Dependency Versions

This ADR selects tools, not exact versions.
Exact versions for Vitest, React Testing Library, user-event, DOM matchers, jsdom, and Supertest will be selected after the Node.js runtime baseline is established.

## 3. PostgreSQL Provisioning

ADR-004 requires real PostgreSQL whenever correctness depends on PostgreSQL semantics.
ADR-005 does not choose how PostgreSQL is provisioned.
Candidates include:
- developer-installed PostgreSQL;
- dedicated test database;
- Docker Compose;
- Testcontainers;
- CI-provided PostgreSQL service.
That decision must address test database safety, isolation, cleanup, migration application, concurrent execution, and CI behavior.

## 4. PostgreSQL Test Isolation

The exact isolation model remains deferred.
The eventual strategy must determine whether tests receive an isolated database, isolated schema, transaction-level isolation, or another explicitly safe mechanism.
Test execution must not be able to accidentally target development or production databases.

## 5. E2E Runner

Playwright is the leading candidate but is not formally selected or installed as the Sprint 1 E2E toolchain.
Selection should occur when Atlas introduces its first meaningful cross-application browser journey.

## 6. Coverage Tooling

Coverage tooling remains deferred.
When introduced, Vitest's V8 coverage provider is the preferred option. Provider installation and adoption remain separate from the current runner decision.

## 7. Shared Testing Packages

No shared `packages/testing-config` or `packages/test-utils` package is created during Sprint 1 unless stable duplication demonstrates a reusable boundary.

# Reconsideration Criteria

The testing toolchain should be reconsidered when a measurable problem or new requirement emerges.
Relevant triggers include:
- **Runtime incompatibility:** the selected tools no longer adequately support the established Node.js runtime, module system, or application architecture.
- **Configuration complexity:** Vitest configuration becomes sufficiently complex across workspaces that another architecture would materially reduce maintenance cost.
- **Workspace specialization:** a workspace develops requirements that cannot reasonably be satisfied by Vitest without disproportionate complexity.
- **Developer productivity:** test execution, debugging, watch mode, or feedback becomes a material engineering bottleneck.
- **Ecosystem requirement:** a critical dependency or framework requires testing capabilities that cannot reasonably be provided through the selected toolchain.
- **E2E requirement:** Atlas introduces a meaningful cross-application browser journey, activating the reserved `@atlas/e2e` workspace.
- **Coverage requirement:** the repository reaches a stage where coverage reporting provides meaningful engineering or regression-detection value.
- **Operational scale:** the number of workspaces, CI lanes, or testing requirements grows enough that the current single-runner model creates measurable limitations.
Reconsideration must evaluate the total operational cost of changing the toolchain, including:
- developer learning;
- configuration;
- CI;
- local setup;
- reporting;
- debugging;
- dependency maintenance;
- migration cost.
A tool should not be introduced merely because it offers a technically interesting capability.

# Relationship to Other Decisions

This ADR implements the testing architecture established by:
[ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
Operational testing procedures are maintained in:
[Testing Strategy](../../engineering/testing-strategy.md)
Repository and workspace structure are governed by:
[ADR-002 — Project Folder Structure](ADR-002-project-folder-structure.md)
Workspace and package-management decisions are governed by:
[ADR-003 — Workspace and Package Management Strategy](ADR-003-workspace-and-package-management-strategy.md)
Documentation authority and lifecycle are governed by:
[Documentation Governance](../../governance/documentation-governance.md)

