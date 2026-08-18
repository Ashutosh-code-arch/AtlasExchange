# ADR-004 — Testing Architecture

**Status:** Accepted
**Date:** 2026-08-16
**Decision scope:** Atlas testing architecture
**Canonical owner:** Engineering Strategy / Testing Architecture
**Operational policy:** `docs/engineering/testing-strategy.md`
**Supersedes:** None
**Classification:** Canonical
**Last reviewed:** 2026-08-16
**Canonical owner/source:** ADR-004

---

## 1. Context

Atlas is being designed as a production-oriented exchange application where correctness, reliability, and auditability are more important than maximizing test count.

The system will eventually contain financial behavior including:

* orders;
* balances;
* wallets;
* ledgers;
* fees;
* settlement;
* idempotency;
* concurrent state changes;
* transactional persistence.

These behaviors have failure modes that cannot be adequately validated through unit tests alone.

Atlas therefore requires a testing architecture that:

* validates behavior at the boundary where the relevant risk exists;
* uses real PostgreSQL when PostgreSQL semantics affect correctness;
* explicitly protects financial invariants;
* supports deterministic tests;
* provides fast developer feedback;
* separates system-level E2E validation from normal tests;
* treats flaky tests as defects;
* supports auditable risk-based coverage;
* can evolve as Atlas grows.

The architecture must also avoid premature tooling decisions.

---

## 2. Decision Drivers

The testing architecture must optimize for:

1. **Correctness**
2. **Financial safety**
3. **Real infrastructure semantics where required**
4. **Fast feedback**
5. **Deterministic execution**
6. **Clear ownership**
7. **Maintainability**
8. **Auditability**
9. **CI reliability**
10. **Future scalability**

Atlas will prefer the simplest testing mechanism that adequately exercises the risk.

---

## 3. Decision

Atlas adopts a **risk-based, multidimensional testing architecture**.

Testing classifications are not mutually exclusive.

A single test may exercise multiple dimensions.

For example:

```text
HTTP request
    ↓
API handler
    ↓
application logic
    ↓
real PostgreSQL
```

may simultaneously be classified as:

* an API test;
* an integration test;
* a PostgreSQL behavior test.

Classification describes the **risk and boundary exercised**, not necessarily a separate test file, framework, or command.

The architectural model is:

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

The governing principle is:

> **Test behavior at the boundary where the relevant risk actually exists.**

---

## 4. Real PostgreSQL Requirement

Atlas requires a real PostgreSQL instance whenever correctness depends on PostgreSQL semantics.

This includes behavior involving:

* transactions;
* rollback;
* isolation;
* constraints;
* row locking;
* concurrency;
* SQL semantics;
* migrations;
* repository behavior;
* persistence-backed idempotency;
* financial persistence;
* PostgreSQL numeric behavior.

Mocks and in-memory database implementations cannot prove PostgreSQL-specific correctness.

The architectural requirement is therefore:

> **Use the real dependency when the behavior under test depends on that dependency's semantics.**

The mechanism used to provision and isolate PostgreSQL is intentionally deferred.

---

## 5. PostgreSQL Safety Requirement

Database-dependent tests must execute against an isolated test environment.

The test environment must prevent accidental connections to:

* development databases;
* staging databases;
* production databases;
* unrelated test environments.

The test environment must reject non-test database targets.

The operational strategy defines the implementation and workflow for:

* provisioning;
* isolation;
* migrations;
* cleanup;
* concurrency;
* safety validation.

---

## 6. Financial-Invariant Testing

Financial correctness is a first-class testing concern.

Atlas does not use the simplified invariant:

```text
Money is never created or destroyed.
```

Instead:

> **Within a defined accounting boundary, every value movement must be explained by balanced ledger entries or an explicitly authorized external movement. Fees must identify their destination account rather than silently removing value.**

As financial domains are introduced, critical invariants must have explicit test traceability.

The required model is:

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

Critical financial behavior must eventually account for applicable:

* happy paths;
* invalid inputs;
* boundary values;
* failure behavior;
* rollback behavior;
* state transitions;
* concurrency;
* invariant preservation.

The detailed operational process belongs to the testing strategy.

---

## 7. Risk-Based Coverage

Atlas will not define correctness through a single repository-wide coverage percentage.

Coverage is a diagnostic and regression signal.

It is not proof of correctness.

Testing depth should correspond to risk.

Critical financial logic requires stronger behavioral evidence than low-risk code.

The testing strategy defines how coverage, invariant traceability, code review, and CI evidence are applied operationally.

Exact numerical coverage thresholds remain intentionally deferred.

---

## 8. Deterministic Testing

Atlas will control nondeterministic inputs when they affect observable behavior.

Relevant inputs include:

* time;
* randomness;
* identifiers;
* market-data fixtures;
* timestamps.

Tests should be reproducible regardless of uncontrolled environmental values.

This is distinct from financial numeric precision.

Atlas must not rely on ordinary JavaScript floating-point arithmetic for financial values.

Financial numeric representation and precision policy are deferred to a future financial-domain architectural decision.

---

## 9. Command Contracts

Atlas defines three canonical repository testing contracts:

```text
pnpm test
    → all non-E2E workspace tests

pnpm test:e2e
    → cross-application E2E tests

pnpm verify
    → all mandatory static checks
      + all non-E2E workspace tests
```

`pnpm test` may require the isolated PostgreSQL test environment.

E2E infrastructure must not be required by `pnpm test`.

A narrower unit-focused command such as:

```text
pnpm test:unit
```

may exist for fast local feedback, but it does not replace `pnpm test`.

Exact script composition remains an implementation concern.

---

## 10. Feedback-Time Targets

Atlas establishes the following engineering targets.

### Local test target

```text
≤ 2 minutes
```

Measured as wall-clock time from invocation of `pnpm test`, assuming required local test services are already ready.

### Pull-request validation target

```text
≤ 10 minutes
```

Measured as CI validation wall-clock time, including required CI service provisioning.

### E2E

E2E runs in a separate CI lane.

It is not included in either target unless explicitly incorporated by a future decision.

These are engineering targets, not absolute correctness requirements.

---

## 11. Flaky-Test Policy

A flaky test is a defect.

Atlas does not accept silent retries as a mechanism for turning intermittent failures into passing CI.

If a flaky test cannot be fixed immediately, it may be explicitly quarantined as a temporary exception.

Quarantine requires:

* visibility;
* an owner;
* a tracking issue;
* a remediation target.

Financial-invariant tests receive particular scrutiny because unexplained nondeterminism can conceal correctness defects.

The detailed quarantine workflow is defined in the testing strategy.

---

## 12. Alternatives Considered

### Unit tests only

Rejected because unit tests cannot establish correctness of PostgreSQL transactions, locking, migrations, concurrency, HTTP behavior, contracts, or critical system journeys.

### Mock PostgreSQL everywhere

Rejected because mocks cannot prove PostgreSQL semantics.

### E2E-heavy testing

Rejected because it creates slower feedback, greater fragility, harder diagnosis, and unnecessary duplication.

### One global coverage threshold

Rejected because a single percentage does not represent risk or financial correctness.

### Silent retries

Rejected because retries can conceal genuine defects, race conditions, infrastructure problems, and nondeterminism.

### Selecting PostgreSQL provisioning now

Deferred because multiple valid approaches exist and the choice depends on implementation constraints that are not yet established.

---

## 13. Consequences

### Positive

Atlas gains:

* explicit testing boundaries;
* stronger financial correctness;
* real database-semantic validation;
* deterministic tests;
* clear E2E separation;
* predictable CI behavior;
* auditable financial-invariant coverage;
* fast feedback targets;
* flexibility to select tooling later.

### Negative

The architecture requires additional engineering investment in:

* real PostgreSQL test infrastructure;
* test isolation;
* migration testing;
* concurrency testing;
* CI lanes;
* financial-invariant scenarios;
* operational test maintenance.

These costs are accepted because Atlas is an exchange application where correctness failures can have materially greater consequences.

---

## 14. Deferred Decisions

ADR-004 intentionally does not select:

* test runner;
* E2E framework;
* PostgreSQL provisioning mechanism;
* database isolation mechanism;
* database cleanup mechanism;
* numerical coverage thresholds;
* performance tooling;
* security tooling;
* financial numeric representation.

These decisions should be made separately when sufficient implementation or domain information exists.

---

## 15. Reconsideration Criteria

Reconsider this architecture when measurable engineering problems emerge, including:

* normal test execution consistently exceeding the local feedback target;
* PR validation consistently exceeding the CI target;
* PostgreSQL testing requiring a more sophisticated isolation model;
* E2E infrastructure becoming a significant CI bottleneck;
* financial concurrency introducing new correctness requirements;
* Atlas adopting multiple independently deployed services;
* regulatory requirements introducing additional validation obligations;
* the current risk model no longer representing the system accurately.

Reconsideration should be evidence-driven rather than tool-driven.

---

## 16. Operational Strategy

The architectural decisions in this ADR are applied through:

```text
docs/engineering/testing-strategy.md
```

The strategy is the living operational policy and defines:

* test ownership;
* file placement;
* naming;
* fixtures and factories;
* database isolation procedures;
* deterministic test setup;
* coverage workflows;
* code-review expectations;
* CI lanes;
* quarantine procedures;
* current sprint requirements;
* domain-specific testing expectations.

The strategy may evolve as Atlas implementation practices mature without requiring a new ADR for every operational change.

An architectural change to the decisions recorded in this ADR requires a new ADR that supersedes this decision.

---

## 17. Relationship to Documentation Governance

The authority model is:

```text
Accepted ADR
    ↓
Stable architectural decision

Engineering Strategy
    ↓
Living operational application of that decision
```

The Engineering Strategy must not contradict an accepted ADR.

Where an accepted ADR defines a specific architectural decision, that ADR is authoritative.

Where the question is how engineers continuously apply that decision, the corresponding Engineering Strategy is authoritative.

This ADR therefore does not reproduce the complete testing handbook.

---

## 18. Status

**Accepted**

The detailed operational policy is maintained in:

```text
docs/engineering/testing-strategy.md
```
