# Reconciliation Baseline — 2026-08-15

Classification: Canonical
Status: Active
Purpose: Temporary reconciliation baseline
Superseded when: Canonical documentation reconciliation is approved

## Purpose

This document preserves the project brief ratified on 2026-08-15 as the temporary baseline used to reconcile existing Atlas documentation.

It exists because some currently designated canonical documents contain outdated or conflicting information.

During the initial reconciliation, this baseline provides the temporary reference point for determining the intended current state.

Once the canonical documentation reconciliation is approved, this document will be marked Archived.

It must not be deleted because it preserves the historical basis for the documentation changes made during the reconciliation.

# Documentation Governance — Engineering Strategy Authority

**Classification:** Canonical
**Status:** Active
**Last reviewed:** 2026-08-16
**Canonical owner/source:** Documentation Governance

## Engineering Strategy Authority

Engineering Strategy is authoritative for **cross-cutting operational implementation policies**.

This includes, but is not limited to:

* testing;
* logging;
* security;
* observability;
* operational engineering practices.

The authority model is scope-based:

| Source                | Authoritative scope                                                   |
| --------------------- | --------------------------------------------------------------------- |
| Accepted ADR          | Specific architectural decision addressed by the ADR                  |
| Project Specification | Product requirements, scope, and technology baseline where applicable |
| Sprint System         | Sprint numbering, scheduling, deliverables, completion criteria       |
| Roadmap               | Non-committed future direction                                        |
| Engineering Strategy  | Cross-cutting operational implementation policies                     |
| Start Here            | Navigation only                                                       |
| Reference / Teaching  | No decision authority                                                 |

## ADR and Engineering Strategy Relationship

An accepted ADR establishes a stable architectural decision.

The corresponding Engineering Strategy defines how that decision is applied operationally over time.

Therefore:

```text
Accepted ADR
    ↓
Why the architecture was chosen
Stable decision
Trade-offs
Alternatives

Engineering Strategy
    ↓
How engineers apply the decision
Commands
Procedures
Workflows
Checklists
Operational conventions
```

An Engineering Strategy must not contradict an accepted ADR.

If an operational strategy needs to change while the architectural decision remains valid, update the strategy.

If the architectural decision itself needs to change:

1. Create a new ADR.
2. Reference the previous ADR.
3. Mark the previous ADR `Superseded`.
4. Link to the replacement.
5. Preserve the original rationale.

## Testing Example

For testing:

```text
ADR-004 — Testing Architecture
    ↓
Stable testing architecture

docs/engineering/testing-strategy.md
    ↓
Living operational testing policy
```

ADR-004 is authoritative for decisions such as:

* risk-based testing;
* real PostgreSQL where PostgreSQL semantics matter;
* command contracts;
* financial-invariant testing;
* deterministic testing;
* flaky-test policy;
* feedback-time targets.

The testing strategy is authoritative for their ongoing application, including:

* test ownership;
* file placement;
* naming;
* fixtures;
* factories;
* database-test procedures;
* CI workflows;
* review checklists;
* Sprint-specific testing requirements.

Older testing sections in other canonical documents must defer to ADR-004 and `docs/engineering/testing-strategy.md` rather than independently defining conflicting operational testing policy.

## Governance Principle

> **Architectural decisions are recorded in ADRs; cross-cutting operational practices are maintained in Engineering Strategy documents.**

This separation prevents accepted ADRs from becoming large living handbooks while preserving a stable historical record of why Atlas made its architectural decisions.
