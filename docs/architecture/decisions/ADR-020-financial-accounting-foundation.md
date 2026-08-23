# ADR-020 — Financial Accounting Foundation

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-24  
**Last reviewed:** 2026-08-24  
**Canonical owner/source:** ADR-020

## Context

Atlas is beginning its financial-foundation phase. Assets, wallets, balances, ledger entries,
deposits, and withdrawals must exist before Trading can reserve or settle value safely.

ADR-008 assigns financial behavior to the Financial module and makes application use cases the
owners of business transactions. ADR-010 requires PostgreSQL `NUMERIC`, explicit financial domain
values, canonical decimal strings at transport boundaries, and atomic persistence. The testing
strategy additionally requires every movement inside an accounting boundary to be balanced or
explicitly identified as an authorized external movement.

Those decisions do not define asset precision, balance authority, the wallet/account relationship,
available versus reserved value, immutable journal rules, idempotency, or concurrency. These rules
must be decided before the first wallet or ledger migration; otherwise, the schema becomes an
accidental accounting specification.

## Decision Drivers

The financial foundation should:

1. preserve exact quantities without JavaScript floating-point arithmetic;
2. explain every value movement through an auditable journal;
3. prevent user-owned balances from becoming negative;
4. support future trading reservations without redesigning wallets;
5. make retries safe and detect conflicting duplicate requests;
6. preserve invariants under concurrent commands;
7. use PostgreSQL as the final enforcement boundary where practical;
8. remain understandable and operable by one developer;
9. avoid premature event sourcing, distributed transactions, and services;
10. leave deposit, withdrawal, and trading lifecycles to focused follow-up decisions.

# Decision

Atlas will implement an **append-only, double-entry ledger** inside the Financial module.

```text
Asset definition
      ↓
Wallet (one user + one asset)
      ↓
Ledger accounts (available and reserved)
      ↓
Journal transaction
      ↓
Two or more immutable debit/credit postings
      ↓
Authoritative balance derived from postings
```

## 1. Asset Definitions and Precision

An asset definition owns a stable uppercase code, human-readable name, integer ledger scale,
operational status, and timestamps. The initial scale range is **0 through 18 decimal places**. The
scale becomes immutable after the asset has a wallet, account, or posting because changing it would
reinterpret existing quantities. Disabling an asset prevents new user operations but does not
remove its history.

This ADR does not hard-code an asset list. Assets are provisioned through controlled application or
migration data, never inferred from arbitrary request input.

Financial quantities use non-fractional atomic units internally:

```text
API:       "12.345"
Asset:     scale = 3
Domain:    12345 atomic units
Database:  NUMERIC(38, 0)
```

Rules:

- domain arithmetic uses `bigint`-backed value objects, never JavaScript `number`;
- PostgreSQL stores atomic quantities as `NUMERIC(38, 0)`;
- adapters receive database numeric values as strings and parse them explicitly;
- posting amounts are strictly positive; direction is represented separately;
- zero is a valid balance but not a valid posting amount;
- quantities cannot exceed 38 atomic digits;
- arithmetic across different asset codes is rejected.

The API uses canonical decimal strings as required by ADR-010. An unsigned canonical quantity uses
plain decimal notation, no unnecessary leading or trailing zeroes, and no more fractional digits
than the asset scale. Display formatting may add trailing zeroes without changing the canonical
value.

## 2. Wallet and Account Model

A wallet is the user-facing ownership boundary for one user and one asset. There is at most one
wallet for a `(user, asset)` pair. Repeated creation is idempotent and returns the existing wallet.

Each wallet owns two ledger accounts:

- `available` — value that may be withdrawn, transferred, or reserved;
- `reserved` — value committed to an open operation and unavailable elsewhere.

The wallet does not contain an independently authoritative balance. Financial also owns explicit
system accounts for external custody or clearing, fees or revenue, and later approved operational
purposes. Every account belongs to exactly one asset.

Account type defines its normal side:

```text
debit-normal account balance  = debits - credits
credit-normal account balance = credits - debits
```

User available and reserved accounts are credit-normal liability accounts. Their balances must
never be negative after a committed journal transaction. Custody accounts are debit-normal asset
accounts.

The wallet stores the immutable Identity subject identifier supplied through Identity's public
contract. Financial does not query Identity tables or depend on Identity repository internals to
interpret ownership. Any database reference across that boundary requires separate review.

## 3. Journal Transactions and Postings

A journal transaction records one complete accounting event. It contains an immutable identifier,
operation type, idempotency scope and key, canonical intent hash, timestamps, optional structured
business references, and two or more postings.

Each posting identifies its journal, account, asset, `debit` or `credit` direction, strictly positive
atomic-unit amount, and deterministic position. A journal must balance independently for every
represented asset:

```text
sum(debit atomic units) = sum(credit atomic units)
```

Financial accepts a complete journal intent. It does not expose a public operation for appending one
unbalanced posting at a time.

```text
Deposit:
  debit  external custody asset account
  credit user available liability account

Reserve funds:
  debit  user available liability account
  credit user reserved liability account

Fee:
  debit  user liability account
  credit fee revenue account
```

Deposits and withdrawals are authorized external movements at the product boundary, but remain
balanced inside Atlas through explicit custody or clearing accounts. Value never appears or
disappears through a direct balance update.

## 4. Immutability and Corrections

Committed journals and postings are append-only. Ordinary application behavior cannot update or
delete them. A correction creates a new balanced reversal or adjustment referencing the original,
preserving both facts.

PostgreSQL constraints and deferred validation must reject, at commit where necessary:

- a journal with fewer than two postings;
- a journal that does not balance per asset;
- a posting whose asset differs from its account's asset;
- a non-positive or non-integral atomic-unit amount;
- mutation or deletion of committed journal facts.

Application validation remains required but is not the only protection.

## 5. Authoritative Balances

Append-only postings are the financial source of truth. An account balance derives from its
committed debits and credits. A wallet reports:

```text
total = available + reserved
```

Atlas will not begin with a mutable wallet balance as an independent authority. If measured query
cost later requires a projection or snapshot, it must be transactionally maintained, rebuildable
from postings, reconciled with the journal, and explicitly documented as a projection. Introducing
one requires a follow-up decision.

## 6. Transaction and Concurrency Policy

Every posting use case runs in one PostgreSQL transaction through the application-owned boundary in
ADR-008 and ADR-010. The implementation:

1. resolves and locks all affected account rows in deterministic identifier order;
2. derives their authoritative balances;
3. validates asset, lifecycle, and non-negative-balance rules;
4. inserts the journal and all postings;
5. permits deferred database invariant checks to run;
6. commits everything or rolls everything back.

All posting paths follow the same locking protocol. Deterministic order reduces deadlock risk.
Deadlocks and serialization failures surface as retryable infrastructure failures; callers retry
only through the same idempotent command. Repositories do not hide unbounded retries.

This correctness-first pessimistic policy may be reconsidered when measured throughput justifies a
versioned projection or another concurrency design.

## 7. Financial Command Idempotency

Every externally initiated or retryable movement requires an idempotency key within an operation
scope. Financial persists the scope, key, canonical intent hash, and result journal identifier in
the same transaction. `(scope, idempotency key)` is unique.

- First request: execute and persist the result atomically.
- Same key and intent: return the original result without posting again.
- Same key with different intent: reject with an idempotency conflict.
- Concurrent same-key requests: exactly one financial effect may commit.

These records remain with journal history; a cache or process-local map is insufficient. Internal
construction may use deterministic system keys, but no financial effect may depend on an
uncontrolled key that cannot be reused after an ambiguous failure.

## 8. Module Boundaries

Financial owns assets, wallets, accounts, journals, postings, quantity conversion, repositories,
mappings, and accounting invariants. Other modules use its public application capabilities. They do
not import Financial internals, query Financial tables, construct postings independently, update
balances directly, or receive Kysely/`pg` types.

Trading may later request reservation, release, or settlement through narrow Financial capabilities
that participate in the orchestrating transaction. Trading does not own accounting rules.

The HTTP endpoints and transport error contracts for assets, wallets, deposits, and withdrawals are
separate API decisions.

## 9. Minimum Invariant Evidence

The implementation must prove at least:

- atomic-unit parsing, canonical formatting, scale limits, and overflow rejection;
- rejection of arithmetic across assets;
- one wallet per user and asset;
- balanced multi-posting journals succeed;
- unbalanced, single-posting, cross-asset, zero, and negative postings fail;
- user available and reserved balances cannot become negative;
- failed transactions leave no partial journal;
- identical retries create one journal and return one result;
- conflicting idempotency-key reuse fails;
- concurrent spending cannot overdraw an account;
- journal facts cannot be updated or deleted;
- reversals preserve original and correcting history.

Transaction, lock, constraint, and concurrency tests use real PostgreSQL and committed migrations.

# Alternatives Considered

## Mutable wallet balances without a ledger

Rejected because a current number cannot explain its origin, destination, or duplicated retries.

## Single-entry transaction history

Rejected because a movement could omit its source, destination, or fee account and would lack a
mechanically checkable balancing invariant.

## Event sourcing for all Financial state

Rejected initially because Atlas needs an append-only accounting journal, not the overhead of making
every aggregate event-sourced.

## JavaScript decimal numbers

Rejected because binary floating-point cannot represent all authoritative decimals exactly.

## Fixed 18-decimal values for every asset

Rejected because this accepts quantities an asset may not support and hides asset-specific rules.

## Mutable materialized balances as co-equal authority

Rejected because competing sources of truth can diverge. Any future projection remains rebuildable
from the journal.

## Asynchronous posting for core movements

Rejected initially because acknowledgement before durable balanced posting creates ambiguous
financial state and unnecessary eventual-consistency failure modes.

# Consequences

## Positive Consequences

- Every movement has an explicit source and destination.
- Exact quantities never require floating-point arithmetic.
- Reservations fit the wallet model before Trading begins.
- Duplicate and concurrent commands have defined correctness behavior.
- Historical facts remain explainable and reversible without mutation.
- PostgreSQL constraints, transactions, and locks provide final invariant protection.
- Later projections can optimize reads without replacing the journal.

## Negative Consequences

- Posting requires more records and validation than updating a balance column.
- Debit/credit account classification requires accounting discipline.
- Shared system accounts may become lock hot spots.
- Balance reads may eventually need projections.
- Deferred database validation and immutability protections add migration complexity.
- Corrections require explicit reversal workflows.

# Deferred Decisions

Follow-up decisions must define:

1. the initial asset catalog and administrative provisioning interface;
2. deposit lifecycle, custody integration, confirmations, and source idempotency;
3. withdrawal lifecycle, approval, fees, custody integration, and cancellation;
4. public Financial HTTP endpoints, authorization, and errors;
5. trading reservation, release, settlement, and fee semantics;
6. balance projections and reconciliation;
7. external-custody reconciliation;
8. limits, compliance holds, and administrative adjustments;
9. exchange-rate, price, quote, and rounding policies;
10. production retry limits and concurrency thresholds.

# Reconsider When

Review this decision when measured query cost requires a projection, account locking prevents
required throughput, an asset exceeds the selected precision, Financial is independently deployed,
an external ledger becomes authoritative, or regulated/margin/credit products enter scope.

# Relationship to Other Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

Financial implementation may begin with the asset-quantity and accounting primitives. Deposit,
withdrawal, trading, and HTTP lifecycle work remains gated by the focused decisions above.
