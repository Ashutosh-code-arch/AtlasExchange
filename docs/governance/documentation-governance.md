# Documentation Governance

**Classification:** Canonical
**Status:** Active
**Last reviewed:** 2026-08-16
**Canonical owner/source:** This document defines Atlas documentation-governance rules.

---

## 1. Purpose

Atlas contains architectural decisions, product requirements, sprint planning, engineering standards, teaching material, and historical documentation.

Without clear ownership, the same subject can be described differently across multiple documents. This creates documentation drift and can cause engineers to implement the wrong system.

This document defines:

* Which documents are authoritative.
* What scope each authoritative document owns.
* How conflicts are resolved.
* How reference and teaching material should describe alternatives.
* How architectural decisions evolve.
* How documentation is classified and maintained.

The goal is to preserve useful documentation while establishing a reliable source of truth for the current Atlas system.

---

# 2. Authority by Scope

Atlas will **not** use one universal ranking where one document always outranks every other document.

Instead, authority is determined by **subject ownership**.

| Source                            | Authoritative scope                                                    |
| --------------------------------- | ---------------------------------------------------------------------- |
| **Accepted ADR**                  | The specific architectural decision addressed by that ADR              |
| **Project Specification**         | Current product requirements, scope, and undecided technology baseline |
| **Sprint System**                 | Scheduling, sprint numbering, deliverables, and completion criteria    |
| **Roadmap**                       | Non-committed future direction                                         |
| **Start Here**                    | Navigation only                                                        |
| **Reference / Teaching material** | No decision authority                                                  |
| **Engineering Strategy            | Cross-cutting operational policies such as testing, logging, security and observability                                                                                            |

A document is authoritative only within the scope it owns.

General documents:
Draft → Active → Archived

ADRs:
Proposed → Accepted → Superseded
             └→ Rejected

### Example

An ADR may define:

> Atlas uses Express as its backend framework.

The Sprint System may define:

> Express implementation occurs during Sprint 1.

The Sprint System determines **when** the work happens.

The ADR determines the **architectural decision**.

The Sprint System cannot silently replace the Express decision with Fastify.

Likewise, an ADR about authentication architecture cannot determine when authentication is scheduled. That belongs to the Sprint System.

---

# 3. Canonical Documents

Atlas will maintain a small set of canonical documents.

## 3.1 Accepted ADRs

ADRs define specific architectural and engineering decisions.

Examples:

```text
ADR-001 — Repository Strategy
ADR-002 — Project Folder Structure
ADR-003 — Workspace and Package-Management Strategy
```

An ADR is authoritative only for the decision it addresses.

ADRs preserve architectural history and decision rationale.

---

## 3.2 Project Specification

The Project Specification owns:

* Product requirements.
* Current product scope.
* Major product capabilities.
* Current technology baseline where no more specific ADR exists.
* Product-level constraints.
* System-level objectives.

If an architectural decision has subsequently been captured in an accepted ADR, that ADR becomes authoritative for that specific technical decision.

---

## 3.3 Sprint System

The Sprint System owns:

* Sprint numbering.
* Sprint sequence.
* Current sprint.
* Sprint objectives.
* Sprint deliverables.
* Sprint dependencies.
* Completion criteria.
* Scheduling of future work.

The Sprint System does **not** override architectural decisions established by accepted ADRs.

For example:

```text
ADR:
    Atlas uses Express.

Sprint System:
    Express foundation is implemented in Sprint 1.
```

Both statements can coexist because they govern different scopes.

---

## 3.4 Roadmap

The Roadmap owns **non-committed future direction**.

It may describe:

* Potential future capabilities.
* Future architectural evolution.
* Possible technologies.
* Long-term product direction.
* Potential scaling strategies.

A roadmap item does not become an active implementation requirement until it is adopted through the appropriate canonical planning or decision process.

For example:

> Atlas may introduce Docker for production deployment.

is valid roadmap information.

It does not mean:

> Docker is a Sprint 1 deliverable.

---

## 3.5 Start Here

The Start Here document is a navigation document.

It should help an engineer discover:

* What Atlas is.
* Where the canonical documents are.
* Which ADRs exist.
* Which sprint is currently active.
* Where engineering references are located.

It does **not** establish architectural or product decisions.

---

# 4. Reference and Teaching Material

Reference and teaching documents are valuable but have **no decision authority**.

Examples include:

* Engineering Standards.
* Reading Backlog.
* Technology comparisons.
* Architecture tutorials.
* Framework comparisons.
* Distributed-systems explanations.
* Security learning material.
* Database learning material.

These documents may discuss technologies Atlas does not currently use.

For example:

> Express vs Fastify

is valid teaching material.

However:

> Atlas uses Fastify.

is an active Atlas decision only if supported by the applicable canonical source.

---

# 5. Distinguishing Examples from Active Decisions

Reference and teaching documents must clearly distinguish between:

1. Atlas's current implementation.
2. An educational example.
3. A technology comparison.
4. A future possibility.
5. Historical information.

### Active Atlas decision

Use explicit language:

> **Atlas currently uses Express as its backend framework.**

or:

> **Current Atlas decision: pnpm workspaces. See ADR-003.**

### Educational example

Use:

> **Example:** A Node.js API could be implemented using Express or Fastify.

### Technology comparison

Use:

> **Teaching material:** This section compares Express and Fastify. It does not define Atlas's backend framework.

### Future possibility

Use:

> **Future consideration:** Docker may be introduced when Atlas has a demonstrated requirement for containerized environments.

### Historical decision

Use:

> **Historical:** Atlas previously considered Fastify. This does not represent the current implementation.

---

# 6. Documentation Conflict Resolution

When conflicting statements are discovered, engineers must first identify the **scope of the statement**.

Use this process:

```text
Identify the subject
        ↓
Identify the document that owns that subject
        ↓
Check the canonical source
        ↓
Determine the current decision
        ↓
Classify the conflicting statement
        ↓
Update / label / archive as appropriate
```

Do not resolve conflicts by simply editing whichever document was encountered first.

### Example

Suppose:

```text
Reading Backlog:
    Atlas uses npm workspaces.

ADR-003:
    Atlas uses pnpm workspaces.
```

ADR-003 owns the package-management decision.

Therefore:

```text
Current decision = pnpm
```

The Reading Backlog should either:

* be corrected;
* explicitly present npm as educational material; or
* be marked historical if appropriate.

It must not continue to appear as an active Atlas decision.

---

# 7. Initial Reconciliation Bootstrap Rule

The current canonical documents contain known inconsistencies and therefore cannot be used blindly to reconcile themselves.

During this initial reconciliation:

> **The project brief ratified on 2026-08-15 is the temporary migration baseline.**

This temporary baseline will be used to reconcile the existing documentation.

Once the canonical documents have been corrected and approved:

> **The corrected canonical documents replace the 2026-08-15 project brief as the operational source of truth.**

The temporary baseline exists only to bootstrap the documentation system and is not intended to become another permanent authority layer.

---

# 8. Current Reconciliation Direction

The initial reconciliation must establish the following current baseline:

| Subject           | Current direction                                               |
| ----------------- | --------------------------------------------------------------- |
| Backend framework | **Express**                                                     |
| Package manager   | **pnpm workspaces**                                             |
| Sprint 0          | **Business understanding completed**                            |
| Sprint 1          | **Engineering foundation**                                      |
| Docker            | **Future technology; not automatically a Sprint 1 deliverable** |
| Authentication    | **Not part of Sprint 1; future work**                           |

These statements must be reflected consistently across the applicable canonical documents.

Older documents containing conflicting statements must be classified and reconciled rather than blindly deleted.

---

# 9. Authentication Scheduling

Authentication is **not part of Sprint 1**.

It remains future work and will be assigned to a sprint when the canonical Sprint System is reconciled.

Educational material may still discuss authentication during Sprint 1 if it is required for learning or preparation, but educational discussion must not be interpreted as an active implementation requirement.

---

# 10. ADR Evolution

Accepted ADRs preserve architectural decision history.

An accepted ADR must **not be substantively rewritten simply because the decision changes**.

When an architectural decision changes:

1. Create a new ADR.
2. Explain the new decision and its rationale.
3. Reference the previous ADR.
4. Mark the previous ADR as `Superseded`.
5. Link the previous ADR to the replacement ADR.
6. Preserve the original decision and historical context.

Example:

```text
ADR-003
pnpm workspaces
    ↓
Superseded by
    ↓
ADR-012
New package-management strategy
```

The original ADR remains part of Atlas's architectural history.

ADRs are therefore **decision records, not configuration files**.

---

# 11. Document Metadata

Every maintained Atlas document must declare:

```text
Classification: Canonical | Reference | Teaching | Historical
Status: Draft | Active | Superseded | Archived
Last reviewed: YYYY-MM-DD
Canonical owner/source: applicable document or ADR
```

### Classification

Defines the purpose of the document:

* `Canonical` — authoritative within its defined scope.
* `Reference` — engineering/reference material with no decision authority.
* `Teaching` — educational material.
* `Historical` — preserved historical information.

### Status

Defines lifecycle state:

* `Draft` — under development and not yet authoritative.
* `Active` — currently maintained and applicable.
* `Superseded` — replaced by a newer document or decision.
* `Archived` — retained for historical/reference purposes but no longer actively maintained.

### Canonical owner/source

Identifies which document owns the subject.

For example:

```text
Canonical owner/source: ADR-003
```

or:

```text
Canonical owner/source: Sprint System
```

This field describes **document authority**, not an individual person's ownership.

---

# 12. Documentation Maintenance Rules

### Rule 1 — One subject must have one canonical owner

A subject may be discussed in multiple documents, but only one applicable canonical source owns the current decision.

### Rule 2 — References must defer to canonical decisions

Reference material must not present an alternative technology as Atlas's active implementation unless the canonical source says so.

### Rule 3 — Teaching material may contain alternatives

Teaching documents may freely compare technologies and architectures.

They must clearly label those comparisons as educational when they differ from Atlas's implementation.

### Rule 4 — Architectural changes require ADRs

Changing a significant architectural decision must go through the ADR process rather than silently modifying reference material.

### Rule 5 — Sprint changes belong in the Sprint System

Adding, removing, reordering, or rescheduling sprint deliverables belongs in the Sprint System.

### Rule 6 — Product scope changes belong in the Project Specification

Changes to product requirements or current product scope must be reflected in the Project Specification.

### Rule 7 — Future ideas belong in the Roadmap

Uncommitted future technologies or capabilities must not be presented as current implementation requirements.

### Rule 8 — Historical decisions remain traceable

Superseded architectural decisions should remain available so engineers can understand why the architecture evolved.

---

# 13. Documentation Review Checklist

Before considering documentation reconciled, verify:

* [ ] Backend framework is consistently represented as Express where describing the current Atlas implementation.
* [ ] pnpm is the current package-management decision.
* [ ] npm references are clearly educational, historical, or corrected.
* [ ] Sprint 0 has one consistent definition.
* [ ] Sprint 1 has one consistent definition.
* [ ] Authentication is not listed as a Sprint 1 implementation deliverable.
* [ ] Docker is not incorrectly represented as a Sprint 1 requirement.
* [ ] Fastify references are classified as educational, comparative, historical, or corrected.
* [ ] ADR-001 remains consistent with the current repository strategy.
* [ ] ADR-002 remains consistent with the current folder structure.
* [ ] ADR-003 remains consistent with pnpm workspace strategy.
* [ ] All maintained documents contain the required metadata.
* [ ] Superseded ADRs are not silently rewritten.
* [ ] Reference documents clearly distinguish examples from Atlas decisions.
* [ ] Start Here points engineers toward the canonical sources.
* [ ] No reference document silently overrides an accepted ADR.

---

# 14. Final Governance Principle

> **Atlas documentation is governed by scope, not by a universal document hierarchy. Each canonical source owns a specific subject. Accepted ADRs define specific architectural decisions; the Project Specification defines product scope and the current baseline; the Sprint System defines scheduling and sprint execution; the Roadmap defines non-committed future direction; and Start Here provides navigation. Reference and teaching material have no decision authority.**

> **When documents conflict, the canonical source that owns the subject determines the current truth. Architectural decisions evolve through new ADRs rather than rewriting history, and all maintained documents must clearly declare their classification, status, review date, and canonical source.**

This governance model is now the basis for the **document-by-document reconciliation checklist** before repository scaffolding begins.
