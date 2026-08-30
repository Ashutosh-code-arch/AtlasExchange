# ADR-064 — PostgreSQL Backup, Restore, and Recovery Validation

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-064

## Context

Atlas treats PostgreSQL as the durable authority for identity, sessions, wallets, append-only
financial journals, orders, trades, projections, notifications, and administration evidence. A
running database and a successful migration are not proof that this state can be recovered after
operator error, corruption, credential loss, infrastructure failure, or an unsuccessful rollout.

ADR-063 deliberately leaves production traffic blocked until backup and restore have a tested
contract. Atlas has not selected a managed PostgreSQL vendor, object store, secret manager, or
runtime platform, so this decision must define portable recovery requirements without pretending
that a local logical dump provides production disaster recovery.

PostgreSQL documents SQL dumps, file-system backups, and continuous archiving as distinct techniques.
`pg_dump` creates a transactionally consistent single-database export while concurrent use
continues, but PostgreSQL explicitly cautions that it is generally not the sole regular production
backup mechanism. Point-in-time recovery requires a base backup and an unbroken WAL archive.

## Decision Drivers

The recovery design must:

1. protect financially authoritative and security-sensitive state;
2. define measurable recovery objectives before selecting a provider;
3. distinguish availability, backup creation, and proven restoration;
4. support recovery from operator mistakes at a point before the mistake;
5. preserve one reproducible migration history and application/schema pairing;
6. validate business invariants after restoration, not only database connectivity;
7. avoid destructive in-place restore automation;
8. keep credentials and private records out of logs and evidence;
9. provide a small repeatable local drill now; and
10. remain operable by one developer.

## Decision

Atlas adopts a layered PostgreSQL recovery contract:

```text
Managed PostgreSQL
├── encrypted automated backups
├── continuous WAL retention / point-in-time recovery
└── provider-independent logical archive
             ↓
isolated restore target
             ↓
schema + migration + financial validation
             ↓
reviewed traffic recovery decision
```

The managed backup and WAL layer is the primary production disaster-recovery mechanism. Portable
logical archives are defense-in-depth for inspection, migration rehearsal, and provider escape; they
are not a substitute for point-in-time recovery.

## 1. Recovery Objectives

Before first production-like traffic, the selected database platform must demonstrate these initial
engineering objectives:

| Objective | Initial target | Meaning |
| --- | ---: | --- |
| Recovery point objective (RPO) | no more than 5 minutes | At most five minutes of committed database state may be absent after an accepted recovery point |
| Recovery time objective (RTO) | no more than 60 minutes | Restore, validation, application recovery, and traffic decision complete within one hour |
| PITR window | at least 7 days | An operator can select a point before recent corruption or an accidental change |
| Portable logical retention | 35 daily recovery points | A vendor-independent database archive exists beyond the immediate PITR path |

These are requirements for provider selection and drill acceptance, not a public availability SLA.
Atlas must not claim that an objective is met until a timed drill in the selected environment proves
it. Product criticality, data volume, regulatory obligations, or real custody would require stricter
objectives and a new review.

## 2. Backup Layers

### Managed physical/PITR layer

The selected provider must offer encrypted automatic backups, continuous WAL-based point-in-time
recovery, monitored backup failures, documented restore procedures, and recovery to a separate
database instance or cluster. Backup storage must not depend solely on the availability of the
application runtime.

### Portable logical layer

Atlas creates a whole-database PostgreSQL custom-format archive using the approved PostgreSQL 18
client line. The archive uses `--no-owner` and `--no-privileges`; runtime roles and secret values are
recreated from controlled infrastructure and secret management rather than treated as application
data.

The logical archive must be encrypted before durable storage, transferred over authenticated
encrypted transport, access-controlled separately from ordinary application writes, checksummed,
and covered by retention/deletion policy. It must never be stored in Git, an application image,
browser-visible storage, or an ordinary API container filesystem.

Because `pg_dump` covers one database rather than cluster-global roles and tablespaces, those
objects remain an infrastructure provisioning responsibility. Atlas does not use a database dump as
a secret backup.

### Pre-change recovery point

Before a production migration or PostgreSQL upgrade that can make rollback unsafe, the operator
must confirm a recent successful backup/PITR point and a compatible restoration path. This does not
permit editing or automatically reversing an applied migration.

## 3. Backup Evidence

Every durable logical backup record must include, without credentials or row data:

- source environment and database identity;
- PostgreSQL server and client versions;
- start/completion time and result;
- archive format, byte size, SHA-256 digest, encryption/key reference, and storage identifier;
- application release/source revision and expected schema version;
- retention/expiry time; and
- backup-job identity.

A successful backup command is only backup evidence. It is not restore evidence.

## 4. Restore Isolation and Safety

Automated verification restores only into a new, isolated database or cluster. It must never issue
`--clean`, `DROP DATABASE`, schema replacement, or object deletion against the current production
database.

The repository's local drill generates its restore target internally under the exact namespace:

```text
atlas_recovery_drill_<16 lowercase hexadecimal characters>
```

Cleanup refuses any other database name. The local archive lives in a private temporary directory,
is deleted after the drill, and is explicitly reported as not retained. The drill reads the normal
local `atlas` database but never replaces it.

Production recovery uses a separate provider restore target and an explicit operator decision; it
does not reuse the local Compose automation.

## 5. Restore Validation

Recovery is accepted only when all of the following hold on one repeatable-read, read-only snapshot:

- restored `schema_version` equals the version derived from the matching release's final committed
  migration;
- every restored migration name and checksum exactly matches that release's committed history;
- every wallet owns exactly one available and one reserved ledger account;
- every journal has at least two contiguously positioned postings;
- every journal balances independently per asset;
- no user available or reserved ledger account has a negative derived balance; and
- aggregate restored counts for users, wallets, journals, orders, and trades are captured as
  comparison evidence.

Foreign keys and database constraints remain necessary but are not sufficient: successful
`pg_restore` and `/health/ready` do not prove the Financial invariants or the intended recovery point.

The validator must come from the application image/revision compatible with the restored backup.
Only after validation may the operator apply reviewed forward migrations, start the matching API
digest without traffic, run bounded smoke checks, and decide whether to route traffic.

## 6. Drill Cadence

Atlas performs and records restoration drills:

- before the first production-like deployment;
- at least monthly while an environment contains durable user or financial state;
- after changing the provider, backup policy, encryption mechanism, or recovery tooling;
- before and after a PostgreSQL major-version upgrade; and
- after a failed recovery or material recovery-process defect.

At least one quarterly drill must exercise the managed PITR path in the selected deployment
environment. Local logical drills provide fast regression evidence but do not satisfy that provider
drill requirement.

## 7. Incident Recovery Order

The generic recovery order is:

1. declare and timestamp the incident;
2. stop or fence writes when continued writes increase loss or ambiguity;
3. preserve logs and identify the last known-good time;
4. choose a recovery point and record the expected data-loss window;
5. restore into an isolated target;
6. verify archive/provenance evidence and run the matching recovery validator;
7. reconcile expected aggregate counts and incident-specific facts;
8. apply only reviewed compatible forward migrations;
9. start the matching API digest without public traffic;
10. verify readiness and bounded Identity, Financial, Trading, and Market Data smoke paths;
11. switch traffic through the controlled deployment boundary; and
12. preserve duration, chosen recovery point, validation, actual data loss, and follow-up actions.

DNS or connection-string switching, provider failover, and secret rotation remain platform-specific.

## 8. Security and Privacy

Backup access is privileged access to the entire Atlas dataset. Production requirements include:

- least-privilege backup and restore identities;
- encryption in transit and at rest;
- controlled key rotation and revocation;
- audited backup reads, restores, retention changes, and deletions;
- separation from ordinary application credentials;
- no database URLs, passwords, tokens, row values, or user identifiers in drill evidence; and
- sanitization or explicit authorization before restored production data enters a non-production
  environment.

Compromised or untrusted archives must not be restored: PostgreSQL warns that restoring a dump can
execute source-defined code. Source, digest, storage authority, and access history must be verified.

## 9. Repository Implementation

The initial repository provides:

```text
pnpm db:verify-recovery
pnpm db:recovery:drill:local
```

The first command validates the database in `DATABASE_URL` without mutation. The second requires the
existing PostgreSQL 18.4 Compose service, creates a custom-format archive, lists it, restores it in a
random isolated database, invokes the validator, emits privacy-safe JSON evidence, deletes the
archive, and drops only the generated target.

The compiled API image also exposes:

```text
node --enable-source-maps dist/platform/database/verify-recovery.js
```

Provider backup scheduling, remote encrypted storage, PITR automation, and production database
switching are intentionally not simulated in source before a platform is selected.

## Alternatives Considered

### Use `pg_dump` as the only production backup

Rejected because it cannot provide a recent point before an arbitrary incident, omits cluster-global
objects, and is not PostgreSQL's recommended sole regular production backup mechanism.

### Trust managed backups without restore drills

Rejected because existence, permissions, retention, corruption, documentation, and restoration time
remain unproven until recovery is exercised.

### Restore over the failed production database

Rejected because it destroys evidence, magnifies operator error, and removes the ability to compare
or retry the recovery.

### Validate only connectivity and schema version

Rejected because a reachable database can still contain changed migration history or invalid
financial state.

### Commit backup archives for reproducibility

Rejected because backups contain private mutable data, grow without bound, and do not belong in
source control.

## Consequences

### Positive

- Recovery has measurable pre-deployment requirements.
- PITR and portable archives cover different failure modes.
- Restore acceptance includes Financial invariants and immutable migration evidence.
- Local drills are safe, repeatable, private, and fast.
- Provider selection can evaluate explicit recovery capabilities.
- A backup cannot be mistaken for a tested restore.

### Negative

- Managed PITR and separate encrypted logical retention add cost and operational work.
- Drills require isolated capacity and operator time.
- Custom-format archives do not preserve all cluster-global objects.
- The validator increases coupling between recovery and the matching application release.
- Initial RPO/RTO values remain unproven until platform drills exist.

## Reconsider When

Review this decision when Atlas adopts real custody, materially larger datasets, multiple regions,
read replicas, partitioning, logical replication, a new PostgreSQL major, regulatory retention,
stricter availability targets, or a provider whose recovery model cannot meet these requirements.

## Related Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-011 — PostgreSQL Runtime and Local Development Strategy](ADR-011-postgresql-runtime-and-local-development-strategy.md)
- [ADR-060 — PostgreSQL Runtime Capacity, Timeout, and Saturation Policy](ADR-060-postgresql-runtime-capacity-timeout-and-saturation-policy.md)
- [ADR-063 — Initial Deployment Topology and Container Release Promotion](ADR-063-initial-deployment-topology-and-container-release-promotion.md)
- [PostgreSQL 18 — Backup and Restore](https://www.postgresql.org/docs/18/backup.html)
- [PostgreSQL 18 — `pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html)
- [PostgreSQL 18 — `pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html)
- [PostgreSQL 18 — `pg_dumpall`](https://www.postgresql.org/docs/18/app-pg-dumpall.html)
