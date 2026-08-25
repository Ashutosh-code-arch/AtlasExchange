# ADR-024 — Simulated Withdrawal Lifecycle and Custody Boundary

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-25  
**Last reviewed:** 2026-08-25  
**Canonical owner/source:** ADR-024

## Context

ADR-020 defines available funds as value that may be withdrawn and requires every external movement
to remain balanced through an explicit custody account. ADR-021 provisions one external-custody
account per asset, while ADR-022 and ADR-023 provide an implemented simulated-deposit lifecycle and
its public HTTP boundary. Atlas can now create wallets and credit exact simulated value, but Phase 3
cannot complete until the inverse movement has equally explicit rules.

Atlas does not have a blockchain node, bank, payment processor, destination-address model, custody
provider, signing system, approval queue, confirmation observer, or reconciliation process. A
withdrawal workflow that accepts an address or claims broadcast would therefore invent external
facts. An artificial pending state would also create reservation, cancellation, and recovery paths
that no external system can advance honestly.

This decision defines the Financial application lifecycle for simulated withdrawals. It does not
define the public withdrawal HTTP route, browser presentation, notifications, real-custody
integration, approval policy, limits, or compliance controls.

## Decision Drivers

The MVP withdrawal capability should:

1. state unambiguously that no external asset is transmitted;
2. spend only the authenticated owner's available balance;
3. preserve exact quantities, double-entry authority, and non-negative user balances;
4. make retries and concurrent spending safe;
5. avoid fake destinations, confirmations, approvals, or provider references;
6. persist a discoverable business resource without exposing ledger internals;
7. keep the operation atomic and recoverable without a process-local workflow;
8. avoid a fee policy before Atlas has defined fees, limits, and their product presentation;
9. remain small enough for one developer to operate and test;
10. leave a clear replacement boundary for real custody later.

# Decision

Atlas will implement an explicitly named **simulated withdrawal** capability. An accepted request
debits the authenticated owner's available balance and completes synchronously in one PostgreSQL
transaction.

```text
Authenticated subject + asset + amount + idempotency key
                         ↓
              resolve existing retry
                         ↓
        validate simulated withdrawal request
                         ↓
          lock wallet and custody accounts
                         ↓
           debit user's available account
       credit asset external-custody account
                         ↓
    persist completed withdrawal + journal atomically
```

## 1. Authorization and Simulation Boundary

A simulated withdrawal is authorized only by the Atlas simulated-withdrawal capability. It means
that simulated value left the user's Atlas balance. It is not evidence that Atlas signed,
broadcast, paid, settled, or confirmed an external transfer.

The application receives the authenticated Identity subject through trusted server context. A
client cannot choose another owner by sending `ownerId`, `userId`, a wallet owner, or an account
identifier. The capability may debit only the authenticated subject's wallet.

The eventual transport and UI must use explicit simulated language. It must not request or display
a blockchain transaction hash, bank reference, destination address, network confirmation, or
provider status until a real integration can produce those facts.

Production-like deployments may disable new simulated withdrawals through an explicit operational
control. Disabling the command does not alter historical withdrawals, journals, wallets, or
balances. An identical retry that already completed remains resolvable after the control is disabled.

## 2. Synchronous MVP Lifecycle

The MVP has one persisted successful state:

- `completed` — the simulated withdrawal record and its balanced journal committed together.

Validation, authorization, availability, or insufficient-balance failures create neither a
withdrawal resource nor a journal. Atlas will not persist artificial `requested`, `pending`,
`approved`, `broadcast`, `confirming`, `failed`, or `cancelled` states because no external system or
human workflow currently produces those facts.

Success is acknowledged only after PostgreSQL commits the withdrawal and journal. There is no queue,
background debit, process-local reservation, optimistic balance change, or post-response accounting
work. A completed simulated withdrawal cannot be cancelled. Corrections require a separate,
authorized reversal workflow that preserves the original facts.

A future real-custody workflow must define durable request, reservation, review, signing, broadcast,
confirmation, failure, cancellation, and recovery transitions. It must not reinterpret simulated
withdrawal records as external settlements.

## 3. Withdrawal Intent and Validation

The application command contains only:

- the authenticated owner supplied by trusted server context;
- an asset code;
- a canonical decimal amount string;
- a caller-supplied idempotency key.

There is no destination, network, fee, memo, provider reference, status, wallet identifier, account
identifier, journal identifier, or posting input. Financial resolves the wallet, asset scale,
available account, and external-custody account.

An accepted new command requires:

- a catalog asset that exists and is active;
- an existing wallet owned by the authenticated subject for that asset;
- a strictly positive amount representable at the asset's immutable ledger scale;
- an amount within the `NUMERIC(38, 0)` atomic-unit limit from ADR-020;
- sufficient authoritative available balance after the affected accounts are locked;
- a syntactically valid idempotency key;
- simulated withdrawals to be operationally enabled.

The command performs no binary floating-point arithmetic. Amounts remain canonical decimal strings
at the application boundary and `bigint`-backed atomic units in the domain.

An inactive asset rejects a new withdrawal under the current catalog semantics. A future need to
permit exit-only withdrawals while blocking deposits or trading requires operation-specific asset
availability rather than silently changing the meaning of `disabled`.

## 4. Wallet and Spendable-Balance Rules

A withdrawal requires an existing `(owner, asset)` wallet. Unlike a deposit, it never creates a
wallet because an absent wallet cannot contain spendable value. Missing and cross-owner wallets are
not interchangeable application inputs; owner resolution always occurs inside the trusted boundary.

Only the wallet's authoritative available balance is spendable:

```text
withdrawable = available
reserved     = not withdrawable
```

The total balance is a read model and is not a spending limit. Value reserved for an open operation
cannot be withdrawn even when `available + reserved` is large enough. Withdrawal never releases,
moves, or otherwise changes reserved value.

Sufficient funds are checked from committed postings after locking the available account. A request
equal to the full available balance is valid. Any request that would make the available account
negative fails without a financial effect.

## 5. Accounting Treatment and Fees

Every completed simulated withdrawal creates exactly one balanced, single-asset journal:

```text
debit   user_available:<asset>     amount
credit  external_custody:<asset>   amount
```

The journal operation type is a stable Financial-owned identifier for simulated withdrawals. The
withdrawal record references exactly one committed journal, and that journal may complete exactly
one withdrawal. Posting construction and account identifiers remain private Financial details.

The external-custody credit is the accounting counter-entry for simulated value leaving Atlas. It is
not proof of a transfer to an address, bank, provider, or recipient. Real backing, liquidity,
broadcast, and reconciliation require separate integrations and controls.

MVP simulated withdrawals charge **zero fee**. The client cannot submit a fee, and the application
does not create a fee posting. Introducing a fee requires an explicit policy for asset, amount,
rounding, presentation, limits, and revenue recognition. When introduced, every fee must post to the
asset's fee-revenue account rather than silently reduce value.

## 6. Withdrawal Record and Immutability

Financial persists a withdrawal resource separate from the generic journal. At minimum it records:

- an immutable UUIDv7 withdrawal identifier;
- the wallet and asset;
- the canonical atomic amount;
- the `simulated` method;
- the terminal `completed` status;
- the linked journal identifier;
- the idempotency identity and canonical intent hash needed for conflict detection;
- the committed timestamp.

The resource provides business-level discoverability while the journal remains the authority for
value movement. It stores no destination, network, transaction hash, provider reference, or fee
because none exists in this lifecycle.

Completed withdrawal facts and their journal link are immutable. An erroneous withdrawal is not
edited, deleted, or relabelled. A later correction creates an explicit compensating business event
and balanced journal under its own authorization policy.

## 7. Idempotency and Retry Ordering

Every simulated-withdrawal command requires a client idempotency key. Its uniqueness scope includes
the authenticated owner and simulated-withdrawal operation, so two users may safely use the same
client key and deposit keys never collide with withdrawal keys.

The canonical intent includes the owner, asset, canonical amount, and withdrawal method.

- First key and intent: create one withdrawal and one journal.
- Same key and same intent: return the original completed withdrawal without another debit.
- Same key and different intent: return an idempotency conflict without changing value.
- Concurrent same-key commands: exactly one withdrawal and one journal may commit.

The use case resolves a committed identical retry before applying current asset or operational
availability rules. This preserves recovery after the first response is lost and prevents a later
configuration change from changing the meaning of a completed command. A conflicting reuse still
fails regardless of current availability.

The idempotency fact, withdrawal record, journal, and postings share one PostgreSQL transaction.
Database uniqueness is the final duplicate boundary; an in-memory cache is insufficient.

## 8. Concurrency and Transaction Boundary

The withdrawal application use case owns one transaction. It follows ADR-020's deterministic
account-locking protocol and derives the available balance only after the relevant rows are locked.

Concurrent withdrawals with distinct keys serialize on the same user's available account. The
committed order determines which commands have sufficient funds; no schedule may overdraw the
account. A concurrent reservation or another Financial debit participates in the same account-locking
protocol, so reserved and withdrawn value cannot spend the same available units.

The transaction contains no external network call. Real signing or provider calls must not hold
database locks open; a future asynchronous withdrawal design will need durable reservation and
outbox or worker boundaries before performing external effects.

## 9. Module and Transport Boundaries

Financial owns withdrawal validation, wallet lookup, spendable-balance enforcement, journal
construction, persistence, and result semantics. Identity supplies only the authenticated subject
through its public contract. No other module constructs withdrawal postings or queries Financial
tables.

The Financial public application result may expose the withdrawal ID, wallet ID, asset code,
canonical amount, method, status, and completion timestamp. It must not expose journal IDs,
custody-account IDs, raw postings, Kysely types, idempotency intent hashes, or allow callers to choose
accounting directions.

The public route, shared request/response schemas, lookup behavior, status-code mapping, CSRF,
rate-limiting, and HTTP error contract require a focused transport decision before browser exposure.

## 10. Minimum Evidence

The implementation must prove:

- an active asset can be withdrawn at its exact scale;
- only the authenticated owner's existing wallet can be debited;
- a completed withdrawal has one linked balanced journal with available debit and custody credit;
- available decreases by the exact amount while reserved remains unchanged;
- withdrawing the full available balance succeeds;
- missing wallets, disabled assets, zero, negative, over-precision, overflow, and insufficient amounts
  create no withdrawal or journal;
- first-use withdrawal never creates a wallet;
- withdrawal, journal, and postings roll back together on failure;
- identical retries return the original withdrawal and create no second debit;
- identical retries remain resolvable after new withdrawals are disabled;
- conflicting key reuse creates no financial effect;
- concurrent identical commands commit exactly one withdrawal and journal;
- concurrent distinct commands cannot overdraw available value;
- reserved value cannot satisfy a withdrawal;
- completed withdrawal facts and their journal link cannot be updated or deleted;
- a disabled simulated-withdrawal capability prevents new financial effects;
- public results contain no custody, journal, destination, or intent-hash details.

Atomicity, uniqueness, rollback, immutability, and concurrency evidence uses real PostgreSQL and
committed migrations.

# Alternatives Considered

## Model a Real Address or Bank Destination

Rejected because Atlas has no network, address validation, recipient model, bank rail, or provider.
Accepting a destination would imply a transfer capability that does not exist.

## Create Pending, Approved, and Confirmed Simulation States

Rejected because no external or human process advances them. Fake states create reservation and
recovery complexity without recording real facts.

## Reserve Funds and Complete in a Background Job

Rejected for the synchronous simulation because there is no asynchronous external effect. Durable
reservation becomes necessary when real approval, signing, or provider work exists.

## Auto-create a Missing Wallet

Rejected because an absent wallet has no balance to withdraw. Creating it would add a persistent
side effect to a command that must fail.

## Allow Total Balance to Fund the Withdrawal

Rejected because reserved funds are already committed elsewhere. Spending them would permit double
allocation and break the available/reserved contract.

## Charge an MVP Withdrawal Fee

Rejected because fee amount, asset, rounding, limits, and presentation are not decided. A silent or
arbitrary fee is worse than an explicit zero-fee simulation.

## Mutate a Wallet Balance Directly

Rejected because it bypasses the append-only ledger and cannot explain the external movement.

## Permit Cancellation or Editing After Completion

Rejected because the complete debit is an immutable financial fact. Corrections must preserve both
the original event and its compensating event.

# Consequences

## Positive Consequences

- Phase 3 gains a truthful inverse to simulated deposits.
- Withdrawals cannot spend reserved or another user's value.
- Exact, balanced journals explain every completed debit.
- Retries and concurrent spending cannot debit value twice or overdraw an account.
- The lifecycle remains simple without blocking future real-custody design.
- A focused withdrawal resource provides a stable business boundary for a later HTTP contract.

## Negative Consequences

- The operation demonstrates accounting behavior but performs no external transfer.
- The single terminal state does not exercise approval, signing, confirmation, or recovery.
- Zero fees do not demonstrate exchange withdrawal revenue.
- Disabled assets cannot support exit-only behavior without a richer availability model.
- Real custody will require additional states, destinations, provider references, and reconciliation.

# Deferred Decisions

This ADR does not decide:

1. public withdrawal HTTP contracts, lookup, history, or pagination;
2. browser withdrawal and notification presentation;
3. blockchain networks, destinations, address validation, memos, and travel-rule data;
4. custody-provider selection, signing, broadcast, confirmation, and reconciliation;
5. approval, MFA step-up, risk review, allowlisting, cooling-off, or account holds;
6. withdrawal fees, minimums, maximums, daily limits, and velocity controls;
7. durable reservation, cancellation, rejection, retry, and recovery for real withdrawals;
8. operation-specific asset availability such as deposit-disabled but withdrawal-enabled;
9. reversal and financial-adjustment authorization;
10. outbox events, notifications, and asynchronous side effects after completion.

# Reconsider When

Review this decision before Atlas transmits externally valuable assets, selects a custody or payment
provider, accepts destination data, introduces approval or pending states, charges withdrawal fees,
applies financial limits or compliance review, needs exit-only asset operation, or permits simulated
balances to interact with anything represented as real value.

# Relationship to Other Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-021 — MVP Asset Catalog and System-Account Provisioning](ADR-021-mvp-asset-catalog-and-system-account-provisioning.md)
- [ADR-022 — Simulated Deposit Lifecycle and Custody Boundary](ADR-022-simulated-deposit-lifecycle-and-custody-boundary.md)
- [ADR-023 — Financial HTTP API and Error Contract](ADR-023-financial-http-api-and-error-contract.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
