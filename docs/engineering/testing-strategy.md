# Atlas Testing Strategy

**Classification:** Canonical
**Status:** Active
**Last reviewed:** 2026-08-24
**Canonical architecture:** ADR-004
<!-- **Owner scope:** Operational testing policy -->

---

Test-data security

Test environments must never use production credentials or unprotected production user or financial data. Prefer synthetic or explicitly sanitized data. Secrets must not be committed to fixtures, exposed in test output, or logged by test infrastructure.

Manual exploratory testing

Manual exploratory testing complements automated evidence and is useful for discovering unexpected behavior, usability issues, and integration problems. It does not replace required automated regression tests.

Accessibility testing

Meaningful web features must receive applicable accessibility validation, including semantic structure, keyboard operation, and accessible names. Exact accessibility tooling remains deferred.

Migration upgrades

Add to the PostgreSQL/migration policy:

As Atlas establishes supported schema versions, migration testing must eventually cover both applying the complete migration history to an empty database and upgrading supported prior schema states to the current schema.


## 1. Purpose and Scope

This document defines how Atlas engineers apply the testing architecture established by ADR-004.

ADR-004 answers:

> Why does Atlas use this testing architecture?

This document answers:

> How do we apply it while building Atlas?

The strategy covers:

* workspace test ownership;
* test organization;
* test classification;
* command usage;
* dependency substitution;
* PostgreSQL testing;
* test data;
* deterministic execution;
* financial-invariant traceability;
* coverage;
* code review;
* flaky tests;
* CI;
* Sprint 1 requirements;
* future financial-domain testing.

This document is intentionally operational.

It may evolve as Atlas gains implementation experience without changing the architectural decisions recorded in ADR-004.

---

# 2. Governing Principles

## 2.1 Test Risk, Not Lines of Code

The amount of testing should correspond to the consequence and probability of failure.

High-risk financial behavior receives stronger testing than low-risk presentation logic.

---

## 2.2 Test at the Boundary Where Risk Exists

Examples:

| Risk                            | Preferred validation   |
| ------------------------------- | ---------------------- |
| Pure calculation                | Unit                   |
| Schema acceptance/rejection     | Schema test            |
| HTTP behavior                   | API                    |
| PostgreSQL transaction          | Integration            |
| Migration correctness           | Migration/integration  |
| Concurrent balance update       | PostgreSQL concurrency |
| Producer/consumer compatibility | Contract               |
| User-visible React behavior     | Component              |
| Critical browser journey        | E2E                    |

A test can belong to multiple classifications.

---

## 2.3 Prefer Focused Tests

A test should exercise the smallest boundary capable of proving the behavior.

Do not use an E2E test to prove a pure calculation.

Do not mock PostgreSQL when PostgreSQL behavior is the thing being tested.

Do not test implementation details when observable behavior is sufficient.

---

## 2.4 Real Dependencies When Their Semantics Matter

Use real infrastructure when correctness depends on infrastructure semantics.

For Atlas, PostgreSQL is the primary example.

---

## 2.5 Determinism Is a Requirement

Tests should not depend accidentally on:

* current wall-clock time;
* uncontrolled randomness;
* generated identifiers;
* live market data;
* unstable external state.

---

## 2.6 Financial Correctness Requires Explicit Evidence

Financial invariants must be traceable from:

```text
business requirement
→ scenario
→ test
→ implementation boundary
→ CI result
```

Coverage percentage alone is insufficient.

---

# 3. Test Classification and Overlap

Atlas uses the following classifications:

```text
Preventive checks
├── Types
├── Lint
├── Formatting
└── Dependency boundaries

Application behavior
├── Unit
├── Schema
├── Component
└── API

Infrastructure behavior
├── PostgreSQL integration
├── Migrations
└── Concurrency

Compatibility
└── Producer/consumer contracts

System behavior
└── E2E

Cross-cutting validation
├── Performance
└── Security
```

These are classifications, not a mandatory hierarchy.

For example:

```text
API test + PostgreSQL
```

may simultaneously be:

```text
API
+
Integration
+
PostgreSQL behavior
```

Do not create duplicate tests solely because a test has multiple classifications.

---

# 4. Workspace Test Ownership

Atlas currently uses these ownership boundaries:

```text
apps/web/tests/
    → frontend-owned tests

apps/api/tests/
    → backend/API-owned tests

packages/contracts/tests/
    → contract/schema-owned tests

tests/e2e/
    → repository-level cross-application tests
```

When a workspace owns a behavior, its tests should normally live with that workspace.

Cross-application behavior belongs under:

```text
tests/e2e/
```

This keeps ownership aligned with repository boundaries.

---

# 5. File Placement Policy

## Web

Frontend-specific tests belong under:

```text
apps/web/tests/
```

Use descriptive names based on behavior.

Prefer:

```text
OrderForm.validation.test.tsx
```

over names based on internal implementation details.

---

## API

Backend/API tests belong under:

```text
apps/api/tests/
```

Tests may be organized by responsibility as implementation grows.

Examples:

```text
unit/
integration/
api/
```

The exact subdirectory structure should be introduced only when test volume justifies it.

Do not create large speculative testing directories during Sprint 1.

---

## Contracts

Contract/schema tests belong under:

```text
packages/contracts/tests/
```

These tests validate the public contract package's behavior.

Runtime API enforcement must still be tested at the API boundary.

---

## E2E

Cross-application tests belong under:

```text
tests/e2e/
```

The active workspace is:

```text
@atlas/e2e
```

The E2E workspace owns:

* its runner;
* browser driver;
* configuration;
* dependencies;
* scripts.

The initial E2E lane uses Playwright with Chromium. Its first journey covers browser registration,
captured SMTP verification, email-verification consumption, sign-in, and PostgreSQL persistence.
The command provisions isolated disposable PostgreSQL and Mailpit services and must never reuse the
ordinary development database.

CI runs this command as a dedicated lane after installing the pinned Playwright Chromium runtime.
It remains separate from the normal non-E2E `pnpm verify` lane.

---

# 6. Test Naming

Test names should describe observable behavior or the risk being protected.

Prefer:

```text
rejects an order with zero quantity
```

over:

```text
calls validateOrder()
```

For financial behavior, test names should make the invariant or state transition understandable.

Examples:

```text
does not settle an order twice
```

```text
preserves balance invariant after concurrent updates
```

```text
rolls back settlement when ledger persistence fails
```

---

# 7. Command Contracts

## `pnpm test`

Canonical normal test command.

It runs:

> **All non-E2E workspace tests.**

This includes applicable:

* unit;
* schema;
* component;
* API;
* contract;
* integration;
* PostgreSQL-dependent tests.

Therefore `pnpm test` may require the isolated PostgreSQL test environment.

It must not require browser/E2E infrastructure.

---

## `pnpm test:unit`

Optional narrower fast-feedback command.

It should run unit-focused tests that require no external infrastructure.

Its exact composition is implementation-specific.

It does not replace:

```text
pnpm test
```

---

## `pnpm test:e2e`

Runs cross-application E2E tests.

It may require:

* web application;
* API;
* PostgreSQL;
* browser infrastructure;
* other required system services.

E2E infrastructure is explicit rather than implicit.

---

## `pnpm verify`

Canonical repository verification command.

It runs:

```text
all mandatory static checks
+
pnpm test
```

Mandatory static checks currently include:

* type checking;
* linting;
* formatting validation;
* dependency-boundary validation.

Any future repository-required static check becomes part of `pnpm verify`.

The exact implementation of these scripts is not prescribed by this document.

---

# 8. Mock, Fake, and Real-Dependency Policy

Use a real dependency when its semantics are part of the behavior being tested.

Use a mock, fake, stub, or deterministic fixture when the dependency itself is not the subject of the test and isolation provides clearer evidence.

## Prefer real PostgreSQL for

* transactions;
* isolation;
* locking;
* constraints;
* SQL behavior;
* migrations;
* repository behavior;
* concurrency;
* persistence-backed idempotency;
* financial persistence.

## Prefer mocks/fakes for

* external HTTP services;
* payment providers;
* notification providers;
* external market-data providers;
* external networks;
* controllable clocks;
* randomness;
* failure simulation.

A mock should represent an intentional testing boundary rather than compensate for inconvenient architecture.

---

# 9. PostgreSQL Safety and Isolation

Database-dependent tests require a real isolated PostgreSQL environment.

## 9.1 Hard Safety Rule

A test configuration must reject non-test database targets.

Tests must not connect to:

* production;
* staging;
* development;
* another user's environment.

The safety mechanism must fail closed.

A test should fail before making a connection if its database target cannot be proven to be a permitted test target.

---

## 9.2 Provisioning

The provisioning mechanism is currently pending.

Candidates include:

* developer-installed PostgreSQL;
* dedicated test database;
* Docker Compose;
* Testcontainers;
* CI-provided PostgreSQL.

No implementation should be treated as canonical until the provisioning decision is separately approved.

---

## 9.3 Isolation

The implementation must explicitly define the isolation boundary.

Possible boundaries include:

* database;
* schema;
* transaction;
* another isolated test environment.

The chosen mechanism must support:

* concurrent execution where required;
* deterministic cleanup;
* independent test runs;
* migration testing;
* concurrency testing.

---

## 9.4 Migrations

When migrations exist, database tests should validate the schema generated by the actual migration path.

Avoid maintaining a completely independent test-only schema that can silently diverge from production schema.

---

## 9.5 Cleanup

Tests must not leave uncontrolled state behind.

The implementation must provide deterministic cleanup or isolation.

The cleanup strategy must support the chosen concurrency model.

---

# 10. Test Data Factories and Fixtures

Test data should be explicit, readable, and deterministic.

Prefer factories for structured domain objects that appear repeatedly.

Examples:

```text
createUser()
createOrder()
createWallet()
createLedgerEntry()
```

Factories should:

* provide safe defaults;
* allow relevant overrides;
* avoid hidden global state;
* avoid generating unpredictable values unless randomness is explicitly under test.

---

## 10.1 Fixtures

Use fixtures for stable scenario data.

Good fixture candidates include:

* known market-data responses;
* fixed API payloads;
* deterministic account states;
* representative contract responses.

Fixtures should not become opaque collections of unexplained data.

A fixture should make the scenario understandable.

---

## 10.2 Financial Test Data

Financial test data should explicitly communicate:

* currency;
* quantity;
* price;
* account;
* ledger direction;
* fee;
* relevant timestamps;
* state.

Avoid ambiguous numeric literals whose unit or meaning is unclear.

Financial numeric representation will be governed by the future financial-domain decision.

---

# 11. Deterministic Time

Tests must not depend accidentally on wall-clock time.

When time affects behavior, inject or otherwise control the clock.

Examples include:

* order expiry;
* settlement windows;
* timestamps;
* idempotency windows;
* rate limits;
* session expiration.

A test should specify the relevant time rather than silently using the machine's current time.

---

# 12. Deterministic Identifiers

Identifiers that affect observable behavior should be controllable.

Examples:

* UUIDs;
* order IDs;
* transaction IDs;
* idempotency keys.

Tests should use deterministic identifiers where doing so improves reproducibility.

Do not use uncontrolled randomness merely to make test data appear realistic.

---

# 13. Deterministic Randomness

When randomness affects behavior:

* provide a deterministic generator;
* seed it explicitly where appropriate;
* avoid relying on system randomness for expected outcomes.

Randomized/property-style tests may intentionally vary inputs, but their failing cases must be reproducible.

---

# 14. Deterministic Market Data

Trading-related tests must not depend on live market data.

Use deterministic fixtures or controlled providers.

A test should know exactly which:

* price;
* timestamp;
* quantity;
* market state;

it is operating against.

Live external market data belongs to separate environments and validation workflows, not ordinary deterministic tests.

---

# 15. Financial-Invariant Traceability

Every critical financial invariant introduced by a domain must be traceable.

Required model:

```text
Business invariant
        ↓
Test scenarios
        ↓
Implementation boundary
        ↓
CI execution
        ↓
CI result
```

Example:

```text
Invariant:
A settlement cannot create an unexplained accounting movement.

        ↓

Scenarios:
- successful settlement
- duplicate settlement
- failed ledger write
- rollback
- concurrent settlement attempt

        ↓

Boundary:
Settlement + PostgreSQL transaction + ledger

        ↓

Tests:
Integration/concurrency tests

        ↓

CI:
pnpm test
```

---

# 16. Accounting-Boundary Invariant

Atlas must reason about value movements within explicit accounting boundaries.

The governing rule is:

> **Within a defined accounting boundary, every value movement must be explained by balanced ledger entries or an explicitly authorized external movement. Fees must identify their destination account rather than silently removing value.**

Deposits and withdrawals must therefore be modeled as authorized external movements rather than treated as violations of a simplistic global conservation rule.

Fees must have an explicit accounting destination.

---

# 17. Financial Test Scenario Requirements

For each critical financial rule, cover applicable scenarios across:

### Happy path

The intended successful operation.

### Invalid input

Inputs that must be rejected.

### Boundaries

Examples:

* zero;
* minimum;
* maximum;
* precision boundaries;
* quantity boundaries.

### Failure

Dependency or operation failure.

### Rollback

Verify that partial state does not survive an unsuccessful transaction.

### State transitions

Verify important lifecycle transitions.

### Concurrency

Required where concurrent execution can affect the invariant.

### Invariant preservation

Verify the financial/accounting rule after the operation.

---

# 18. Coverage Policy

Coverage is used as:

* a diagnostic;
* a regression signal;
* a way to identify untested areas.

Coverage is not treated as proof of correctness.

Do not optimize implementation merely to increase a percentage.

When coverage falls, ask:

1. What behavior is untested?
2. Is the behavior risky?
3. Does the missing coverage represent a meaningful scenario?
4. Should a behavioral test be added?
5. Is the uncovered code intentionally unreachable or low-risk?

---

# 19. Code Review Policy

Test changes should be reviewed for **evidence quality**, not just test quantity.

Reviewers should ask:

* What risk does this test protect?
* Is the test at the correct boundary?
* Is the test deterministic?
* Does it use the correct real/mocked dependency?
* Could the test pass while the real behavior is broken?
* Does the test cover failure behavior where relevant?
* Does concurrency require explicit testing?
* Is test data understandable?
* Does the test accidentally depend on external state?

For financial changes, reviewers should additionally verify the invariant-to-test traceability.

---

# 20. Flaky-Test Quarantine Workflow

A flaky test follows this lifecycle:

```text
Flaky test discovered
        ↓
Investigate
        ↓
Fix immediately where practical
        ↓
If not immediately fixable
        ↓
Explicit quarantine
        ↓
Tracking issue
        ↓
Owner
        ↓
Remediation target
        ↓
Fix
        ↓
Remove quarantine
```

A quarantined test must document:

* why it is quarantined;
* owner;
* tracking issue;
* expected remediation;
* quarantine target/date.

Quarantine must be visible in CI reporting.

---

## 20.1 Retries

Retries must not silently convert failures into passes.

If a retry mechanism is introduced for infrastructure resilience, the original failure must remain observable and retry behavior must not hide application-level nondeterminism.

---

# 21. CI Lanes

The canonical model is:

```text
Repository verification
    ↓
pnpm verify

Dedicated system validation
    ↓
pnpm test:e2e

Future dedicated validation
    ├── Performance
    └── Security
```

The exact CI provider, caching, parallelization, and service orchestration are implementation decisions.

---

# 22. Feedback-Time Targets

## Local

Target:

```text
≤ 2 minutes
```

Measurement:

> Wall-clock time from invocation of `pnpm test`, assuming required local test services are already ready.

This includes PostgreSQL-dependent non-E2E tests.

It excludes E2E.

---

## Pull Request

Target:

```text
≤ 10 minutes
```

Measurement:

> CI validation wall-clock time, including required CI service provisioning.

The normal blocking non-E2E verification is subject to this target.

---

## E2E

E2E is a separate lane.

It is not included in either target unless explicitly incorporated by a future decision.

---

# 23. Sprint 1 Testing Requirements

Sprint 1 is the engineering-foundation sprint.

Testing should cover the capabilities that actually exist.

## Required

### Configuration validation

Tests should establish that required configuration:

* is validated;
* rejects invalid values;
* fails safely when required configuration is missing;
* does not accidentally accept invalid environments.

---

### Health endpoint HTTP behavior

Once the API health endpoint exists, test:

* successful HTTP response;
* expected response shape;
* appropriate failure behavior where applicable.

---

### Foundation error handling

Where Sprint 1 introduces error-handling infrastructure, test:

* expected error mapping;
* HTTP behavior;
* malformed input behavior;
* safe error responses;
* preservation of unexpected failures.

Only behavior actually introduced by Sprint 1 is required.

---

### Existing shared contract schemas

Every shared contract schema introduced during Sprint 1 should have schema-level tests covering relevant:

* valid values;
* invalid values;
* required fields;
* boundaries.

If a contract is consumed by an actual runtime producer/consumer boundary, add the appropriate contract/API validation rather than assuming schema tests prove runtime compatibility.

---

### PostgreSQL

Once PostgreSQL integration or migrations are implemented, add tests covering the implemented behavior.

This includes applicable:

* connectivity;
* migrations;
* repository behavior;
* constraints.

Do not create PostgreSQL tests before there is PostgreSQL-dependent behavior to test.

---

### React

Once the web application exists, add basic component tests for meaningful user-visible behavior introduced in Sprint 1.

Do not create large speculative component suites.

---

## Not Required Yet

Sprint 1 does **not** require:

* full trading test suites;
* wallet financial invariants;
* complete ledger testing;
* settlement testing;
* order-matching testing;
* production-scale concurrency suites;
* full browser E2E coverage.

Those tests must be introduced with the domains they protect.

---

# 24. Future Identity Testing

When identity is implemented, testing should cover applicable:

* registration;
* authentication;
* session/token behavior;
* invalid credentials;
* authorization;
* account lifecycle;
* security-sensitive boundaries;
* relevant persistence behavior.

Identity tests should be introduced with the identity implementation rather than prematurely added to Sprint 1.

---

# 25. Future Wallet Testing

When wallets are implemented, testing should cover:

* wallet creation;
* ownership;
* balance representation;
* authorized movements;
* deposits;
* withdrawals;
* idempotency;
* invalid state transitions;
* concurrency where applicable.

Real PostgreSQL should be used wherever wallet correctness depends on database semantics.

---

# 26. Future Ledger Testing

Ledger implementation requires stronger financial testing.

Tests should establish:

* balanced entries;
* explicit account destinations;
* authorized external movements;
* fee accounting;
* transaction atomicity;
* rollback;
* idempotency;
* precision requirements after the financial numeric policy is decided;
* invariant preservation.

Critical ledger rules require traceability from business invariant to CI result.

---

# 27. Future Trading Testing

When trading is implemented, testing should cover applicable:

* order validation;
* order lifecycle;
* quantity boundaries;
* matching behavior;
* price behavior;
* partial fills;
* cancellation;
* idempotency;
* concurrency;
* settlement;
* balance effects;
* ledger effects.

Critical trading flows should receive integration and E2E coverage according to risk.

Browser E2E should remain limited to high-value user journeys.

---

# 28. Future Settlement Testing

Settlement is expected to be among Atlas's highest-risk areas.

Tests should eventually cover:

* atomic settlement;
* successful settlement;
* failed settlement;
* rollback;
* duplicate requests;
* idempotency;
* concurrent settlement attempts;
* ledger consistency;
* balance consistency;
* accounting-boundary invariants.

Real PostgreSQL is required when transaction or locking semantics are part of the behavior.

---

# 29. Performance Testing

Performance testing is a cross-cutting validation dimension.

As Atlas develops measurable requirements, define:

* latency objectives;
* throughput objectives;
* concurrency scenarios;
* degradation expectations;
* representative workloads;
* CI execution policy.

No performance-testing tool is currently canonical.

---

# 30. Security Testing

Security testing is a cross-cutting validation dimension.

As security-sensitive capabilities are introduced, testing should cover applicable:

* authentication;
* authorization;
* privilege boundaries;
* input validation;
* sensitive-data handling;
* dependency risks;
* abuse scenarios.

No security-testing tool is currently canonical.

---

# 31. Pending Decisions

The following remain intentionally unresolved:

### Test tooling

The test runner and supporting frameworks have not yet been selected.

### PostgreSQL provisioning

The provisioning approach has not yet been selected.

Candidates include:

* developer-installed PostgreSQL;
* dedicated test databases;
* Docker Compose;
* Testcontainers;
* CI-provided PostgreSQL.

### Database isolation

The exact database/schema/transaction isolation strategy remains pending.

### Database cleanup

The exact cleanup mechanism remains pending.

### Financial numeric representation

The representation and precision policy for financial values remains a separate financial-domain decision.

### Coverage thresholds

No mandatory numerical threshold has been established.

### Performance tooling

Deferred.

### Security tooling

Deferred.

---

# 32. Strategy Review Process

This strategy is a living canonical document.

Operational practices may change without changing ADR-004.

Examples of changes that normally belong here:

* test naming conventions;
* fixture conventions;
* factory patterns;
* CI organization;
* quarantine workflow details;
* review checklists;
* test-data conventions;
* domain-specific testing procedures.

Changes that alter the architectural decision require an ADR review.

Examples:

* replacing real PostgreSQL with mocks for PostgreSQL-dependent behavior;
* changing the fundamental command contract;
* removing risk-based testing;
* changing the role of E2E;
* abandoning explicit financial-invariant testing.

---

## 32.1 Review Cadence

Review the strategy:

* when a new major domain is introduced;
* when testing infrastructure changes materially;
* when CI feedback targets are repeatedly missed;
* when significant flakiness emerges;
* when a new architectural decision affects testing;
* at major sprint milestones where testing practices have materially evolved.

The minimum metadata review date should be updated whenever the strategy is substantively reviewed.

---

## 32.2 Relationship to ADR-004

```text
ADR-004
    ↓
Stable testing architecture

Testing Strategy
    ↓
Current operational application
```

If the strategy and ADR appear to conflict:

1. Treat ADR-004 as authoritative for the architectural decision.
2. Correct the strategy if it is merely operational drift.
3. If the architectural decision itself needs to change, create a new ADR.
4. Do not silently alter ADR-004 to represent current implementation details.

---

# 33. Operational Principle

Atlas should continuously optimize for:

```text
Correctness
    +
Useful evidence
    +
Fast feedback
    +
Determinism
    +
Operational simplicity
```

The goal is not to maximize:

```text
number of tests
```

or:

```text
coverage percentage
```

The goal is to create sufficient evidence that Atlas behaves correctly at the boundaries where failures matter.
