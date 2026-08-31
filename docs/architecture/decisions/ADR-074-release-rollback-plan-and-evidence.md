# ADR-074 — Release Rollback Plan and Evidence

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-08-31

**Last reviewed:** 2026-08-31

**Canonical owner/source:** ADR-074

## Context

ADR-063 promotes immutable API, web, and metrics-collector images as one release set. ADR-066
requires a candidate-bound rollback plan before traffic, but application rollback is not symmetric
with database migration. Returning an older API to a forward-migrated schema can corrupt state or
fail at runtime; reversing an applied migration can be more dangerous than the failed rollout.

Atlas also has no previously deployed release before its first production-like rollout. Recording
fictional previous digests would make the checklist look complete while removing the only truthful
fallback: stop traffic, preserve state, and fix forward or recover through the separately tested
database path.

This decision creates a plan and evidence contract only. It does not deploy, migrate, change
traffic, rehearse against a provider, or prove that rollback is currently available.

## Decision Drivers

The rollback boundary should:

1. bind one plan to exact candidate and baseline release identities;
2. distinguish a previous release from a first-release deployment;
3. preserve the forward database schema and immutable migration history;
4. prove older application compatibility before routing it to a newer schema;
5. account for cached browser clients and Market Data WebSocket contracts;
6. move API, web, and collector as one reviewed release set;
7. require an ordered, rehearsed human procedure rather than blind automation;
8. keep blocked or expired plans visible without treating them as readiness evidence; and
9. avoid secrets, raw logs, user records, or database contents in plan artifacts.

# Decision

Atlas adopts a **structured release rollback plan** validated with:

```bash
pnpm rollback:validate -- <rollback-plan.json>
```

The real plan and its source evidence remain in a restricted deployment evidence store. The
committed example is deliberately blocked and is not a provider procedure.

## 1. Candidate and baseline identity

The plan identifies the candidate by stable semantic version, full source revision, and immutable
API, web, and metrics-collector SHA-256 digests.

The baseline is exactly one of:

- `previous-release` — a separately verified release with its own version, revision, and three
  immutable digests; or
- `first-release` — no earlier Atlas release exists, the baseline release is `null`, and evidence
  supports that fact.

Candidate and previous-release identities must differ. Tags such as `latest`, branch names, partial
commits, or reconstructed image pairs are never rollback targets. API, web, and collector move as
one release set; independent component rollback requires a later contract proving the mixed set.
A baseline is `verified` only with retained source/environment evidence; otherwise it remains
`blocked`, including when the first-release claim has not been confirmed.

## 2. First-release fallback

A first release cannot route to previous Atlas images. Its ready strategy is `remove-traffic`:

1. stop the rollout and remove normal ingress;
2. determine whether the migration job ran;
3. fence uncertain mutations and preserve evidence;
4. retain the forward schema;
5. create a reviewed corrective release; or
6. use the separately approved recovery path when database correctness is affected.

This is a real rollback of exposure, not a rollback of source or schema. It can satisfy the plan
control only after it is rehearsed and recovery-point evidence exists. It does not make the failed
candidate safe to serve.

## 3. Database compatibility

The plan records the schema version before rollout, the candidate schema version, every newly
applied migration name and checksum, a compatibility classification, source evidence, the database
reviewer, and a recent recovery-point reference.

For a previous-release rollback to be ready:

- every new migration is explicitly `backward-compatible` with the previous API;
- the decision is `previous-api-compatible`;
- the action is `retain-forward-schema`; and
- the previous API is tested against the candidate's resulting schema.

Any breaking or unevaluated migration blocks routing to the previous API. The fallback becomes a
corrective forward release or reviewed database recovery. An applied migration is never edited,
automatically reversed, or hidden by changing the migration ledger. The plan has no reverse-
migration field by design.

Migration evidence is ordered by canonical committed filename and lowercase SHA-256 checksum. A
schema-version change in a ready plan cannot omit the migrations that create it.
First-release migrations use `not-applicable` because no previous API exists; their migration and
recovery evidence remains mandatory.

## 4. Transition contracts

Previous-release rollback requires evidence for:

- previous web to candidate API compatibility during rollout;
- cached candidate web to previous API compatibility during rollback; and
- Market Data WebSocket protocol compatibility across the transition.

The checks cover public requests, shared schemas, errors, authentication/CSRF behavior, runtime API
configuration, negotiation, and reconnect semantics affected by the candidate. If any direction is
incompatible, normal ingress remains off until a compatible forward release is available.

For a first release, these checks are `not-applicable` because no previous Atlas web/API exists. The
plan must not fabricate compatibility evidence for a nonexistent baseline.

## 5. Required operator procedure

Every plan contains these ordered stages:

1. stop the rollout;
2. determine migration state;
3. freeze unsafe mutations;
4. change traffic;
5. verify active release identity;
6. validate lifecycle, authentication, and session behavior;
7. validate affected Financial and Trading behavior;
8. validate observability and alert state; and
9. communicate the result and continue elevated monitoring.

Each stage names an owner and environment-specific instruction. A ready plan must be rehearsed in a
safe staging boundary with retained evidence. A successful CI test of the record schema is not a
rollback rehearsal.

Traffic changes happen only after the operator determines whether migrations ran. When correctness
or privacy is uncertain, fence mutations before changing application images. After the change,
release identity and behavior—not merely container health—must prove the intended state.

## 6. Decision and freshness

A `ready` decision requires:

- non-placeholder candidate and applicable baseline identities;
- baseline and recovery-point evidence;
- the correct first-release or previous-release strategy;
- database and transition compatibility appropriate to that baseline;
- a complete ordered procedure; and
- successful rehearsal evidence.

A `blocked` plan must retain at least one visible blocking condition. A ready plan is eligible for
ADR-066 for seven days from `decidedAt`; at expiry, candidate, baseline, schema, provider procedure,
and rehearsal evidence must be reviewed again.

The validator proves structure, consistency, immutable identity format, evidence presence, and
freshness. It cannot prove evidence authenticity, migration semantics, provider behavior, or
operator competence. The accountable readiness decision-maker must inspect the restricted sources.

## 7. Sensitive-data boundary

The plan may contain release identity, migration names/checksums, role aliases, sanitized
instructions, and opaque evidence references. It must not contain credentials, cookies, database
URLs, raw configuration dumps, private records, attributable financial values, provider tokens, or
raw incident logs. Detailed evidence is referenced from the restricted store rather than embedded.

## Alternatives Considered

### Automatically return to the previous API on health failure

Rejected because health does not establish schema, contract, financial, session, or side-effect
compatibility.

### Automatically reverse applied migrations

Rejected because data loss and asymmetric application/schema behavior make blind reversal unsafe.

### Invent a previous digest for the first release

Rejected because a nonexistent baseline cannot be fetched, verified, rehearsed, or trusted. Removing
traffic is the truthful first-release fallback.

### Roll back API and web independently by default

Rejected because cached clients, public contracts, runtime configuration, and session behavior can
make a mixed release invalid. The initial rollback unit is the reviewed release set.

### Treat a written procedure as sufficient without rehearsal

Rejected because provider permissions, traffic controls, image resolution, timing, and human steps
can fail even when prose looks complete.

## Consequences

### Positive Consequences

- Rollback cannot silently violate forward-schema authority.
- First-release behavior is honest and operationally actionable.
- Cached browser and WebSocket transitions receive explicit review.
- Every traffic change has ordered ownership and post-change validation.
- Plans are candidate-bound, short-lived, and safe to summarize.

### Negative Consequences

- A breaking migration intentionally removes application rollback as an option.
- Rehearsal and compatibility evidence add release work.
- The whole release-set boundary may restore more components than the failure strictly requires.
- Provider-specific traffic commands remain external evidence until staging exists.

## Reconsider When

Review this decision when expand/contract migrations are automated, API versions coexist, web
assets are strongly cache-versioned, progressive delivery is introduced, components gain proven
independent rollback, external side effects exist, or the platform offers transactional deployment
and verified rollback primitives.

## Related Decisions

- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-028 — Financial Reservation, Release, and Trade Settlement Capabilities](ADR-028-financial-reservation-release-and-trade-settlement-capabilities.md)
- [ADR-043 — Browser Market Data Streaming and Recovery](ADR-043-browser-market-data-streaming-and-recovery.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-064 — PostgreSQL Backup, Restore, and Recovery Validation](ADR-064-postgresql-backup-restore-and-recovery-validation.md)
- [ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go](ADR-066-operational-readiness-incident-response-and-production-go-no-go.md)
