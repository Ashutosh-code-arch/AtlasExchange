# Atlas PostgreSQL Recovery Runbook

**Classification:** Canonical  
**Status:** Active  
**Last reviewed:** 2026-08-30

This runbook implements ADR-064. It separates a local tooling drill from a production provider
recovery. Passing the local drill does not prove the production RPO, RTO, encryption, retention, or
PITR path.

## Local logical recovery drill

Start and migrate the normal local PostgreSQL service:

```bash
pnpm db:up
pnpm db:migrate
```

Run:

```bash
pnpm db:recovery:drill:local
```

The command:

1. confirms the Compose PostgreSQL service is reachable and uses PostgreSQL 18;
2. writes a custom-format logical archive to a private temporary directory;
3. checks that `pg_restore` can list the archive;
4. creates a random `atlas_recovery_drill_<hex>` database from `template0`;
5. restores atomically with owner and ACL restoration disabled;
6. runs the read-only Atlas recovery validator;
7. emits JSON evidence containing archive digest/size, timings, schema/migration evidence, invariant
   results, and aggregate row counts;
8. drops only the generated drill database; and
9. deletes the temporary archive.

If `ATLAS_POSTGRES_PORT` was used for `pnpm db:up`, provide the same value to the drill. The drill
does not start PostgreSQL, migrate the source, retain a backup, or modify the source database.

## Validate an existing isolated restore

Set `DATABASE_URL` to the isolated target and run:

```bash
pnpm db:verify-recovery
```

In the API image for the matching release, run:

```bash
node --enable-source-maps dist/platform/database/verify-recovery.js
```

The command is read-only. A non-zero exit means the database must not receive application traffic.
Do not point verification tooling at an untrusted dump source; restore execution can run
source-defined database code.

## Select a production recovery point

Record:

- incident start and operator;
- affected environment and release;
- last known-good time and supporting evidence;
- selected PITR timestamp or logical archive identifier;
- expected RPO/data-loss interval;
- previous API/web digests and schema version; and
- whether writes have been stopped or fenced.

Prefer a PITR point immediately before the harmful event while preserving enough margin for clock
uncertainty and in-flight transactions. Do not overwrite the affected primary.

## Restore and verify

1. Create a separate managed PostgreSQL restore target.
2. Confirm network and credentials permit only the recovery operators and validation job.
3. Verify backup identity, encryption/key access, digest where applicable, PostgreSQL compatibility,
   and restore completion.
4. Use the API image/source revision compatible with the restored schema.
5. Run the recovery validator.
6. Compare aggregate row counts with backup/job evidence and check incident-specific facts.
7. Record validator output and elapsed time without database URLs, secrets, or record contents.
8. Apply reviewed forward migrations only if the intended application release requires them.
9. Start the API digest without public traffic and require liveness/readiness.
10. Run bounded session, wallet/balance, order/history, and public Market Data smoke checks using
    approved synthetic accounts.

Any failed migration, schema, journal, balance, or incident-specific check rejects the target.

## Switch traffic

Traffic switching is platform-specific and requires a reviewed operator action. Before switching:

- record the restored database identity and chosen point;
- confirm the API uses the intended secret/configuration set;
- confirm simulated funding and withdrawals use the target environment policy;
- preserve the affected primary read-only when investigation requires it; and
- prepare the previous application digests without assuming they are compatible with a newer
  schema.

After switching, monitor readiness, error rates, database saturation, event-loop health, projection
lag, authentication, and financial smoke results. Record actual recovery time and estimated data
loss.

## Drill evidence checklist

A production or staging drill record contains:

- date, operator, environment, drill scenario, and approval;
- backup/PITR source and selected point;
- server/client versions, release revision, and schema version;
- restore start/end time and total RTO;
- expected and observed RPO;
- migration-history and Financial invariant results;
- aggregate source/restore comparison appropriate to the backup method;
- smoke-test results;
- cleanup or retained-investigation target;
- discovered defects and owners; and
- confirmation that no credential or private record entered the evidence.

Run a provider PITR drill before first production-like traffic, quarterly thereafter, and whenever
the recovery mechanism materially changes. Run restoration drills at least monthly while durable
user or financial state exists.

## Failure handling

If a drill or recovery fails:

1. keep traffic off the target;
2. preserve the failed target when it contains useful evidence;
3. record the exact failing stage and safe error output;
4. select another verified recovery point or repair the recovery process;
5. do not weaken invariant checks to make a target pass; and
6. repeat the complete timed drill after correction.

The absence of a recoverable target is an operational incident. A backup dashboard showing green is
not sufficient evidence.
