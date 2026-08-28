# ADR-047 — Durable Notification Inbox and Event-Capture Foundation

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-047

## Context

Atlas has completed transactional Identity, Financial, Trading, Market Data, and Portfolio
boundaries. Phase 6 now needs Notifications, but the word can describe several materially different
systems: ephemeral browser feedback, a durable user inbox, transactional security email, external
push delivery, operational alerting, or market-price alerts.

The existing browser already gives immediate command feedback, and Identity owns purpose-specific
verification and password-recovery email. Neither is a durable user Notification model. Atlas needs
a foundation that can record important committed business outcomes exactly once, preserve owner
privacy, support unread state later, and participate in the source transaction without introducing a
broker, cross-module table access, or unreliable post-commit dual writes.

This decision establishes durable capture and persistence. HTTP listing, read commands, browser
presentation, source-module integration, realtime delivery, external providers, preferences, and
retention execution remain separate increments.

## Decision Drivers

The foundation should:

1. record only committed, user-relevant business outcomes;
2. create a notification atomically with the source operation when integration is added;
3. remain idempotent under request, transaction, and process retries;
4. preserve exact financial values without binary floating point;
5. keep content immutable while allowing monotonic read state;
6. isolate ownership without exposing or trusting a client-selected owner;
7. keep Notifications as the sole owner of its persistence representation;
8. avoid storing presentation copy that will become stale or inconsistent across clients; and
9. avoid external delivery and orchestration infrastructure before it has a demonstrated need.

# Decision

Atlas will introduce a **durable, owner-scoped in-app notification inbox** backed by PostgreSQL.

## 1. Initial notification meaning

The first schema version accepts two completed Financial outcomes:

- `financial.deposit_credited`;
- `financial.withdrawal_completed`.

Each record stores an owner, kind, source-resource identifier, strict versioned payload, source
occurrence time, and database creation time. The initial payload contains canonical `assetCode` and
exact positive decimal `amount` strings.

Pending states, attempted commands, HTTP failures, optimistic browser actions, and Market Data price
changes do not create durable notifications. Trading outcomes, security activity, and additional
Financial events require explicit typed additions and source-specific semantics rather than generic
free-form events.

## 2. Facts, not presentation copy

Notifications persist typed facts, not titles, prose, HTML, locale, routes, or rendered currency.
The future delivery boundary will map a known kind and schema version to presentation. This prevents
old database rows from freezing copy or accepting unsafe arbitrary markup.

Payloads are strict JSON objects. Unknown keys, noncanonical asset codes, zero or noncanonical
amounts, unknown kinds, and unsupported schema versions are rejected in both the domain and
PostgreSQL constraints.

## 3. Transaction-bound capture

Notifications exposes a public `NotificationWriter` capability and PostgreSQL binder. A source use
case will receive that capability through its application transaction context. The implementation
uses the caller's existing PostgreSQL transaction; source state and notification capture therefore
commit or roll back together.

Source modules will not import Notifications repositories or write `notifications.*` tables. The
composition and persistence adapter bind the Notifications capability to the shared transaction.
The foundation proves rollback participation before any source use case is changed.

Atlas does not use an after-commit callback, in-memory event emitter, or best-effort second write.
Those approaches can lose a notification after a successful source commit. A broker-backed outbox
becomes relevant only when external asynchronous consumers justify it.

## 4. Idempotency and conflicts

The logical identity is:

~~~text
(owner_id, kind, source_id)
~~~

The tuple is unique. An identical retry returns the existing immutable notification. A retry that
reuses the tuple with a different payload or occurrence time is an invariant conflict; it neither
overwrites the original nor creates another record. Concurrent identical attempts serialize through
the database uniqueness boundary.

The same source UUID may legitimately appear for another owner or another kind. Notification IDs are
database-generated UUIDv7 values and are never supplied by a browser.

## 5. Immutability and read state

Notification content is append-only. PostgreSQL rejects updates and deletes to inbox records.

Read state lives in a separate `read_receipts` table. A receipt is a monotonic fact: its first insert
marks one notification read, repeated insertion is idempotent at the future application boundary,
and its timestamp is not rewritten. Mark-unread, bulk read commands, and the public read contract are
deferred.

Separating content and read state prevents ordinary inbox interactions from mutating business-event
facts. Implementing retention or account erasure will require a deliberate migration and policy that
can remove records under controlled authority.

## 6. Ownership and privacy

`owner_id` is mandatory but has no cross-module foreign key to Identity. The authenticated source
operation supplies ownership; Notifications does not query Identity tables or independently decide
who owns a Financial resource.

The owner timeline index orders by source occurrence time and UUIDv7 identifier. Future reads must
derive the owner from the authenticated session, use bounded cursor pagination, and reveal neither
another owner's records nor internal journal, account, session, or projection identifiers.

## 7. Delivery scope

This foundation is in-app persistence only. It does not send email, SMS, mobile push, web push, or
WebSocket messages; it adds no worker and no third-party provider. Identity's verification and
password-recovery emails remain purpose-specific security capabilities, not Notification inbox
delivery.

HTTP reads, mark-read commands, browser badges, preferences, quiet hours, external channels, retry
queues, dead-letter handling, realtime delivery, and retention periods require focused follow-up
decisions.

## Alternatives Considered

### Browser-only toast notifications

Rejected as the durable model because they disappear across refreshes, devices, and offline periods
and cannot support reliable unread state.

### Generic event name plus arbitrary JSON

Rejected because it moves schema discovery to runtime consumers, weakens compatibility, and creates
an unsafe free-form content store.

### Store rendered title and message text

Rejected because copy, locale, formatting, and navigation evolve independently of immutable source
facts.

### Write the notification after the source transaction commits

Rejected because a process failure between commits produces a successful financial outcome with a
permanently missing notification.

### Introduce a message broker and outbox now

Rejected because the initial inbox and source facts share PostgreSQL and have no external
asynchronous consumer. The operational cost does not yet solve a demonstrated constraint.

### Reuse Trading Market Data publication facts

Rejected because those facts deliberately omit owner identity and serve rebuildable public
projections. Retrofitting private ownership would weaken their privacy boundary and still would not
cover Financial outcomes.

### Keep read state on the inbox row

Rejected because routine user interaction would mutate the immutable event record and complicate
auditing and retry semantics.

## Consequences

### Positive Consequences

- Source outcomes and notification capture can share one atomic PostgreSQL transaction.
- Database uniqueness gives deterministic retry and concurrency behavior.
- Exact typed payloads remain independently valid and presentation-neutral.
- Owner-scoped persistence supports a future private inbox without cross-owner ambiguity.
- Immutable facts and separate receipts make content and interaction histories explicit.
- Notifications owns all SQL and persistence mapping behind a public application capability.
- No broker, provider, worker, or new runtime lifecycle is required for the foundation.

### Negative Consequences

- A future integrated source transaction will fail if its required notification cannot be persisted.
- New kinds or payload versions require deliberate code and migration changes.
- No user-visible inbox exists until HTTP and browser increments are delivered.
- Monotonic receipts do not support marking a notification unread.
- Retention and account-erasure mechanisms require a controlled change to current immutability.
- PostgreSQL remains the shared transaction boundary; external providers still require an outbox or
  equivalent asynchronous delivery design.

## Reconsider When

Review this decision when Notifications must cross database boundaries, external delivery requires
independent retries, event volume makes synchronous inserts material to command latency, payload
evolution needs multiple active versions, regulatory retention or erasure rules are accepted, or
realtime/private delivery has a measurable objective.

## Related Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-022 — Simulated Deposit Lifecycle and Custody Boundary](ADR-022-simulated-deposit-lifecycle-and-custody-boundary.md)
- [ADR-024 — Simulated Withdrawal Lifecycle and Custody Boundary](ADR-024-simulated-withdrawal-lifecycle-and-custody-boundary.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [ADR-031 — Trading Market Data Fact Persistence and Publication Contract](ADR-031-trading-market-data-fact-persistence-and-publication-contract.md)
- [ADR-046 — Browser Portfolio Snapshot Experience](ADR-046-browser-portfolio-snapshot-experience.md)
