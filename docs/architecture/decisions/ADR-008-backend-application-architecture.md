# ADR-008: Backend Application Architecture

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-17  
**Last reviewed:** 2026-08-17  
**Canonical owner/source:** ADR-008

## Context

Atlas will eventually contain business capabilities including identity, trading, wallets, ledger, market data, and notifications.

A repository-wide horizontal structure such as:

```text
controllers/
services/
repositories/
models/
```

is simple initially, but business capabilities become scattered across the application. As Atlas grows, ownership of business rules and data becomes difficult to see, and unrestricted cross-domain dependencies become increasingly likely.

The backend architecture therefore needs to establish dependency and ownership rules rather than merely prescribe folders.

The architecture must make it possible to answer:

- Who owns each business rule?
- Which modules may communicate?
- Where do database and Express details belong?
- Where does a transaction begin and end?
- Can financial logic be tested without HTTP or PostgreSQL?
- Can a module later be extracted without rewriting its business behavior?

Express is the accepted HTTP framework for this decision.

A separate documentation reconciliation item will address the roadmap's remaining Fastify reference; it does not change the framework selected by this ADR.

## Decision Drivers

The backend architecture should:

1. organize primarily by business capability;
2. make ownership boundaries visible;
3. isolate business behavior from Express and PostgreSQL;
4. keep application transaction ownership explicit;
5. allow financial invariants to be tested independently of HTTP;
6. prevent unrestricted cross-module persistence access;
7. support synchronous coordination where immediate consistency is required;
8. permit post-commit events for non-critical side effects;
9. keep infrastructure implementation details behind application/domain abstractions;
10. avoid unnecessary Clean Architecture ceremony;
11. preserve a future path to extracting modules;
12. keep the composition root responsible for wiring implementations;
13. make module dependencies explicit and acyclic.

# Decision

Atlas will use a **pragmatic modular monolith organized by business capability**.

Business modules are the primary ownership boundaries:

```text
apps/api/src/
├── app.ts
├── server.ts
├── modules/
│   ├── identity/
│   ├── trading/
│   ├── financial/
│   └── market-data/
├── platform/
└── shared/
```

The exact directory and file names are illustrative. The dependency, ownership, transaction, and communication rules defined by this ADR are normative.

Each business module owns its behavior and publishes a deliberately small public interface.

Within a module, layers are introduced when they protect a meaningful boundary:

```text
module/
├── domain/
├── application/
├── infrastructure/
└── http/
```

A module does not need every layer merely for architectural symmetry.

## 1. Business-Module-First Organization

Atlas will organize backend behavior by business capability rather than by repository-wide technical layers.

For example:

```text
modules/
├── identity/
├── trading/
├── financial/
└── market-data/
```

This makes business ownership visible.

The following repository-wide structure is therefore not the primary architecture:

```text
controllers/
services/
repositories/
models/
```

Technical concerns may exist inside individual modules, but they do not become global buckets that allow unrelated business behavior to spread across the application.

The primary question is:

> Which business capability owns this rule and its persistence behavior?

rather than:

> Which technical layer does this file belong to?

## 2. Pragmatic Layering

Atlas will use layers when they protect a meaningful dependency boundary.

The intended dependency direction is:

```text
HTTP / Express
       ↓
Application use cases
       ↓
Domain behavior

Infrastructure adapters
       ↓ implement ports required by
Application / domain
```

The layers have these responsibilities:

### Domain

Owns business rules and domain behavior.

Domain code must not import:

- Express;
- PostgreSQL clients;
- environment variables;
- logging frameworks;
- infrastructure implementations.

### Application

Owns use-case orchestration and application-level coordination.

Application code:

- coordinates business operations;
- invokes domain behavior;
- coordinates persistence through defined abstractions;
- owns business transaction boundaries;
- coordinates cross-module capabilities where necessary.

### Infrastructure

Implements persistence and external-system adapters required by the application/domain.

Infrastructure depends on application/domain abstractions.

Application and domain code must not depend on infrastructure implementations.

### HTTP

Translates HTTP requests into application commands and application results into HTTP responses.

HTTP handlers are adapters, not business-rule owners.

## 3. Cross-Module Communication

One module must not import another module's internal files.

The following are prohibited:

```text
Trading
  ✕ Financial/internal/repository
  ✕ Financial/internal/service
  ✕ Financial/internal/domain implementation
```

Cross-module access goes through the owning module's public interface.

A module's public interface exposes business capabilities rather than:

- repositories;
- raw database clients;
- PostgreSQL transactions;
- persistence models;
- internal services.

Conceptually:

```text
Trading
   ↓
Financial public capability
```

rather than:

```text
Trading
   ↓
Financial repository
```

Both applications and future extracted services can therefore depend on an explicit capability boundary.

## 4. Module Dependencies Must Be Acyclic

Public interfaces alone do not prevent circular business dependencies.

Atlas therefore requires module dependencies to be explicit and acyclic.

This is prohibited:

```text
Trading → Financial → Trading
```

When two modules appear to require each other, Atlas must:

1. introduce an appropriate orchestrating use case;
2. reconsider responsibility ownership; or
3. use an appropriate event where asynchronous coordination is genuinely suitable.

The initial architectural direction is:

```text
Trading orchestration
        ↓
Financial public capability

Financial core
        ✕
Trading implementation details
```

Financial correctness must not depend on higher-level trading implementation details.

A circular dependency is therefore treated as an architectural signal that ownership or orchestration needs reconsideration rather than as a dependency to be hidden behind additional interfaces.

## 5. Synchronous Versus Asynchronous Cross-Module Coordination

Synchronous public-interface calls are used where immediate consistency is required.

For example, operations participating in a financial invariant should be coordinated synchronously within the owning application transaction.

Post-commit events may handle non-critical consequences such as:

- notifications;
- analytics;
- activity feeds;
- other work that does not determine whether the financial operation is valid.

Asynchronous events must not initially replace atomic coordination for financial invariants.

The distinction is:

```text
Financial invariant
    ↓
Synchronous coordination + one transaction

Post-commit consequence
    ↓
Event/message is appropriate
```

## 6. Cross-Module Transaction Ownership

A business operation may involve multiple modules while still requiring one atomic PostgreSQL transaction.

For example:

```text
PlaceOrder
├── Financial: reserve funds
├── Trading: create order
└── Financial: record ledger consequences
```

The **orchestrating application use case owns the business transaction**.

Platform infrastructure supplies the transaction mechanism, while participating modules join the same transaction through defined application abstractions.

The precise transaction-propagation mechanism is deferred to the future database/infrastructure implementation. The architectural invariant is not deferred:

> Order, reservation, and ledger changes that constitute one financial operation must commit or roll back atomically.

A public module interface must not expose a raw PostgreSQL client or permit consumers to access another module's persistence implementation.

Individual repositories perform persistence operations but do not independently decide the entire business transaction boundary.

The intended model is:

```text
PlaceOrder use case
        ↓
begin business transaction
        ├── Financial capability
        ├── Trading capability
        └── Financial ledger capability
        ↓
commit
```

If any required operation fails, the transaction must roll back the participating changes.

## 7. Database Ownership

Database infrastructure and business persistence ownership are separate concerns.

### `platform/database`

Owns application-wide low-level database infrastructure:

```text
platform/database
├── PostgreSQL pool and connection lifecycle
├── transaction execution mechanism
├── migration execution infrastructure
└── common low-level database instrumentation
```

It must not become a repository for business queries or business data-model knowledge.

### Module infrastructure

Each business module owns its persistence implementation:

```text
module/infrastructure
├── module-owned repository implementations
├── module-owned queries
├── persistence mappings
└── knowledge of the module's data model
```

The API owns the overall migration history as established by the repository/database governance decisions, while each schema change must still have a clear business-module owner.

A module must not bypass another module's ownership by directly querying or modifying another module's tables.

## 8. `platform/` Versus `shared/`

### `platform/`

`platform/` contains application-wide technical infrastructure.

Examples include:

- configuration;
- PostgreSQL connection infrastructure;
- transaction infrastructure;
- logging;
- HTTP middleware;
- other application-wide technical adapters.

Business rules do not belong in `platform/`.

### `shared/`

`shared/` contains genuinely domain-neutral primitives that are useful across modules without creating business ownership ambiguity.

Examples may include small technical or generic primitives that have no business-module owner.

`shared/` must not become a dumping ground for:

- business rules;
- cross-domain services;
- repositories;
- arbitrary helpers that avoid choosing ownership.

When code has meaningful business semantics, it should remain inside the owning module.

## 9. Composition Root

The composition root is responsible for constructing implementations and connecting them to application ports.

Conceptually:

```text
composition root
      ↓
construct infrastructure implementations
      ↓
connect implementations to application ports
      ↓
construct application use cases
      ↓
construct HTTP adapters
```

Business modules should not instantiate their own infrastructure implementations merely to obtain dependencies.

This keeps dependency wiring outside business behavior and makes alternative implementations easier to provide for tests and future deployment contexts.

## 10. `app.ts` Versus `server.ts`

Atlas will keep Express application construction separate from process startup.

```text
app.ts
  → creates/configures the Express application

server.ts
  → loads configuration
  → initializes required resources
  → starts listening
```

`app.ts` must be constructible without entering the production process-startup path or opening a fixed network port.

This allows HTTP tests such as Supertest to exercise the application directly.

The separation also keeps:

- process startup;
- resource lifecycle;
- listening;
- application composition

outside the HTTP application object itself.

The exact dependency-composition and resource lifecycle implementation remains a future backend-infrastructure concern.

## 11. HTTP Boundary

Express request and response objects must not enter domain or application business logic.

The HTTP layer performs translation:

```text
HTTP request
    ↓
HTTP adapter
    ↓
application command/input
    ↓
use case
    ↓
application result
    ↓
HTTP response
```

Allowing Express objects inside application services would couple those services to:

- the Express framework;
- HTTP lifecycle semantics;
- request/response APIs;
- HTTP-specific testing assumptions.

Keeping them at the boundary allows the same application use case to be invoked by non-HTTP mechanisms later and makes business logic easier to test independently.

## 12. Testing Boundary

The architecture supports testing business behavior without requiring HTTP or PostgreSQL.

The intended separation is:

```text
Domain
  → test without Express/PostgreSQL

Application
  → test use cases with controlled ports/adapters

HTTP
  → test HTTP behavior through app.ts

Infrastructure
  → test persistence/external integrations against their appropriate
    infrastructure boundary
```

Financial invariants should not require an Express request to execute.

Database-backed behavior requiring PostgreSQL remains an integration concern rather than becoming a prerequisite for every unit-level domain test.

# Alternatives Considered

## Alternative 1: Repository-Wide Horizontal Layers

```text
controllers/
services/
repositories/
models/
```

### Benefits

- Simple to understand initially.
- Familiar to many developers.
- Easy to create during a small prototype.

### Rejected because

Business capabilities become scattered across global technical folders.

As Atlas grows, ownership becomes harder to see and unrestricted cross-domain dependencies become more likely.

The structure does not make it sufficiently clear which module owns a business rule or persistence model.

## Alternative 2: Strict Clean Architecture Everywhere

Every module would be required to contain entities, use cases, ports, adapters, DTOs, mappers, factories, and separate interfaces.

### Benefits

- Strong dependency isolation.
- Explicit boundaries.
- Highly structured testing seams.

### Rejected because

The ceremony is disproportionate to Atlas's current size and the solo-development constraint.

Atlas will introduce layers where they protect meaningful boundaries rather than requiring every module to have identical architecture.

## Alternative 3: Allow Direct Cross-Module Repository Access

### Rejected because

It bypasses business ownership and couples modules to another module's persistence implementation and data model.

It also makes future extraction substantially harder.

Cross-module interaction must occur through explicit business capabilities.

## Alternative 4: Allow Express Objects in Application Services

### Rejected because

It couples application behavior to Express and HTTP semantics.

This makes business logic harder to invoke outside HTTP and harder to test without framework infrastructure.

## Alternative 5: Let Repositories Own Business Transactions

### Rejected because

A repository generally represents one persistence boundary, while a business transaction may span multiple operations and modules.

For financial operations such as order placement, the application use case must own the transaction boundary so that order, reservation, and ledger changes can be coordinated atomically.

## Alternative 6: Use Asynchronous Events for Cross-Module Financial Coordination

### Rejected as the initial financial coordination model because

Events introduce eventual consistency and cannot by themselves guarantee atomicity across order, reservation, and ledger changes.

Synchronous public capabilities within one transaction are required where immediate financial invariants must hold.

Post-commit events remain appropriate for non-critical consequences.

# Consequences

## Positive Consequences

### Business ownership is visible

A developer can identify the owning module for a business rule and its persistence behavior.

### Dependencies are controlled

Modules cannot bypass public business-capability boundaries to reach internal services or repositories.

### Financial transaction ownership is explicit

Application use cases own business transaction boundaries, including cross-module financial operations.

### Business logic is framework-independent

Domain and application code do not depend on Express or PostgreSQL implementations.

### Testing remains layered

Business behavior can be tested without HTTP or PostgreSQL, while integration and HTTP behavior remain testable at their appropriate boundaries.

### Future extraction remains possible

A well-defined module interface provides a potential extraction boundary without requiring Atlas to become microservices prematurely.

### Infrastructure remains replaceable

Database and external-system implementations remain behind application/domain abstractions.

### Complexity is introduced deliberately

Atlas avoids requiring strict Clean Architecture ceremony, backend bundling, or other abstractions before their value is demonstrated.

## Negative Consequences

### More structure than horizontal layers

Developers must understand module ownership and dependency rules.

### Public interfaces require discipline

Module maintainers must deliberately define and maintain the capabilities exposed to other modules.

### Cross-module transactions require infrastructure support

The eventual database implementation must provide a safe mechanism for participating modules to share the orchestrating transaction.

### Some duplication may be intentional

Keeping business behavior inside its owning module may produce small amounts of repeated technical code rather than prematurely moving it into `shared/`.

### Dependency cycles require architectural decisions

A seemingly convenient cross-module dependency may require responsibility reassignment or orchestration instead of a quick import.

# Deferred Decisions

The following remain outside the scope of ADR-008:

## 1. Exact Transaction Propagation Mechanism

This ADR establishes transaction ownership and atomicity requirements.

The exact mechanism for propagating a PostgreSQL transaction through participating module abstractions is deferred to the database/infrastructure architecture decision.

## 2. Repository Implementation Technology

The exact PostgreSQL client, query library, ORM, or repository implementation approach remains a separate decision.

## 3. Database Schema Design

Table definitions, indexes, constraints, and detailed schema ownership are separate database decisions.

## 4. Migration Tooling

The overall migration ownership model exists, but the exact migration tooling and command implementation remain implementation details unless separately decided.

## 5. Event Infrastructure

This ADR establishes when synchronous coordination versus post-commit events are appropriate.

The event broker, delivery mechanism, retry policy, outbox implementation, and event schema remain separate decisions.

## 6. Exact Module Interfaces

The existence of public module interfaces is architectural. The exact TypeScript interfaces and capability names will evolve with the business modules.

## 7. Exact Folder and File Names

The example directory structure is illustrative.

The architectural rules governing ownership, dependencies, transaction boundaries, and infrastructure isolation are normative.

# Reconsideration Criteria

This architecture should be reconsidered when a measurable problem or material architectural requirement emerges.

Relevant triggers include:

- a module becomes large enough that its internal boundaries require restructuring;
- cross-module coordination becomes difficult to reason about;
- dependency cycles repeatedly appear;
- transaction coordination cannot be implemented safely under the current abstractions;
- build or test boundaries become materially slow;
- a module requires independent deployment or scaling;
- a module has a sufficiently stable public boundary to justify extraction;
- the modular monolith begins creating operational constraints that outweigh its simplicity.

Moving to separately deployed services is not the default response to growth. Extraction should be justified by an actual ownership, scaling, reliability, deployment, or organizational requirement.

# Relationship to Other Decisions

The Node.js runtime baseline is established by:

[ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)

The TypeScript module and execution strategy is established by:

[ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)

The testing toolchain is established by:

[ADR-005 — Sprint 1 Testing Toolchain](ADR-005-sprint-1-testing-toolchain.md)

Testing architecture is established by:

[ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)

Repository and workspace structure are established by:

[ADR-002 — Project Folder Structure](ADR-002-project-folder-structure.md)

Workspace and package-management decisions are established by:

[ADR-003 — Workspace and Package Management Strategy](ADR-003-workspace-and-package-management-strategy.md)

Documentation authority and lifecycle are governed by:

[Documentation Governance](../../governance/documentation-governance.md)

# Status

**Accepted**

Atlas adopts a pragmatic modular-monolith backend organized by business capability.

Business modules own their behavior and persistence knowledge, communicate through explicit public business-capability interfaces, maintain acyclic dependencies, and must not bypass another module's persistence boundary.

Application use cases own business transaction boundaries. Platform infrastructure supplies the transaction mechanism, and participating modules may join the same transaction through defined application abstractions. Financial operations requiring atomicity must commit or roll back atomically.

Express is the accepted HTTP framework. Express application construction remains separate from process startup through `app.ts` and `server.ts`.

The exact transaction-propagation mechanism, database implementation, event infrastructure, and module interface details remain deferred to their appropriate decisions.
