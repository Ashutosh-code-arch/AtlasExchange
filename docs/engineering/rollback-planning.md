# Atlas Release Rollback Planning Runbook

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-08-31

This runbook implements ADR-074. It creates and rehearses a candidate-bound rollback plan; it does
not change traffic, reverse migrations, create a provider resource, or claim a rollback is ready.

## Current state

```text
Rollback validator:                 implemented and repository-tested
Published/deployed candidate:       no evidence
Previous known-good release:        none
Provider traffic procedure:         not available
Staging rollback rehearsal:         not performed
Current recovery point:             no provider evidence
rollback-plan control:              blocked
```

## Prepare the release identities

Create a new restricted plan from [the blocked example](rollback-plan.example.json). Record the
candidate's stable version, full source revision, and immutable API, web, and collector digests.

If Atlas already has a known-good release in the target environment, select `previous-release` and
record its independently verified identity. Otherwise select `first-release` with `release: null`.
Never use local image IDs, mutable tags, a planned release, or a manually assembled digest set as a
baseline.
Set `baseline.status` to `verified` only after retaining evidence for that exact prior release or
for the absence of any prior release. Otherwise keep it `blocked`.

## Review migration state

Record the current and candidate final committed migration filenames. For every new migration,
record its canonical filename, lowercase SHA-256 checksum, compatibility decision, and controlled
review evidence.

For a previous-release strategy, test the previous API image against a database migrated through the
candidate revision. Verify reads and affected writes, immutable migration history, lifecycle
readiness, session behavior, and Financial invariants. A successful migration is not compatibility
proof.

Select `previous-api-compatible` and `retain-forward-schema` only when every new migration is
backward-compatible. Otherwise block application rollback and plan a corrective forward release or
the [database recovery procedure](database-recovery.md). Never edit, delete, or reverse an applied
migration to make the older image start.

For the first release, use `not-applicable` and `forward-fix-or-recover`. Retain evidence for a recent
recovery point even though there is no older application. Classify its new migrations
`not-applicable` rather than claiming compatibility with a nonexistent API.

## Test transition contracts

With a previous release, verify both mixed-client directions before rehearsal:

1. previous web against candidate API during forward rollout;
2. cached candidate web against previous API during rollback; and
3. Market Data WebSocket negotiation, messages, heartbeat, reconnect, and stale recovery.

Use `compatible` only with source evidence for the exact pair. Any incompatible or unevaluated check
blocks the previous-release strategy. For a genuine first release, use `not-applicable` with no
fictional compatibility artifact.

## Write the provider procedure

Complete the nine ordered steps in the plan with the exact commands or reviewed console actions for
the target environment. Name an owner for every step. Instructions may reference restricted
provider procedures but must not contain credentials or private configuration.

The traffic step is:

- `previous-release-set` — disable normal ingress, switch API/web/collector to the recorded baseline
  digests, verify all three, then restore traffic after checks; or
- `remove-traffic` — disable normal ingress for a first release and keep it disabled while fixing
  forward or recovering.

Determine migration state and fence uncertain mutations before changing images. Do not rely on an
automatic health-triggered rollback.

## Rehearse in staging

Deploy the exact candidate and baseline conditions without real users or custody. Exercise the plan
from rollout stop through elevated monitoring. Measure time, verify operator permissions, resolve
digests from the registry, confirm the active release, and collect sanitized behavior evidence.

The rehearsal must validate lifecycle, authentication/session, affected Financial/Trading behavior,
Market Data where relevant, metrics/alerts, and the original injected failure. Store detailed output
in the restricted evidence store. Put only opaque references in the plan.

Stop if migration state is ambiguous, the baseline digest cannot be verified, the older API rejects
the forward schema, cached clients fail, financial correctness is uncertain, provider operations
require broader access, or evidence exposes private material.

## Decide and validate

The accountable release owner records `ready` only after reviewing the rehearsal and compatibility
evidence:

```bash
pnpm rollback:validate -- /restricted/path/rollback-plan.json
```

Require `outcome: ready`, `blockingItems: 0`, `readinessEligible: true`, and the intended baseline and
strategy. A successful command for a blocked or expired plan validates structure only.

For ADR-066's `rollback-plan` control, reference the restricted plan and evidence index, then copy
the validator's `observedAt` and `expiresAt` exactly. Revalidate the complete readiness record.

## Execute during a failed rollout

Use the validated plan only for its exact candidate, baseline, environment, schema state, and
freshness window. Open an incident when impact or integrity risk meets the canonical severity guide.

Record actual UTC actions and outcomes separately from the plan. If reality differs from any plan
assumption, stop, keep traffic/mutations at the smallest safe boundary, and choose a reviewed forward
fix or recovery. Do not edit the plan after failure to make execution appear compliant.
