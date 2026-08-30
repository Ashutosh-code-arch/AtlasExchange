# ADR-010: PostgreSQL Access, Transaction, and Migration Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-17  
**Last reviewed:** 2026-08-17  
**Canonical owner/source:** ADR-010

## Context

Atlas must persist balances, orders, trades, and ledger records without:

- precision loss;
- partial financial updates;
- hidden queries;
- schema drift;
- cross-module table ownership violations;
- unreproducible development and test databases.

PostgreSQL constraints and transactions remain the final database enforcement boundary. The database access library must assist correctness without hiding the SQL, transaction, locking, and persistence behavior that Atlas needs to understand and control.

ADR-008 establishes that application use cases own business transaction boundaries. This ADR connects that architectural rule to PostgreSQL connection, query, transaction, financial-value, and migration behavior.

## Decision Drivers

Atlas's database strategy should:

1. retain strong visibility into PostgreSQL behavior and SQL;
2. provide useful TypeScript safety without introducing excessive ORM abstraction;
3. keep persistence implementation details inside infrastructure;
4. preserve business-module ownership of persistence behavior;
5. provide one reproducible migration history;
6. make financial atomicity explicit;
7. prevent persistence types from leaking into application/domain code;
8. preserve exact financial values;
9. make database-dependent tests reproducible against real PostgreSQL;
10. establish safe query and constraint practices;
11. defer detailed concurrency policies until the relevant financial use cases are designed.

# Decision

Atlas will use **PostgreSQL with `node-postgres` (`pg`) and Kysely**.

The intended architecture is:

```text
PostgreSQL
    ↑
node-postgres connection pool
    ↑
Kysely query/transaction layer
    ↑
module-owned repository implementations
    ↑
application use cases
```

Kysely provides typed SQL construction while remaining close to SQL and allowing raw SQL where PostgreSQL-specific behavior is clearer. `pg` provides direct PostgreSQL connection and transaction behavior.

This decision does not claim that Kysely, `pg`, or PostgreSQL automatically make financial operations correct. Financial correctness still depends on constraints, transaction boundaries, concurrency controls, idempotency, and explicit domain invariants.

## 1. Database Access Technology

### Kysely

Kysely is selected because it provides:

- SQL-like, type-safe query construction;
- PostgreSQL support;
- transaction support;
- access to raw SQL when necessary;
- less abstraction from SQL than a full ORM.

Atlas should remain able to reason directly about:

- joins;
- indexes;
- constraints;
- CTEs;
- row locking;
- PostgreSQL-specific operators and functions;
- transaction behavior.

### `node-postgres`

`pg` owns the low-level PostgreSQL connection and pool behavior.

Transactions must use one checked-out PostgreSQL client for the entire transaction. Repository code must not use independent pool queries while participating in an active transaction.

Atlas must not treat `pool.query()` as a substitute for transaction-scoped execution.

### Why not raw `pg` alone?

Raw `pg` provides maximum SQL visibility but leaves Atlas responsible for more manual query typing, result mapping, and query composition infrastructure.

Kysely provides useful TypeScript safety without hiding the SQL model Atlas needs to understand.

### Why not Drizzle?

Drizzle is a credible alternative and provides strong schema-as-code integration and migration tooling.

It is not selected initially because Atlas's current priority is maintaining direct visibility into SQL and PostgreSQL behavior while avoiding unnecessary schema-generation coupling.

A future requirement for tighter schema-as-code integration could justify reconsideration.

### Why not Prisma?

Prisma provides strong generated-client productivity and an integrated schema/migration experience.

It is not selected because its higher abstraction level is less aligned with Atlas's requirement to understand and deliberately control SQL, locking, constraints, transactions, and exchange persistence behavior.

## 2. Connection Pool Ownership

Atlas creates one bounded PostgreSQL connection pool per API process.

The lifecycle is:

```text
server startup
      ↓
create pool
      ↓
construct database/query layer
      ↓
construct modules
      ↓
start HTTP server

shutdown signal
      ↓
stop accepting work
      ↓
drain HTTP server
      ↓
close database pool
```

Pool limits and timeouts are configuration-owned and must not be scattered across repositories.

Pool exhaustion should eventually be observable.

Repositories must release transaction-scoped clients correctly through the transaction mechanism.

The exact pool-size values and timeout defaults are implementation decisions.

## 3. Transaction Ownership and Execution

Application use cases own business transaction boundaries.

The architectural model is:

```text
Application use case
        ↓
TransactionRunner.execute(...)
        ↓
one checked-out PostgreSQL connection
        ↓
all participating repositories use that transaction
        ↓
commit or rollback
```

Rules:

- application use cases own business transaction boundaries;
- platform infrastructure provides transaction execution;
- repositories execute through the active transaction;
- application and domain code do not receive raw database clients;
- participating modules may join the same transaction;
- repositories must never silently start independent transactions inside a larger use case;
- external network calls should generally not occur while a database transaction remains open.

For example:

```text
PlaceOrder use case
├── Financial: reserve funds
├── Trading: create order
└── Financial: record ledger consequences
```

These changes may participate in one PostgreSQL transaction even though Trading and Financial retain ownership of their own persistence implementations.

### Cross-Module Transaction Rule

The orchestrating application use case owns the business transaction.

Platform infrastructure supplies the transaction mechanism, and participating modules join the same transaction through defined application-facing abstractions.

Public module interfaces must not expose a raw PostgreSQL client or permit direct access to another module's persistence implementation.

For financial operations:

> Order, reservation, and ledger changes that constitute one financial operation must commit or roll back atomically.

Asynchronous events must not initially replace atomic coordination for financial invariants.

Post-commit events may handle non-critical consequences such as:

- notifications;
- analytics;
- other work that does not determine financial correctness.

### Persistence-Type Isolation

`TransactionRunner`, repository interfaces, and application-facing transaction abstractions must not expose:

- `pg` clients;
- Kysely instances;
- Kysely transaction types;
- SQL fragments;
- database row types.

These types may be used internally by infrastructure.

Application and domain code must depend on business/application abstractions rather than persistence-library types.

## 4. Query Safety and Database Constraints

All database queries must use parameter binding.

Untrusted values must never be interpolated directly into SQL.

Kysely's type visibility does not grant permission to query another module's tables.

A module may access only the persistence structures that it owns or those exposed through an explicitly approved database boundary.

Database constraints must protect invariants that PostgreSQL can enforce.

Examples include appropriate:

- `NOT NULL` constraints;
- uniqueness constraints;
- foreign keys where ownership permits;
- check constraints;
- appropriate numeric/domain restrictions.

Application validation remains necessary, but database constraints are the final enforcement boundary for invariants PostgreSQL can enforce.

Repository results must be mapped into domain/application representations rather than leaking database rows.

## 5. Schema and Module Ownership

A central PostgreSQL database does not imply unowned tables.

The division is:

```text
platform/database
├── pool lifecycle
├── transaction mechanism
├── migration runner
└── common low-level database instrumentation

module/infrastructure
├── module-owned repository implementations
├── module-owned queries
├── persistence mappings
└── knowledge of the module's data model
```

`platform/database` must not become a repository or business-query dumping ground.

Business-module infrastructure owns knowledge of its persistence model.

Kysely types and database access do not override business ownership. A repository cannot query another module's tables merely because the database connection technically permits it.

Public module interfaces expose business capabilities rather than repositories or database primitives.

## 6. Migration Strategy

Atlas maintains **one globally ordered API migration history**.

Migrations belong to:

```text
apps/api/migrations/
```

Each migration has a clear business-module owner, but module ownership does not create separate migration streams, databases, or independent migration runners.

All migrations are:

- committed to Git;
- globally ordered;
- applied by one migration mechanism;
- recorded in one migration ledger;
- reviewed before application;
- treated as immutable after being applied.

Conceptually:

```text
Atlas API migration history
        │
        ├── migration 001 — owner: identity
        ├── migration 002 — owner: financial
        ├── migration 003 — owner: trading
        └── migration 004 — owner: market-data
```

The exact migration filename convention and tooling remain implementation details.

### Migration Execution

The API must not automatically perform migrations during ordinary startup.

Recommended execution model:

```text
Build/deploy
    ↓
run migration step
    ↓
verify migration result
    ↓
start API
```

Production migrations are a separate deployment step.

Development environments use explicit migration commands.

Shared and production environments must not use schema-push synchronization.

Database-dependent integration tests build their schema from the committed migration history using real PostgreSQL, consistent with ADR-004.

Migration execution must prevent two deployments from applying the same migration set concurrently.

The exact locking mechanism remains an implementation detail.

### Migration Immutability

Previously applied migrations must not be edited.

If migration `N` is incorrect in production:

```text
migration N
   ↓
already applied
   ↓
do not edit N
   ↓
create migration N+1
   ↓
repair schema/data forward
```

Down migrations may be useful for local development, but automatic production rollback is not the default strategy.

Destructive schema changes require explicit analysis of:

- data preservation;
- compatibility;
- deployment ordering;
- rollback/recovery;
- active application versions.

### Schema Push

Schema-push synchronization is not permitted for shared or production environments.

The committed migration history is authoritative for reproducible schema evolution.

If a TypeScript schema representation is introduced later, it must not silently replace or bypass the committed migration history.

## 7. Financial Value Representation

JavaScript `number` must not represent authoritative:

- asset quantities;
- prices;
- fees;
- ledger amounts;
- other financially authoritative decimal values.

The boundary is:

```text
PostgreSQL NUMERIC
        ↓
database adapter: string
        ↓
domain: explicit decimal/financial value object
        ↓
API contract: canonical decimal string
```

Authoritative financial values cross JSON transport boundaries as **canonical decimal strings**, never JSON numbers.

Parsing, validation, scale enforcement, and formatting occur explicitly at system boundaries.

The database adapter must preserve PostgreSQL `NUMERIC` values without silently converting arbitrary values to JavaScript floating-point numbers.

The exact precision and scale are selected per financial concept and are not globally guessed by this ADR.

For example, the precision requirements for:

- asset quantity;
- price;
- fee;
- ledger amount;

may differ and must be explicitly defined by the relevant financial-domain decision.

## 8. Application and Domain Boundaries

The dependency direction remains:

```text
Application
    ↓
domain/application abstractions
    ↓
infrastructure implementations
    ↓
Kysely / pg
    ↓
PostgreSQL
```

Domain and application code must not depend on:

- Express;
- PostgreSQL clients;
- Kysely;
- environment variables;
- database row representations.

The composition root constructs infrastructure implementations and connects them to application abstractions.

Repositories are infrastructure implementations of application/domain persistence needs.

Repository interfaces must not become a generic database API.

# Alternatives Considered

## Alternative 1: Raw `pg`

### Benefits

- Maximum SQL visibility.
- Direct control over PostgreSQL behavior.
- Minimal abstraction.

### Rejected because

Atlas would need to build more manual TypeScript query/result typing and composition infrastructure.

Kysely provides useful type safety while retaining SQL visibility and raw-SQL escape hatches.

## Alternative 2: Drizzle + `pg`

### Benefits

- Strong TypeScript schema integration.
- Inferred types.
- Transaction support.
- Generated, reviewable SQL migrations.

### Rejected initially because

Atlas does not currently require stronger schema-as-code coupling.

The project prioritizes direct SQL visibility and deliberate PostgreSQL understanding.

Drizzle remains a viable reconsideration candidate if schema-code integration becomes a demonstrated requirement.

## Alternative 3: Prisma

### Benefits

- Generated type-safe client.
- Strong developer experience.
- Integrated schema and migration tooling.
- Mature ecosystem.

### Rejected because

Its abstraction is less aligned with Atlas's requirement for explicit control and understanding of SQL, locking, constraints, transaction behavior, and exchange persistence.

## Alternative 4: Automatic API-Startup Migrations

### Benefits

- Convenient development workflow.
- Fewer explicit deployment steps.

### Rejected because

Startup migration introduces schema-change responsibilities into ordinary process startup and creates unsafe deployment coordination.

Production migration execution belongs to the deployment process, not API startup.

## Alternative 5: Schema Push as the Primary Schema Strategy

### Benefits

- Fast local iteration.
- Low migration ceremony.

### Rejected because

Atlas requires reproducible schema history, reviewed changes, and controlled production evolution.

Schema push is therefore unsuitable as the shared/production schema authority.

# Consequences

## Positive Consequences

### SQL remains visible

Developers can reason directly about PostgreSQL queries, constraints, joins, indexes, locking, and transactions.

### TypeScript safety improves

Kysely catches many query and result-shape mistakes without turning persistence into an opaque generated ORM client.

### Transaction ownership is explicit

Business use cases define atomic financial operations while infrastructure handles PostgreSQL mechanics.

### Persistence boundaries remain clean

Database-specific types and query objects remain inside infrastructure.

### Financial precision is preserved

Authoritative financial values are not represented as JavaScript floating-point numbers.

### Schema evolution is reproducible

One committed migration history provides a deterministic schema evolution path.

### PostgreSQL remains the enforcement boundary

Constraints and transactions provide database-level protection for invariants that can be enforced there.

### Testing matches production database behavior

Database-dependent integration tests use real PostgreSQL and reconstruct the schema from committed migrations.

## Negative Consequences

### More infrastructure code

Atlas must define transaction abstractions, mappings, migration execution, and financial value handling rather than relying on an ORM to hide them.

### SQL expertise is required

Developers must understand PostgreSQL behavior instead of relying entirely on generated queries.

### Migration discipline is required

Applied migrations cannot simply be edited after production use.

### Cross-module transactions require deliberate coordination

Trading and Financial can participate in one transaction, but their repositories must accept the same transaction context through an explicit abstraction.

### Financial serialization is more deliberate

Canonical decimal strings require explicit parsing and formatting rather than convenient JSON numbers.

### Concurrency remains complex

A transaction provides atomicity but does not by itself solve all race conditions.

# Deferred Decisions

The following remain outside the scope of ADR-010:

## 1. Transaction Isolation Level

Atlas has not selected a universal PostgreSQL isolation level.

## 2. Row-Locking Strategy

Use-case-specific locking decisions remain deferred.

## 3. Optimistic Concurrency

Versioning, compare-and-swap, or other optimistic concurrency strategies remain deferred.

## 4. Deadlock Detection and Retry

The exact detection, classification, and retry policy remains deferred.

## 5. Use-Case Idempotency

Idempotency requirements and keys for individual financial operations remain deferred.

## 6. Financial Precision and Scale

Exact precision and scale for each financial concept remain deferred.

## 7. Pool Sizing

Exact pool limits, connection timeouts, and operational thresholds remain implementation decisions.

## 8. Transaction Context Propagation

The exact mechanism by which a transaction-scoped infrastructure context is propagated across participating repositories remains an implementation decision.

## 9. Migration Tooling Details

The selected migration mechanism, command composition, filenames, and deployment integration remain implementation details.

## 10. Financial Concurrency Policy

Every financial use case must assess concurrent execution explicitly.

The default PostgreSQL isolation level must not be assumed sufficient merely because the work runs inside a transaction.

For each financial use case, the relevant decision must consider:

- concurrent operations;
- possible races;
- invariant protection;
- locking or optimistic concurrency;
- idempotency;
- retry behavior.

# Reconsideration Criteria

This ADR should be reconsidered when measurable requirements emerge.

Relevant triggers include:

- Kysely's abstraction becomes a material limitation for required PostgreSQL features;
- schema-as-code becomes a demonstrated organizational requirement;
- generated ORM productivity materially outweighs SQL-control requirements;
- database topology requires multiple independently managed databases;
- transaction coordination becomes too complex for the current abstraction;
- operational scale requires different pool or connection-management architecture;
- migration throughput or deployment constraints require a different migration mechanism;
- financial workloads expose concurrency requirements not addressed by the current architecture.

A different database library must not be introduced merely because it is popular or more convenient.

# Relationship to Other Decisions

The backend application architecture is established by:

[ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)

The TypeScript module, execution, and build strategy is established by:

[ADR-007 — TypeScript Module, Execution, and Build Strategy](ADR-007-typescript-module-execution-and-build-strategy.md)

The Node.js runtime baseline is established by:

[ADR-006 — Node.js Runtime Baseline](ADR-006-nodejs-runtime-baseline.md)

The testing toolchain is established by:

[ADR-005 — Sprint 1 Testing Toolchain](ADR-005-sprint-1-testing-toolchain.md)

Testing architecture is established by:

[ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)

PostgreSQL backup, restore, and post-restore validation are established by:

[ADR-064 — PostgreSQL Backup, Restore, and Recovery Validation](ADR-064-postgresql-backup-restore-and-recovery-validation.md)

Workspace and package-management decisions are established by:

[ADR-003 — Workspace and Package Management Strategy](ADR-003-workspace-and-package-management-strategy.md)

Repository structure and migration ownership are governed by the relevant repository/database decisions.

# Status

**Accepted**

Atlas adopts PostgreSQL with `node-postgres` (`pg`) and Kysely.

Application use cases own business transaction boundaries. Platform infrastructure provides transaction execution, while module-owned repositories participate through application-facing abstractions without exposing PostgreSQL or Kysely types.

Atlas maintains one globally ordered, Git-committed API migration history. Applied migrations are immutable, production migrations run separately from ordinary API startup, and shared/production environments do not use schema push.

Authoritative financial values use PostgreSQL `NUMERIC`, explicit decimal/financial representations in the domain, and canonical decimal strings across JSON transport boundaries.

Concurrency, idempotency, exact financial precision/scale, and other detailed database policies remain explicit follow-up decisions.
