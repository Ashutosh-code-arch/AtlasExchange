# Atlas Operational Readiness and Incident Runbook

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-08-31

This runbook implements ADR-066. It is a decision and response procedure, not evidence that Atlas is
production-ready. The repository's example record is deliberately `no-go`.

## Production go/no-go procedure

Create a new record from
[`production-readiness-record.example.json`](production-readiness-record.example.json) in the
restricted deployment evidence store. Do not overwrite the example and do not commit provider
details, internal endpoints, credentials, user records, or confidential evidence to Git.

Replace the placeholder release with the exact candidate version, full source revision, and API/web
image digests. Evaluate every control:

- [ ] Runtime and managed PostgreSQL are selected, reviewed, supported, and ownership is named.
- [ ] DNS, certificate renewal, same-site HTTPS origins, exact proxy hops, and private API
      reachability are proven.
- [ ] Production secrets are injected by a secret manager and a rotation/revocation drill passed.
- [ ] Metrics collection, retention, dashboards, actionable thresholds, and alert delivery passed an
      end-to-end test.
- [ ] Aggregate PostgreSQL connection capacity and representative staging load passed.
- [ ] A provider PITR drill met the accepted RPO/RTO in an isolated target.
- [ ] A recent portable archive restored and passed Atlas schema and Financial validation.
- [ ] Dependencies and every published platform image digest passed current vulnerability gates.
- [ ] Release source, migrations, SBOM, provenance, signatures, and both digests were verified.
- [ ] Previous known-good digests, schema compatibility, operator, and traffic rollback are recorded.
- [ ] Candidate staging smoke tests passed for health, session, ownership, Financial, Trading, and
      Market Data.
- [ ] The current incident process and contact path passed a timed exercise.
- [ ] Simulated-only product scope, privacy/support ownership, and disabled real custody are approved.

For each passed control, record references to the retained evidence plus `observedAt` and
`expiresAt`. Evidence expiry may not exceed the control policy in ADR-066. For a blocked or
not-evaluated control, record the concrete gap in `notes`.

Replace a control entry with this shape only after inspecting its evidence:

```json
{
  "id": "synthetic-smoke-tests",
  "status": "passed",
  "observedAt": "2026-08-31T11:00:00.000Z",
  "expiresAt": "2026-09-01T11:00:00.000Z",
  "evidence": ["deployment-evidence://release-0.1.0/smoke-tests"]
}
```

The reference syntax is owned by the selected evidence store; the example is not a real location.

Set `decision.outcome` to `go` or `no-go`, name the accountable decision-maker, explain the reason,
and validate:

```bash
pnpm readiness:validate -- /restricted/path/readiness-record.json
```

A non-zero exit is a hard stop. A successful command means the record is internally consistent; the
decision-maker must still inspect every referenced artifact. Store the validated record with the
release evidence. Never convert a blocker to `passed` merely to satisfy the validator.

## Release execution after go

Follow the [release and deployment runbook](release-and-deployment.md). Keep the validated record,
previous digests, database recovery evidence, and incident contact path available outside the
service being deployed.

Before traffic:

1. resolve and verify the recorded digests;
2. run the migration job once;
3. start the candidate API without public traffic;
4. require `/health/live` and `/health/ready`;
5. start the web digest with the reviewed runtime API origin;
6. run bounded synthetic smoke tests; and
7. enable traffic only under the approved scope.

If evidence changes after the decision—different digest, migration, route, secret, database target,
or material configuration—the old record does not approve the changed release.

## Declaring an incident

Anyone who observes credible user, integrity, privacy, security, or availability risk may declare an
incident. Open a durable incident record and capture:

```text
Incident ID:
Opened at (UTC):
Severity: SEV-1 | SEV-2 | SEV-3 | SEV-4
Incident Commander:
Operations Lead:
Communications Lead:
Scribe:
Environment and release digests:
Observed impact and start time:
Known-safe facts:
Unknowns and current hypotheses:
Containment decision:
Next update time:
Timeline (UTC action, actor, result, evidence reference):
```

For a solo response, put the same name in each role. When another responder joins, hand off one role
explicitly and record their acknowledgement.

## Severity guide

- **SEV-1:** credible financial-integrity loss, unauthorized privilege, secret/private-data
  compromise, destructive state change, or broad unsafe behavior. Stop unsafe mutations or traffic
  immediately and preserve evidence.
- **SEV-2:** material outage/degradation without current integrity-loss evidence, including persistent
  readiness failure, database saturation, stuck critical projection, or exposed High/Critical
  vulnerability. Contain and restore urgently.
- **SEV-3:** limited bounded impact, recoverable processing delay, noisy alert, or planned Medium
  vulnerability response. Track with an owner and bounded response time.
- **SEV-4:** informational observation or routine maintenance finding.

Start at the highest plausible severity while financial, access, credential, or private-data impact
is uncertain. Record evidence before downgrading.

## First response

1. Declare severity and the Incident Commander; stop unrelated production changes.
2. Record the exact environment, release version, source revision, API/web digests, schema version,
   and first observed UTC time.
3. Decide whether to disable all traffic, freeze affected mutations, disable one capability, revoke a
   credential, or continue read-only service. Prefer the smallest boundary that is demonstrably safe.
4. Preserve relevant structured logs, audit facts, metrics, traces if available, database recovery
   points, provider events, and deployment evidence before destructive remediation.
5. Do not paste secrets, session values, database URLs, raw request bodies, or private user/financial
   records into the incident document.
6. Name the next update time even when there is no new result.

Only the Operations Lead directs production changes. Every change records actor, UTC time, expected
result, observed result, and rollback/next action.

## Signal triage

Use these existing Atlas signals together; none is proof on its own:

- `/health/live` — process responsiveness only;
- `/health/ready` — current database/schema readiness for traffic;
- protected `/internal/metrics` — HTTP failures/latency, admission rejection, PostgreSQL pool
  capacity/waiting, event-loop health, process resources, and projection state/lag/failures;
- structured request/security/audit logs — correlation and accepted security-sensitive actions;
- release record and OCI provenance — deployed source and immutable artifacts;
- provider evidence — ingress, certificate, runtime, database, backup, SMTP, and alert delivery; and
- synthetic checks — bounded behavior through the actual ingress path.

Alert thresholds must link to a user/correctness symptom, an owner, and an action. Tune them from
staging and production-like observations. Do not silence an unexplained alert to make a release
appear healthy.

## Common containment paths

### Suspected financial inconsistency

Stop affected Financial and Trading mutations. Preserve the database and release state. Do not
repair balances manually. Run read-only investigation and use the recovery validator only against an
isolated restore. Treat any failed double-entry, account-pair, migration, or non-negative-user-account
check as SEV-1 until explained.

### Suspected credential or session compromise

Revoke or rotate the credential first, then investigate exposure and remove it from source/config.
Revoke affected sessions when the scope permits. Preserve safe metadata, not the credential value.
History rewriting does not revoke a credential and requires a separate coordinated decision.

### Failed application rollout

Stop new traffic to the candidate. Confirm whether its migrations were applied. Route to recorded
prior digests only if they remain schema- and contract-compatible. Never edit or reverse an applied
migration as an emergency shortcut.

### Database loss or destructive state

Fence writes and follow the [database recovery runbook](database-recovery.md). Restore into a new
isolated target, validate schema and Financial invariants, run incident-specific checks, then make a
reviewed traffic switch. Never overwrite the affected primary merely to shorten recovery.

### Exposed High/Critical vulnerability

Determine candidate/runtime exposure, reachable attack surface, exploitation evidence, and available
fixed artifact. Stop publication. If deployed risk is credible, contain the route/capability or move
to a verified fixed/known-good digest. A blanket ignore is not remediation.

## Recovery validation

Before restoring traffic or mutations, record successful checks appropriate to the incident:

```bash
pnpm verify
pnpm build
pnpm test:e2e
pnpm test:performance
pnpm containers:build
pnpm security:check
pnpm db:recovery:drill:local
```

Not every command belongs in every incident, and a local result cannot replace provider evidence.
At minimum confirm liveness, readiness, correct release identity, authentication/session behavior,
owner isolation, affected Financial/Trading behavior, projection recovery, database saturation, and
the original failure symptom. Use approved synthetic identities; do not experiment with user state.

Continue elevated observation after recovery. Reopen or raise severity when the symptom recurs or
the evidence no longer supports the declared scope.

## Communication

The Communications Lead records predictable UTC updates containing:

- current user-visible impact and affected scope;
- actions completed since the last update;
- current containment/recovery state;
- known unknowns without speculation; and
- next update time.

Do not claim that data, funds, or credentials are safe until investigation supports it. Public,
provider, legal, regulatory, and affected-user notification requirements are platform, audience, and
jurisdiction specific; engage the named owners from the production scope evidence.

## Closure and review

Close only after the original symptom is absent, correctness/security checks pass, monitoring is
stable, affected stakeholders receive the recovery update, and remaining risks have named owners.

For SEV-1 and SEV-2—and repeated SEV-3—complete a blameless review containing:

- impact and precise timeline;
- detection source and why earlier controls did or did not detect it;
- contributing technical and process conditions;
- containment and recovery decisions, including unsuccessful actions;
- evidence supporting restored correctness;
- corrective actions with owner, priority, and due date; and
- required ADR, runbook, alert, test, recovery, or readiness-control changes.

Run a tabletop or simulation before first production-like traffic and at least every 90 days. A
failed exercise blocks `incident-response-exercise` until the discovered gaps are corrected and the
exercise is repeated.
