# ADR-048 — Atomic Financial Notification Capture

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-048

## Context

ADR-047 establishes a durable Notification inbox and transaction-bound writer for completed
simulated deposits and withdrawals. The schema and writer are not yet connected to Financial source
operations, so normal API commands do not create inbox facts.

Atlas must decide exactly when Financial emits a notification, how it participates in the existing
ledger transaction, what repeated idempotent commands do, how the dependency between modules is
directed, and whether historical simulated activity is backfilled.

The notification must describe the committed Financial outcome rather than restating untrusted
request input. Capture cannot weaken Financial's atomic journal, balance, wallet, and idempotency
guarantees.

## Decision Drivers

The integration should:

1. create a fact only for a newly committed completed business outcome;
2. commit the source record, journal, balance movement, and notification atomically;
3. derive exact payload data from the persisted Financial record;
4. preserve existing command idempotency without duplicate notifications;
5. avoid notifying failed, blocked, conflicting, or merely attempted commands;
6. keep Financial independent of Notifications persistence and domain implementation;
7. preserve safe generic HTTP failure behavior if required capture fails; and
8. define rollout behavior for Financial records created before notification capture existed.

# Decision

Newly created simulated deposits and withdrawals will capture their corresponding Notification fact
inside the same PostgreSQL transaction as the Financial operation.

## 1. Emission points

`CreateSimulatedDeposit` emits `financial.deposit_credited` only after the deposit record and balanced
journal have been persisted successfully.

`CreateSimulatedWithdrawal` emits `financial.withdrawal_completed` only after the withdrawal record
and balanced journal have been persisted successfully.

The transaction does not emit for:

- wallet creation by itself;
- a missing or disabled asset;
- disabled simulated funding or withdrawals;
- a missing wallet;
- insufficient available balance;
- an idempotency conflict;
- an existing identical command retry; or
- an exception before the completed source record exists.

Immediate HTTP and browser command feedback remains independent of durable inbox presentation.

## 2. Payload authority

Notification input is built from the persisted Financial record:

~~~text
ownerId    ← authenticated Financial command owner
sourceId   ← persisted deposit or withdrawal ID
assetCode  ← persisted AssetQuantity denomination
amount     ← persisted AssetQuantity canonical decimal
occurredAt ← persisted creditedAt or completedAt
~~~

The original request body is not copied after persistence. This ensures the inbox fact uses the same
canonical exact quantity and occurrence time returned by Financial.

No wallet ID, journal ID, ledger account, posting, intent hash, idempotency key, request ID, or HTTP
credential enters the Notification payload.

## 3. Transaction and failure semantics

The PostgreSQL Financial transaction binds a Notifications publisher to the same Kysely transaction.
Notification insertion occurs before the transaction callback returns. Therefore:

~~~text
Financial source + journal + balances + notification
                         ↓
              one commit or one rollback
~~~

If Notification validation or persistence fails, the entire new Financial operation rolls back,
including a newly created wallet and all journal effects. The HTTP boundary treats the unexpected
failure through its existing generic `500 INTERNAL_SERVER_ERROR` containment and does not claim the
deposit or withdrawal succeeded.

Atlas accepts the small synchronous insert as part of the required command transaction. External
channel delivery remains asynchronous future work and must not be performed inside this transaction.

## 4. Dependency direction

Financial owns a narrow application port named `FinancialNotificationPublisher`. Its inputs use
Financial's public outcome vocabulary but contain no Notifications persistence types.

Notifications implements that port by mapping the two methods to its typed `CreateNotification`
capability. The composition root supplies a publisher factory to each Financial transaction runner,
which binds the adapter to the active transaction.

Financial does not import Notifications repositories, schemas, domain records, or SQL. Notifications
remains the sole owner of `notifications.*` persistence and may depend on Financial's public port for
adapter typing.

## 5. Retry behavior

A successful first command commits one source record and one notification. An identical Financial
retry returns the existing source result before the publisher is invoked, so it creates no second
notification.

Concurrent identical commands remain serialized by Financial's existing idempotency lock. Only the
winning creation path emits; the other request observes the existing result. Notifications' unique
`(owner_id, kind, source_id)` boundary remains a second defensive idempotency guarantee.

Changed-intent retries and operationally rejected commands create no notification.

## 6. Rollout and historical records

Capture begins for Financial operations created after this integration is deployed. Atlas will not
backfill notifications for earlier simulated deposits or withdrawals.

A retry of a pre-integration source record returns that existing Financial resource and does not
synthesize a historical notification. Backfilling would require a separately reviewed deterministic
job, explicit cutoff, user-experience policy, and proof that it cannot duplicate live capture. The
MVP does not have a product need for historical inbox reconstruction.

## Alternatives Considered

### Emit before Financial persistence

Rejected because a notification could describe an operation that later fails or rolls back.

### Emit after the Financial transaction commits

Rejected because a crash or database failure between the two commits can permanently lose the
notification while the financial outcome remains successful.

### Pass the request payload directly to Notifications

Rejected because request strings are not the authoritative canonical persisted representation.

### Emit again for every identical retry

Rejected because command retries are transport behavior, not new business outcomes.

### Backfill all prior deposits and withdrawals during migration

Rejected because it would suddenly populate historical activity, lengthen deployment work, and
introduce overlap risk without an accepted product requirement.

### Let Financial insert into the Notifications table

Rejected because it violates table ownership and couples Financial persistence to another module's
schema and versioning rules.

### Make notification capture best effort

Rejected for the durable in-app inbox because silent loss would make completion coverage
nondeterministic. External delivery may later be best-effort per channel after durable capture.

## Consequences

### Positive Consequences

- Every newly committed simulated funding movement has exactly one durable completion fact.
- Financial and Notification persistence cannot diverge during normal command execution.
- Exact amounts and times come from persisted domain records rather than client input.
- Identical and concurrent retries do not create duplicate inbox records.
- Failed and rejected attempts produce no misleading completion notification.
- Financial depends only on its own narrow application port, preserving module ownership.
- Unit, real-PostgreSQL, and composed HTTP tests prove mapping, rollback, retry, and wiring behavior.

### Negative Consequences

- Notification database availability is now required for new simulated deposits and withdrawals.
- The Financial transaction performs one additional constrained insert.
- Historical Financial activity does not appear in the future inbox.
- The application has no public way to view captured facts until the HTTP delivery increment.
- Adding more Financial kinds requires explicit port, payload, and schema evolution.

## Reconsider When

Review this decision when notification insertion materially affects Financial command latency,
Financial and Notifications no longer share a transaction-capable database, historical inbox
backfill gains a product requirement, or a durable outbox becomes necessary for cross-service
delivery.

## Related Decisions

- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-022 — Simulated Deposit Lifecycle and Custody Boundary](ADR-022-simulated-deposit-lifecycle-and-custody-boundary.md)
- [ADR-024 — Simulated Withdrawal Lifecycle and Custody Boundary](ADR-024-simulated-withdrawal-lifecycle-and-custody-boundary.md)
- [ADR-047 — Durable Notification Inbox and Event-Capture Foundation](ADR-047-durable-notification-inbox-and-event-capture-foundation.md)
