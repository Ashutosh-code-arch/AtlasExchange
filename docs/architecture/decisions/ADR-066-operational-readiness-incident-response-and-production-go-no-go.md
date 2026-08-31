# ADR-066 — Operational Readiness, Incident Response, and Production Go/No-Go

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-31  
**Last reviewed:** 2026-08-31  
**Canonical owner/source:** ADR-066

## Context

Atlas now has production-shaped application images, immutable release identity, recovery validation,
security gates, protected metrics, performance tooling, and vendor-neutral deployment constraints.
Those capabilities are necessary but do not prove that a particular environment is safe to receive
traffic. The runtime, managed PostgreSQL provider, alert delivery, secret manager, DNS/certificate
ownership, and production evidence store are still unselected.

A solo developer also needs an incident process that is small enough to use under pressure without
confusing one person's current workload with one undifferentiated responsibility. Financial
integrity, account security, service availability, and communication require explicit decisions even
when the same person initially fills every role.

This decision establishes a repository-owned evidence and response boundary. It does not approve
Atlas for production, choose a vendor, invent alert thresholds without observations, or claim
regulatory readiness.

## Decision Drivers

The boundary should:

1. make production approval an explicit evidence-backed decision;
2. fail closed when a required control is missing, blocked, stale, or ambiguous;
3. tie approval to immutable API and web artifacts;
4. distinguish repository capability from environment proof;
5. preserve financial and security evidence during containment;
6. define clear incident authority for one developer and future collaborators;
7. support safe application rollback without pretending database rollback is symmetric;
8. avoid credentials, private records, and unsupported claims in evidence; and
9. remain portable until the deployment platform is selected.

# Decision

Atlas adopts an explicit production go/no-go record and a severity-based incident process.

```text
repository checks + environment drills + release identity
                         ↓
             readiness record validation
                         ↓
              explicit go / explicit no-go
                         ↓
          deploy, stop, contain, or roll back
```

Passing `pnpm verify`, image publication, a green provider dashboard, or an earlier successful
deployment is not by itself a production approval.

## 1. Current production status

Atlas is **not approved for production traffic** by this ADR. The committed readiness record is an
example with an explicit `no-go` outcome and placeholder release identity. A real decision must be
created for the exact target environment and release candidate outside source control when its
evidence contains provider or operational details.

Real custody, external market execution, deposits, and withdrawals remain outside the accepted
product scope. Enabling public traffic does not silently expand that scope.

## 2. Readiness record contract

The command is:

```bash
pnpm readiness:validate -- <readiness-record.json>
```

The versioned record identifies:

- `staging` or `production` as the target;
- stable semantic version and full source revision;
- immutable API and web SHA-256 image digests;
- the decision, UTC decision time, accountable decision-maker, and reason; and
- exactly the required readiness controls.

Each control has one status:

- `passed` — evidence references, observation time, and expiry are mandatory;
- `blocked` — the blocking reason is mandatory; or
- `not-evaluated` — the visible gap and next requirement are mandatory.

A `go` is valid only when every required control is `passed`, observed no later than the decision,
unexpired at that decision, and no older than its policy permits. A `no-go` remains a valid and useful
record because it preserves why traffic was refused. Validation emits only release identity, counts,
and control identifiers; evidence contents are not copied to logs.

The validator proves record structure and internal consistency. It cannot prove that an evidence
reference is truthful. The accountable decision-maker must inspect the underlying evidence.

## 3. Required controls and freshness

| Control | Required evidence | Maximum validity |
|---|---|---:|
| `runtime-database-selection` | Reviewed runtime and managed PostgreSQL architecture, ownership, support, and failure model | 90 days |
| `ingress-tls-dns` | Same-site HTTPS origins, certificate renewal ownership, exact proxy path, and private API reachability test | 30 days |
| `secrets-rotation` | Runtime secret-manager configuration and completed rotation/revocation drill | 90 days |
| `monitoring-alert-delivery` | Collector, retention, dashboards, actionable alert rules, and end-to-end notification test | 30 days |
| `database-capacity` | Aggregate connection budget and representative staging workload evidence | 30 days |
| `provider-pitr-drill` | Timed isolated provider point-in-time restore meeting the accepted RPO/RTO | 90 days |
| `logical-restore-drill` | Successful isolated archive restore and Atlas Financial validation | 31 days |
| `candidate-vulnerability-scan` | Dependency and per-platform registry scans for the candidate digests | 7 days |
| `release-provenance` | Verified source revision, SBOM, signatures/provenance, migrations, and candidate digests | 7 days |
| `rollback-plan` | Previous known-good digests, schema compatibility decision, operator, and traffic procedure | 7 days |
| `synthetic-smoke-tests` | Bounded staging tests for health, session, private ownership, trading, and Market Data | 1 day |
| `incident-response-exercise` | ADR-072-valid timed tabletop or simulation using the versioned runbook and tested contact path | 90 days |
| `product-scope-approval` | Explicit simulated-only scope, data/privacy review, public-support path, and disabled real custody | 30 days |

Freshness is measured between `observedAt` and `expiresAt`, while the evidence must still be valid at
`decidedAt`. Candidate-specific evidence cannot be reused merely because it remains within a time
window; its references must identify the candidate digests and environment.

## 4. Alert policy

Atlas must alert on user-impacting symptoms and correctness risk rather than treating every metric as
an emergency. Initial candidates include sustained readiness failure, unexpected HTTP 5xx,
admission rejection growth, PostgreSQL waiters or capacity exhaustion, projection failure/staleness,
event-loop delay, backup failure, certificate expiry, and security-gate regression.

Exact thresholds and notification windows are deployment evidence, not repository constants. They
must be selected from staging workload and scrape observations, documented with their response
action, and tested end to end before `monitoring-alert-delivery` can pass. A metric without an owner
and action is not an alert. A provider notification that never reaches the responsible person is not
working alert delivery.

## 5. Incident severity

Atlas uses four severities:

| Severity | Meaning | Examples | Initial action |
|---|---|---|---|
| SEV-1 | Active or credible risk to financial integrity, privileged access, secrets, private data, or broad service safety | Unbalanced ledger evidence, unauthorized admin action, confirmed credential compromise, destructive data event, unrecoverable production state | Declare immediately, stop unsafe mutations or traffic, preserve evidence, begin containment |
| SEV-2 | Material user-facing outage or degradation with no current evidence of integrity loss | Trading/Financial unavailability, persistent readiness failure, stuck critical projection, database saturation, exposed High/Critical vulnerability | Declare promptly, contain impact, restore service or roll back with explicit ownership |
| SEV-3 | Limited degradation or operational defect with bounded impact | One noncritical feature impaired, recoverable delayed processing, noisy alert, Medium vulnerability requiring planned response | Track, mitigate during a bounded response window, escalate if impact grows |
| SEV-4 | Informational event or routine maintenance finding | Non-exploitable advisory, documentation drift, capacity observation below an action threshold | Record and prioritize through normal work |

Uncertainty does not justify lowering severity. If financial correctness, unauthorized access, secret
exposure, or private-data impact cannot be reasonably ruled out, begin at the higher plausible
severity and downgrade only with recorded evidence.

## 6. Incident roles and authority

Every declared incident names these roles:

- **Incident Commander** owns severity, priorities, state, role assignment, handoff, and closure.
- **Operations Lead** is the only role directing production changes during the incident.
- **Communications Lead** owns periodic internal, provider, support, and—when applicable—public
  updates.
- **Scribe** records UTC events, evidence references, hypotheses, decisions, actions, and results.

For the initial solo project, the declaring developer holds every role until one is explicitly
delegated. Naming the roles still matters: it forces deliberate switches between investigation,
change execution, and communication. An explicit handoff names the new owner and receives
acknowledgement.

The Incident Commander has stop-the-line authority. No release schedule overrides a `no-go`, active
SEV-1, failed recovery validation, or unknown financial-integrity state.

## 7. Incident lifecycle

The operational runbook implements this lifecycle:

1. detect, open an incident record, declare severity, and name the Incident Commander;
2. establish impact, affected release/environment, and a reliable coordination channel;
3. contain unsafe behavior while preserving logs, audit facts, image identity, database recovery
   points, and other relevant evidence;
4. investigate scope and root cause without copying credentials or private records into the record;
5. remediate using reviewed changes, known-good immutable artifacts, credential revocation, or
   isolated database recovery as appropriate;
6. validate health, readiness, database invariants, authentication, authorization, Financial,
   Trading, and Market Data behavior before restoring traffic or mutations;
7. monitor for recurrence and communicate recovery; and
8. close with a blameless review, durable corrective actions, owners, and due dates.

Containment may freeze only affected mutations while preserving a safe read-only experience, or may
remove all traffic when correctness/privacy cannot be isolated. The response chooses the smaller
safe boundary, not the smaller visible outage.

## 8. Rollback and database authority

Application traffic may return to recorded prior image digests only after verifying compatibility
with the already-applied schema and public contracts. An applied migration is never edited,
automatically reversed, or hidden by an older container. A database correctness event follows the
isolated recovery runbook and requires its schema and Financial validation before traffic.

External calls should be stopped or fenced before recovery when replay could duplicate side
effects. Current simulated funding and withdrawals do not authorize assumptions for future custody
providers.

## 9. Communications and evidence

Incident and readiness records may contain aggregate counts, timestamps, control IDs, release
identity, sanitized errors, provider evidence references, and decisions. They must not contain
credentials, session values, database URLs, raw private records, full request bodies, or financial
values attributable to a user.

Atlas does not yet claim a public status page, round-the-clock staffed on-call rotation, contractual
support target, or legally complete breach-notification procedure. Those require named providers,
audiences, jurisdictions, and human coverage. A production `product-scope-approval` must document
the actual support, privacy, and notification owners before public users are accepted.

## Alternatives Considered

### Treat successful CI and image publication as production approval

Rejected because repository checks do not prove ingress, secret rotation, alert delivery, provider
recovery, capacity, or the deployed candidate.

### Keep a prose-only launch checklist

Rejected because omissions, stale evidence, mutable tags, and ambiguous approval would remain easy
to miss and impossible to validate consistently.

### Select fixed alert thresholds before a platform exists

Rejected because scrape cadence, traffic, resources, provider semantics, and delivery paths are not
known. The signals and required proof are stable; exact thresholds require observed deployment
evidence.

### Require separate people for every incident role

Rejected initially because Atlas has one developer. Explicit roles and handoffs are retained so the
process can expand without redefining authority.

### Automatically roll back every failed deployment

Rejected because schema compatibility, financial mutations, and external side effects make blind
rollback unsafe.

## Consequences

### Positive Consequences

- Production approval is explicit, candidate-bound, complete, and time-bounded.
- A valid `no-go` preserves gaps instead of hiding them.
- Incident authority and role changes remain clear for one person or a future team.
- Financial-integrity and security uncertainty fail safely.
- Vendor selection can happen later without changing the repository-owned control vocabulary.

### Negative Consequences

- Thirteen controls add evidence work to every production decision.
- The validator cannot authenticate external evidence or judge whether a test was performed well.
- Fresh evidence expires and must be renewed even when source code has not changed.
- Solo incident response still lacks independent review and continuous staffed coverage.
- Platform-specific alert, failover, secret, communication, and legal procedures remain unfinished.

## Reconsider When

Review this decision when Atlas selects deployment and monitoring providers, introduces real custody
or external execution, accepts users in a new jurisdiction, adds staffed responders, defines service
objectives, automates deployment, horizontally scales the API, or finds that a control's evidence
window does not match observed risk.

## External References

- [NIST SP 800-61 Rev. 3 — Incident Response Recommendations and Considerations for Cybersecurity Risk Management](https://csrc.nist.gov/pubs/sp/800/61/r3/final)
- [Google SRE — Incident Management Guide](https://sre.google/resources/practices-and-processes/incident-management-guide/)

## Related Decisions

- [ADR-012 — Configuration, Environment, and Secrets Strategy](ADR-012-configuration-environment-and-secrets-strategy.md)
- [ADR-015 — API Health, Readiness, and Process Lifecycle Strategy](ADR-015-api-health-readiness-and-process-lifecycle-strategy.md)
- [ADR-016 — Continuous Integration and Quality Gate Strategy](ADR-016-continuous-integration-and-quality-gate-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-052 — Administration Authorization and Audit Foundation](ADR-052-administration-authorization-and-audit-foundation.md)
- [ADR-058 — Application Metrics and Protected Scrape Boundary](ADR-058-application-metrics-and-protected-scrape-boundary.md)
- [ADR-059 — HTTP Performance Baseline and Load-Testing Policy](ADR-059-http-performance-baseline-and-load-testing-policy.md)
- [ADR-060 — PostgreSQL Runtime Capacity, Timeout, and Saturation Policy](ADR-060-postgresql-runtime-capacity-timeout-and-saturation-policy.md)
- [ADR-061 — Runtime and Market Data Projection Observability](ADR-061-runtime-and-market-data-projection-observability.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [ADR-064 — PostgreSQL Backup, Restore, and Recovery Validation](ADR-064-postgresql-backup-restore-and-recovery-validation.md)
- [ADR-065 — Software Supply-Chain, Vulnerability, and Secret Response](ADR-065-software-supply-chain-vulnerability-and-secret-response.md)
- [ADR-072 — Incident-Response Exercise and Evidence](ADR-072-incident-response-exercise-and-evidence.md)
