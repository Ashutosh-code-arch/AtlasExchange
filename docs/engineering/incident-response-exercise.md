# Atlas Incident-Response Exercise Runbook

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-08-31

This runbook implements ADR-072. It prepares and validates a timed exercise; it does not create a
contact path, staging environment, real incident, or passing readiness result.

## Current state

```text
Exercise record validator:          implemented and repository-tested
Canonical incident runbook:         implemented
Selected live contact path:         no evidence
Timed staging exercise:             not performed
Restricted evidence store:          not selected
incident-response-exercise control: blocked
```

## Prepare

1. Choose `tabletop` unless a reviewed staging simulation has a smaller, reversible boundary.
2. Choose one supported scenario and write a synthetic inject with expected severity.
3. Resolve the full Git revision containing
   `docs/engineering/operational-readiness.md`; do not record `main` or another mutable ref.
4. Assign all four roles. One operator may be named for every role.
5. Select a real, bounded contact path that the exercise can test without alarming users or external
   emergency services.
6. Create a restricted evidence directory outside Git and a new record from
   [the failed documentation example](incident-exercise-record.example.json).
7. Replace every example field. Never turn example references or results into claimed evidence.

Keep credentials, cookies, database URLs, raw logs, private records, and provider secret values out
of the structured record. Store any necessary detailed evidence separately and use opaque references.

## Facilitate

Start the exercise clock before presenting the inject. The Scribe records canonical UTC events as
the operator uses the canonical incident runbook:

1. `inject` — present the symptom without prescribing a cause;
2. `incident-declared` — state severity, affected scope, roles, and next update time;
3. `containment-decision` — choose the smallest safe boundary and identify unsafe shortcuts;
4. `status-communication` — send the bounded test update through the selected contact path;
5. `recovery-validation` — validate the original symptom and relevant correctness/security checks;
6. `closure-decision` — state the evidence for closure and own every remaining risk.

Additional events may repeat any event type, but the first occurrence of the six required stages must
remain in response order. Every event timestamp must fall inside the exercise window. The entire
exercise lasts at least 15 minutes and no more than eight hours.

For a simulation, stop immediately if the boundary reaches production, a real user, real custody,
personal data, an unapproved provider resource, or an irreversible operation. Restore the staging
boundary and retain sanitized failure evidence.

## Evaluate

Mark each required objective `passed` or `failed` and attach at least one opaque evidence reference
to every passed objective. Recovery validation also requires an evidence reference in its timeline
event. A reference points to evidence; it must not contain evidence content or credentials itself.

Create one corrective action for every material gap:

- use `IRX-<positive integer>` IDs within the record;
- assign Critical, High, Medium, or Low severity;
- name an owner and canonical UTC due time;
- keep new actions `open`; and
- require evidence before marking an action `closed`.

Use `not-tested` only when the path was not exercised; a delivered test that did not reach its
intended operator is `failed`. Do not pass the exercise when the contact test failed or was not run,
any objective failed, or a Critical/High action remains open. Record a failed outcome instead,
correct the gaps, and repeat with a new exercise ID.

## Validate

Run from an environment that can read the restricted record without printing it:

```bash
pnpm incident:exercise:validate -- /restricted/path/incident-exercise-record.json
```

The command emits only a sanitized summary. Require:

- `outcome` is `passed`;
- `readinessEligible` is `true`;
- `failedObjectives` is `0`;
- observation and expiry timestamps match the exercise end and 90-day policy; and
- the operator has reviewed every referenced source artifact.

A successful command with `outcome: failed` or `readinessEligible: false` proves only that the record
is structurally valid. It does not pass readiness.

## Attach to production readiness

For `incident-response-exercise` in the ADR-066 record:

- set `status` to `passed` only after the checks above;
- use the validator's `observedAt` and `expiresAt` exactly; and
- reference the restricted structured record plus the reviewed source-evidence index.

Then run:

```bash
pnpm readiness:validate -- /restricted/path/production-readiness-record.json
```

The accountable decision-maker verifies that the record belongs to the actual exercise and that its
evidence supports the claims. If it is stale, failed, or cannot be reviewed, keep the control blocked.

## After the exercise

Update affected runbooks, alerts, tests, ADRs, ownership, and contact paths. Closed actions retain
their evidence references. Do not edit an old record to represent a later repeat; create a new
exercise ID and preserve the earlier failure under the evidence-retention policy.
