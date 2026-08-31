# ADR-072 — Incident-Response Exercise and Evidence

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-08-31

**Last reviewed:** 2026-08-31

**Canonical owner/source:** ADR-072

## Context

ADR-066 requires a timed tabletop or simulation using Atlas's current incident runbook and contact
path before `incident-response-exercise` can pass. The runbook defines severity, roles, containment,
recovery, communication, and closure, but prose alone does not prove that an operator can use those
parts under time pressure.

Atlas initially has one developer. An exercise must work with one person holding several explicit
roles while preserving role boundaries that can later be assigned to a team. It must also produce
reviewable evidence without putting credentials, user records, financial details, private provider
output, or an unbounded transcript into Git or command logs.

This decision adds the exercise and validation capability. It does not claim that an exercise has
occurred or that the readiness control passes.

## Decision Drivers

The exercise boundary should:

1. cover declaration, containment, evidence preservation, recovery, communication, and closure;
2. use a versioned runbook and a tested contact path;
3. support one operator without hiding responsibility;
4. distinguish a valid record from a passing readiness result;
5. expose gaps and corrective actions instead of encouraging a ceremonial pass;
6. prevent production fault injection and real-user impact;
7. keep sensitive response material out of repository and console output; and
8. expire readiness eligibility after ADR-066's 90-day maximum.

# Decision

Atlas adopts a **structured incident-response exercise record** validated with:

```bash
pnpm incident:exercise:validate -- <incident-exercise-record.json>
```

The record is held in a restricted evidence store outside Git. The committed example is
documentation only and deliberately records a failed example; it is not operational evidence.

## 1. Exercise boundary

Exercises target `staging` and use either:

- `tabletop` — a facilitator presents synthetic injects and the operator explains and records each
  action without changing a live system; or
- `simulation` — a reviewed, bounded action is performed against synthetic staging resources with
  an explicit cleanup and stop boundary.

Atlas never injects failure into production to satisfy this control. A simulation must not use real
users, real custody, personal data, shared credentials, or irreversible database operations.

Supported initial scenarios are credential compromise, database recovery, Financial integrity,
release rollback, service outage, and vulnerability response. The chosen scenario declares its
expected severity before the exercise so the operator must use the corresponding response cadence
and authority.

## 2. Roles and solo operation

Every record assigns an Incident Commander, Operations Lead, Communications Lead, and Scribe. The
same operator may hold all four roles while Atlas has one developer. The record still names each
role separately so that decisions, execution, communication, and chronology do not silently merge
into one unreviewable activity.

## 3. Required objectives and timeline

Every exercise evaluates exactly these objectives:

- declare and scope the incident;
- contain it safely;
- preserve useful, sanitized evidence;
- validate recovery and the original failure symptom;
- communicate a bounded status update through the selected path; and
- close the exercise with owned follow-up work.

The timeline must contain, in response order, an inject, incident declaration, containment decision,
status communication, recovery validation, and closure decision. Recovery validation requires an
evidence reference. Events use canonical UTC timestamps inside a 15-minute to eight-hour exercise
window.

The record references the exact Git revision containing the canonical operational-readiness
runbook. It also records whether the selected contact path was actually exercised and whether its
result was `passed`, `failed`, or `not-tested`. Naming an untested address or dashboard is not a
passing contact test.

## 4. Outcome and corrective actions

A `passed` outcome is permitted only when:

- the contact path was tested successfully;
- every required objective passed;
- the required response sequence and recovery evidence are present; and
- no Critical or High corrective action remains open.

A failed exercise remains a valid and valuable record when it exposes its failed objective, contact
path, or blocking corrective action. Corrective actions carry a stable ID, severity, status, owner,
due time, summary, and closure evidence. A failed exercise blocks the readiness control until the
gap is corrected and a new exercise passes.

Medium and Low improvements may remain open after a pass when they do not invalidate response
safety. They remain visible and owned; the exercise result does not close them automatically.

## 5. Evidence and validator authority

The validator enforces exact fields, canonical timestamps, a versioned runbook, complete roles and
objectives, ordered response events, action consistency, freshness, and basic secret-pattern
rejection. Its console result is sanitized to exercise identity, scenario, duration, aggregate
counts, outcome, observation/expiry times, and readiness eligibility.

A record is readiness-eligible only when it passed and is less than 90 days old. The resulting
`observedAt` is the exercise end time and `expiresAt` is exactly 90 days later. The production
readiness record must reference the restricted evidence artifact and use those dates.

The validator proves structure and internal consistency, not that an exercise happened, an evidence
reference is truthful, a provider screen is authentic, or a human followed the runbook. The
accountable readiness decision-maker must inspect the source evidence. Repository CI tests the
validator; it never turns the real readiness control green.

## 6. Sensitive-data boundary

The structured record may contain operator aliases, sanitized decisions, UTC timing, action
ownership, and opaque evidence references. It must not contain credentials, cookies, database URLs,
authorization headers, raw logs, request bodies, private user records, attributable balances, or
provider secret values.

Detailed screenshots, logs, chat transcripts, and provider records—when needed—belong in the
restricted evidence store under its own retention and access policy. They are referenced rather
than embedded. Secret-pattern rejection is defense in depth and does not replace operator review.

## Alternatives Considered

### Use a prose checklist only

Rejected because missing roles, skipped recovery proof, stale exercises, and false passing outcomes
would be difficult to detect consistently.

### Require four different people

Rejected initially because Atlas has one developer. Explicit role assignment preserves the model
without making the first exercise impossible.

### Automatically generate a passing exercise in CI

Rejected because CI can validate the evidence contract but cannot demonstrate human response,
contact delivery, decision quality, or provider operation.

### Inject failure into production

Rejected because a readiness exercise must reduce operational risk, not manufacture user impact.

### Store the complete record and attachments in Git

Rejected because operational metadata, private evidence, provider identifiers, and future incident
details require narrower access and retention than source documentation.

## Consequences

### Positive Consequences

- Exercises are comparable, time-bounded, and reviewable.
- Solo operation remains possible without erasing incident roles.
- Failed drills remain visible and cannot be relabeled as readiness passes.
- The readiness record receives exact observation and expiry timestamps.
- Console output and repository artifacts remain bounded and sanitized.

### Negative Consequences

- The operator must prepare and retain a structured record plus source evidence.
- Exact required stages make informal tabletop notes insufficient.
- Evidence truth and exercise quality still require accountable human review.
- The first real exercise remains blocked on a selected contact path and staging context.

## Reconsider When

Review this decision when Atlas has staffed on-call rotations, a formal incident-management system,
regulated notification duties, central signed evidence storage, more scenario-specific exercise
requirements, or safe automated chaos testing.

## Related Decisions

- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-064 — Database Backup, Restore, and Recovery Validation](ADR-064-database-backup-restore-and-recovery-validation.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
- [ADR-071 — Staging Smoke Execution and Sanitized Evidence](ADR-071-staging-smoke-execution-and-sanitized-evidence.md)
