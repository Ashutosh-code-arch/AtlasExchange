# ADR-022 — Simulated Deposit Lifecycle and Custody Boundary

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-25  
**Last reviewed:** 2026-08-25  
**Canonical owner/source:** ADR-022

## Context

ADR-020 defines deposits as balanced movements from an external-custody account to a user's
available account. ADR-021 provisions the MVP asset catalog and one external-custody account per
asset. Atlas now has the accounting primitives required to credit a wallet, but it does not yet
define what authorizes that credit, how retries behave, whether wallet creation is part of the
operation, or which facts must be persisted outside the journal.

Atlas is a simulated centralized-exchange learning product. It has no blockchain observer, bank,
payment processor, deposit address, confirmation engine, or custody provider. Treating a browser
request as proof of a real external transfer would create a false security and accounting claim.
Conversely, introducing a provider-shaped asynchronous lifecycle before an external provider exists
would add states and recovery paths that the MVP cannot exercise honestly.

This decision defines the Financial application lifecycle for simulated deposits. It does not define
the public HTTP route, browser presentation, withdrawal lifecycle, real-custody integration, limits,
or compliance policy.

## Decision Drivers

The MVP deposit capability should:

1. state unambiguously that credited value is simulated;
2. preserve the double-entry and balance authority established by ADR-020;
3. make client retries and concurrent duplicate requests safe;
4. keep wallet provisioning and crediting free from partial outcomes;
5. derive ownership from authenticated server context rather than request-supplied user identifiers;
6. expose a deposit resource without exposing journal construction or system-account identifiers;
7. reject unsupported assets, invalid precision, and disabled assets before value moves;
8. remain small enough for one developer to operate and test;
9. avoid pretending to implement confirmations or external settlement;
10. leave a clear replacement boundary for a real custody adapter later.

# Decision

Atlas will implement an explicitly named **simulated deposit** application capability. An accepted
request credits the user's available balance synchronously and atomically.

```text
Authenticated subject + asset + amount + idempotency key
                         ↓
              validate simulated funding
                         ↓
              create or resolve wallet
                         ↓
        debit asset external-custody account
        credit user's available account
                         ↓
       persist credited deposit + journal atomically
```

## 1. Authorization Boundary

A simulated deposit is authorized only by the Atlas simulated-funding capability. It is not evidence
that Atlas observed or received money, cryptocurrency, or another external asset.

The application receives the authenticated Identity subject through trusted server context. A client
must not select another owner by sending `ownerId`, `userId`, a wallet owner, or a ledger-account
identifier. The capability may fund only the authenticated subject's wallet.

The eventual transport and UI must use explicit simulated language. Generic claims such as
"blockchain deposit confirmed", "funds received", or "bank transfer settled" are prohibited until a
real integration can prove them.

Production-like deployments may disable simulated funding through an explicit operational control.
Disabling the command prevents new simulated deposits but does not alter historical deposits,
journals, wallets, or balances. Configuration is never allowed to change the accounting meaning of
an already accepted deposit.

## 2. Synchronous MVP Lifecycle

The MVP has one persisted successful state:

- `credited` — the simulated deposit record and its balanced journal committed together.

Validation or authorization failures do not create a financial deposit record and do not create a
journal. The client receives a typed failure from the application or transport boundary. Atlas will
not persist artificial `observed`, `confirming`, `broadcast`, or `settled` states because no external
system currently produces those facts.

The operation acknowledges success only after PostgreSQL commits the deposit and journal. There is no
queue, background credit, process-local pending state, or optimistic balance update in this lifecycle.

A later custody integration must define its own durable observation and confirmation state machine.
It must not silently reinterpret simulated deposit records as provider-confirmed deposits.

## 3. Deposit Intent and Validation

The application command contains only:

- the authenticated owner supplied by trusted server context;
- an asset code;
- a canonical decimal amount string;
- a caller-supplied idempotency key.

The Financial module resolves all remaining authority, including asset scale, wallet accounts, and
the system custody account. Callers cannot provide postings, journal operation types, account IDs,
deposit status, or a journal ID.

An accepted command requires:

- a catalog asset that exists and is active;
- a strictly positive amount representable at that asset's immutable ledger scale;
- an amount within the `NUMERIC(38, 0)` atomic-unit limit from ADR-020;
- a syntactically valid idempotency key;
- simulated funding to be operationally enabled.

The command performs no binary floating-point arithmetic. Amounts remain canonical decimal strings
at the application boundary and `bigint`-backed atomic units in the domain.

Per-request, cumulative, velocity, compliance, and abuse limits are deferred. Their absence is
acceptable only while balances are explicitly simulated and have no redemption or external-value
claim.

## 4. Wallet Provisioning

The deposit use case creates or resolves the `(owner, asset)` wallet as part of the same application
transaction. A first deposit therefore does not require a separate wallet-creation race or client
workflow.

If the operation fails, a newly created wallet, its user accounts, the deposit record, and the journal
all roll back. If the wallet already exists, the use case reuses its available account. The wallet's
reserved account is not affected by a deposit.

This convenience does not make wallets request-owned. Wallet identity and uniqueness remain governed
by Financial and the database constraints established under ADR-020.

## 5. Accounting Treatment

Every credited simulated deposit creates exactly one balanced, single-asset journal:

```text
debit   external_custody:<asset>   amount
credit  user_available:<asset>     amount
```

The journal operation type is a stable Financial-owned identifier for simulated deposits. The
deposit record references exactly one committed journal, and that journal may credit exactly one
deposit. System-account identifiers and posting construction remain private Financial details.

The external-custody debit is an accounting counter-entry for simulated value entering Atlas. Its
balance is not proof of an on-chain address, bank balance, provider receivable, or reconciled external
asset. Real backing and reconciliation require a separate decision and integration.

Deposits credit only the available account. They never credit reserved value, mutate a wallet balance
column, or bypass journal posting.

## 6. Deposit Record and Immutability

Financial persists a deposit resource separate from the generic journal. At minimum it records:

- an immutable UUIDv7 deposit identifier;
- the wallet and asset;
- the canonical atomic amount;
- the `simulated` method;
- the terminal `credited` status;
- the linked journal identifier;
- the idempotency identity and canonical intent hash needed for conflict detection;
- the committed timestamp.

The record provides business-level discoverability while the journal remains the authority for value
movement. A deposit record cannot independently change a balance.

Credited deposits and their journal link are immutable. Correcting an erroneous simulated credit
requires a separately authorized reversal or adjustment workflow that preserves the original facts;
ordinary update or delete operations are prohibited. That correction workflow remains deferred.

## 7. Idempotency and Concurrency

The client supplies an idempotency key for every simulated deposit. Its uniqueness scope includes the
authenticated owner and the simulated-deposit operation, so two users may safely use the same client
key.

The canonical intent includes the owner, asset, canonical amount, and deposit method.

- First key and intent: create one deposit and one journal.
- Same key and same intent: return the original credited deposit without another posting.
- Same key and different intent: return an idempotency conflict without changing value.
- Concurrent same-key requests: exactly one deposit and one journal may commit.

The deposit idempotency fact, deposit record, wallet provisioning, journal, and postings share one
PostgreSQL transaction. Database uniqueness is the final duplicate boundary; an in-memory cache is
insufficient. Implementations must follow the deterministic account-locking policy in ADR-020.

An external provider reference is not invented for simulated deposits. A future integration must
define provider/network-scoped source idempotency independently from browser request idempotency.

## 8. Module and Transport Boundaries

Financial owns simulated-deposit validation, wallet resolution, accounting construction, persistence,
and result semantics. Identity supplies only the authenticated subject through its public contract.
No other module constructs the journal or queries Financial tables.

The Financial public application result may expose the deposit ID, wallet ID, asset code, canonical
amount, status, method, and credited timestamp. It must not expose custody-account IDs, raw postings,
Kysely types, or permit a caller to choose accounting directions.

The public HTTP route, request/response schemas, authentication middleware composition, status-code
mapping, CSRF behavior, rate limiting, and deposit-history pagination require a focused Financial HTTP
contract decision before browser exposure.

## 9. Minimum Evidence

The implementation must prove:

- an active catalog asset can be credited at its exact scale;
- a first deposit atomically creates the wallet and credits its available account;
- an existing wallet is reused and its reserved balance is unchanged;
- missing, disabled, zero, negative, over-precision, and overflow amounts create no financial effect;
- the authenticated owner cannot be replaced through command input;
- a committed deposit has one linked balanced journal with custody debit and available credit;
- deposit, wallet creation, journal, and postings roll back together on failure;
- identical retries return the original deposit and create no second posting;
- conflicting key reuse creates no financial effect;
- concurrent identical requests commit exactly one deposit and journal;
- credited deposit facts and their journal link cannot be updated or deleted;
- a disabled simulated-funding capability creates no deposit or journal.

Atomicity, uniqueness, rollback, immutability, and concurrency evidence uses real PostgreSQL and
committed migrations.

# Alternatives Considered

## Treat a Browser Request as an External Deposit Confirmation

Rejected because Atlas has no external observer or provider capable of proving receipt. This would
misrepresent simulated balance creation as real custody.

## Model Fake Pending and Confirmation States

Rejected because no external event advances those states. Unexercised lifecycle states add recovery
and operational complexity without representing real facts.

## Credit a Mutable Wallet Balance Directly

Rejected because it bypasses the append-only double-entry authority and cannot explain the source of
value.

## Require Wallet Creation Before Deposit

Rejected for the MVP because it creates an unnecessary client workflow and race. Financial can
preserve wallet uniqueness and create the wallet inside the deposit transaction.

## Use a Global Client Idempotency Key

Rejected because unrelated users commonly generate the same keys and should not conflict. Ownership
is part of the operation scope.

## Reuse the Journal as the Only Deposit Resource

Rejected because a generic accounting event does not own deposit method, lifecycle, or future custody
references. A narrow deposit record provides the business resource without weakening journal
authority.

## Introduce Real Blockchain or Banking Integration Now

Rejected because Atlas has not selected providers, networks, confirmation policies, reconciliation,
or production regulatory boundaries. A truthful simulated adapter is preferable to a fictional
production integration.

# Consequences

## Positive Consequences

- The MVP can demonstrate funding without claiming real custody.
- Every credited amount remains balanced and auditable.
- First-use wallet provisioning is atomic and convenient.
- Retries and concurrent duplicates cannot mint value twice.
- Deposit records provide a future lifecycle boundary separate from ledger internals.
- A real observer can later replace the authorization source without replacing accounting rules.

## Negative Consequences

- Authenticated users can create simulated value while the capability is enabled.
- The synchronous lifecycle does not exercise provider confirmations or asynchronous recovery.
- Deposit persistence adds a business record alongside the journal.
- Operational limits and abuse controls still need a later decision.
- Real custody will require additional states, source identifiers, and reconciliation.

# Deferred Decisions

This ADR does not decide:

1. public Financial HTTP contracts and deposit-history pagination;
2. browser deposit and wallet presentation;
3. withdrawal reservation, approval, fee, cancellation, and completion;
4. real blockchain networks, addresses, observations, and confirmation thresholds;
5. bank, payment-processor, or custody-provider integration;
6. provider-reference idempotency and reorganization handling;
7. deposit limits, compliance review, risk holds, and administrative authorization;
8. external-custody reconciliation and proof of reserves;
9. reversal and financial-adjustment authorization;
10. notifications and asynchronous side effects after a committed credit.

# Reconsider When

Review this decision before Atlas accepts externally valuable assets, selects a custody or payment
provider, needs pending/confirmation states, introduces redemption, applies financial limits or
compliance review, or permits simulated balances to interact with anything represented as real
value.

# Relationship to Other Decisions

- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-021 — MVP Asset Catalog and System-Account Provisioning](ADR-021-mvp-asset-catalog-and-system-account-provisioning.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
