# ADR-028 — Financial Reservation, Release, and Trade Settlement Capabilities

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-26  
**Last reviewed:** 2026-08-26  
**Canonical owner/source:** ADR-028

## Context

ADR-020 makes Financial the sole authority for wallets, available and reserved accounts, journals,
postings, balances, and accounting invariants. ADR-026 requires every accepted order to reserve its
maximum spend and requires every trade, price-improvement release, and cancellation release to
commit atomically with Trading state. ADR-027 defines durable Trading markets, orders, trades, and
the order-book locking boundary.

The existing Financial journal application can post a caller-supplied balanced journal, but it is
not an appropriate Trading boundary. It accepts ledger account identifiers, permits callers to
describe debit and credit postings, and owns a standalone database transaction. Exposing it to
Trading would transfer accounting policy outside Financial and would create a nested transaction
that cannot commit atomically with orders and trades.

Atlas must therefore decide the business capabilities Trading may invoke, how those capabilities
join the Trading-owned transaction, how reservation state is represented, the exact journal shapes
for reservation, settlement, price improvement, and release, and how retries and concurrent markets
retain deterministic account locking.

This ADR defines an internal module contract. It does not expose a new HTTP API and does not define
public order errors or browser behavior.

## Decision Drivers

The Trading-to-Financial boundary should:

1. keep wallet, account, journal, posting, and balance authority inside Financial;
2. commit Trading and Financial effects in one PostgreSQL transaction;
3. prevent Trading from supplying wallet IDs, account IDs, or posting directions;
4. reserve the exact maximum spend of one order and prevent reservations from being shared;
5. settle base, quote, and price improvement exactly without rounding;
6. release only the exact unconsumed reservation;
7. make every operation retry-safe at a durable uniqueness boundary;
8. lock every affected reservation and account in deterministic order;
9. preserve an auditable relationship between orders, trades, reservation state, and journals;
10. allow disabled assets to release committed value without permitting new Trading risk;
11. remain understandable and operable by one developer.

# Decision

Financial will publish a narrow, transaction-bound **Trading funds capability**. Trading supplies a
complete business plan containing orders, owners, market assets, executions, and exact domain
quantities. Financial resolves wallets and accounts, validates reservation ownership and state,
constructs journals, locks persistence, and applies every movement.

~~~text
Trading place-order use case owns one transaction
                         │
                         ├── Trading persistence capability
                         │     markets, orders, trades
                         │
                         └── Financial Trading-funds capability
                               wallets and accounts resolved internally
                               reservation state owned internally
                               postings constructed internally
                               same transaction; no nested commit
~~~

The two public Financial operations are conceptually:

- apply all Financial effects of one order placement plan;
- release the remaining reservation of one cancelled order.

One placement plan may contain zero or more trade settlements and an optional terminal release.
Batching the complete plan lets Financial discover and lock every affected reservation and ledger
account before it writes the first journal.

## 1. Capability Boundary

The application-facing capability is represented by interfaces equivalent to:

~~~text
TradingFundsCapability
├── applyPlacementEffects(plan)
└── releaseOrderReservation(command)
~~~

`applyPlacementEffects` receives:

- one immutable market reference containing market code, base asset code, and quote asset code;
- the incoming order ID, owner ID, side, and exact reservation quantity;
- an ordered list of execution intents;
- an optional terminal release reason for the incoming order.

Each execution intent contains:

- trade ID and market code;
- maker and taker order IDs;
- buyer and seller order IDs and owner IDs;
- exact executed base quantity;
- exact executed quote notional at maker price;
- exact buyer reserved-quote reduction at the buyer's limit price.

`releaseOrderReservation` receives the order ID, authenticated owner ID, market code, and accepted
terminal reason. It does not receive a release amount; Financial derives the exact remaining amount
from its reservation state.

Inputs use Financial's exact AssetQuantity boundary or an equivalent bigint-backed representation.
JSON numbers, JavaScript number, decimal rounding, and untyped monetary strings are not accepted
inside the capability.

The capability does not accept or return:

- wallet IDs;
- ledger account IDs;
- journal postings or directions;
- Kysely, pg, SQL, or database row types;
- a caller-selected release amount;
- a caller-selected price-improvement amount.

Trading does not import Financial repositories or domain internals. Financial does not import
Trading repositories or query Trading tables. Order, trade, market, and owner identifiers are
validated opaque business references at this boundary.

## 2. Composite Transaction Model

The Trading application use case owns the transaction through a composite unit-of-work port:

~~~text
TradingTransactionRunner.execute(context => ...)

context
├── trading    module-owned persistence operations
└── financial  transaction-bound TradingFundsCapability
~~~

The PostgreSQL implementation opens one Kysely transaction and binds both module-owned adapters to
that transaction. The application callback sees only business interfaces. Only infrastructure sees
the Kysely transaction object.

Rules:

- the Financial capability bound to the context never starts or commits another transaction;
- a standalone Financial command that owns its own transaction is not invoked from Trading;
- all order, trade, reservation, movement, journal, and posting writes use one checked-out client;
- expected business rejection is resolved before writes or causes the complete unit of work to roll
  back; invariant failures always roll back;
- post-commit events cannot replace the atomic boundary;
- no external network call occurs while the database transaction remains open.

Existing Financial journal domain rules and low-level persistence may be reused internally, but the
generic account-ID-based journal command is not exported as the Trading contract.

## 3. Complete Placement Financial Plan

Financial receives all effects for one incoming order in one plan:

~~~text
incoming reservation
        ↓
zero or more trade settlements in execution order
        ↓
optional residual release for self-trade prevention
~~~

Examples:

- no match: create one reservation and leave it active;
- full fill: create one reservation and consume it through one or more settlements;
- partial fill: create one reservation, settle fills, and leave the exact residual active;
- price improvement: settle execution value and return the exact improvement in the same journal;
- self-trade after fills: settle earlier valid trades, then release the incoming residual;
- immediate self-trade: create the reservation and release it in the same transaction, preserving
  both auditable facts if the order commits as cancelled.

Financial validates the entire plan before persisting effects. A plan cannot apply only its first
trade or leave an incoming reservation without the corresponding committed Trading order.

Owner cancellation is a separate command because it operates on an already committed reservation
and contains no new placement or trade.

## 4. Financial Reservation Resource

Financial will persist a business resource named `financial.trading_reservations`. It is not a
mutable balance authority; journal postings remain authoritative for balances.

One reservation is identified by its Trading order ID. No second reservation ID is introduced.
The record contains at minimum:

- immutable order ID;
- immutable owner ID;
- immutable market code;
- immutable side;
- immutable reserved asset code;
- immutable original atomic amount;
- mutable remaining atomic amount;
- status;
- unique reservation journal ID;
- creation and update timestamps.

The lifecycle is:

~~~text
active   remaining > 0
  ├── consumed   remaining = 0 through trade settlements
  └── released   remaining = 0 through one terminal release
~~~

An order owns exactly one reservation. The side determines its denomination:

- buy order — quote asset at the immutable order limit;
- sell order — base asset quantity.

Order ID, owner, market, side, asset, original amount, reservation journal, and creation time never
change. Remaining amount only decreases. A consumed or released reservation cannot reactivate.

Financial stores the order ID as an opaque external business identifier and deliberately does not
foreign-key it to `trading.orders`. This avoids cross-module schema cycles and lets Financial retain
its own integrity rules. Atomic application composition and integration tests prove that a committed
reservation always has its committed Trading order.

Trading does not store a Financial account ID, journal ID, or duplicate reservation ID. The shared
order ID is the durable correlation key.

## 5. Reservation Movement History

Financial will persist immutable decrement facts in
`financial.trading_reservation_movements`. Each row contains:

- reservation order ID;
- Financial journal ID;
- movement kind: `trade_settlement` or `release`;
- positive integral atomic amount;
- trade ID for a settlement and no trade ID for a release;
- creation timestamp.

The primary identity is reservation order ID plus journal ID. A reservation may have at most one
movement for one trade and at most one terminal release movement. Movement rows cannot be updated or
deleted.

The database reconciles reservation state at deferred constraint time:

~~~text
remaining amount = original amount - sum(all movement amounts)

active:
  remaining > 0 and no release movement

consumed:
  remaining = 0 and no release movement

released:
  remaining = 0 and exactly one release movement
~~~

The reservation journal represents the initial increase in reserved value. Movement rows explain
every later decrease. This resource history is an audit and concurrency authority for Trading
commitments; it does not replace ledger-derived wallet balances.

## 6. Reservation Journal

Financial creates one immutable journal for a new order reservation.

~~~text
operation type:    trading_order_reservation
idempotency scope: trading.order.reserve
idempotency key:   order ID

Reserved asset:
  debit  owner available account   exact maximum spend
  credit owner reserved account    exact maximum spend
~~~

The business references contain source module, order ID, market code, owner ID, and side. The exact
amount and denomination remain authoritative in postings and the reservation resource.

Financial resolves the owner wallet by owner ID plus asset code. Both wallet accounts must exist;
the capability never creates them. The asset must be active and the available balance must cover
the complete original reservation before any execution price improvement is considered.

The reservation record, journal, and two postings commit together. Database constraint triggers
require each Trading reservation journal to own exactly one matching reservation and require each
reservation to reference the corresponding journal shape.

## 7. Trade Settlement Journal

Financial creates one immutable settlement journal per immutable Trading trade.

~~~text
operation type:    trading_trade_settlement
idempotency scope: trading.trade.settle
idempotency key:   trade ID

Base asset:
  debit  seller reserved           executed base quantity
  credit buyer available           executed base quantity

Quote asset:
  debit  buyer reserved            quote reserved at buyer limit for filled lots
  credit seller available          quote execution notional at maker price
  credit buyer available           exact price improvement, only when positive
~~~

Financial computes:

~~~text
price improvement = buyer reserved-quote reduction - execution quote notional
~~~

The buyer reserved-quote reduction must be greater than or equal to execution notional. Financial
computes the difference and postings; Trading does not supply a rounded improvement or posting
list. With no improvement, the journal contains four postings. With improvement, it contains five.
Each asset balances independently.

The initial settlement contains no fee postings. A later fee decision must extend the Financial
plan and accepted journal shape before Trading may charge maker or taker fees.

The settlement decrements exactly two reservation resources:

- seller reservation by executed base quantity;
- buyer reservation by quote value at the buyer's immutable limit for the filled lots.

Financial verifies that:

- both reservations exist and are active;
- reservation owners match the declared buyer and seller;
- buyer reservation side is buy and asset is the market quote;
- seller reservation side is sell and asset is the market base;
- both reservations belong to the declared market;
- both remaining amounts cover their required decrements;
- buyer and seller are different owners;
- base quantity, execution notional, and reserved reduction are positive and exact;
- all required destination wallets exist;
- the trade ID has not been applied with different intent.

The journal business references contain source module, trade ID, market code, maker and taker order
IDs, and buyer and seller order IDs. Financial need not query Trading to interpret these references.

Trade, both Trading order updates, settlement journal, postings, two reservation movements, and both
reservation state updates commit or roll back together.

## 8. Cancellation and Residual Release Journal

Financial releases the reservation's complete remaining amount; the caller cannot choose a lesser
or greater value.

~~~text
operation type:    trading_order_release
idempotency scope: trading.order.release
idempotency key:   order ID

Reserved asset:
  debit  owner reserved account    exact remaining reservation
  credit owner available account   exact remaining reservation
~~~

The business references contain source module, order ID, market code, owner ID, and terminal reason
`owner_cancelled` or `self_trade_prevention`.

Release is permitted when the asset is disabled. It reduces an existing commitment and must not
strand owner value because new activity was suspended. The reservation must still exist, belong to
the declared owner and market, be active, and have a positive remaining amount.

An identical repeated release returns the existing outcome without a second journal. Reusing the
same order release identity with a different reason or owner is a conflict and rolls back. A fully
consumed reservation cannot be released.

## 9. Asset and Wallet Operational Rules

Applying a placement plan requires the base and quote assets to be active for the complete
operation. Financial locks the relevant asset catalog rows against a concurrent status change.
Trading separately enforces the market's active status.

Every owner participating in a trade must already have both required wallets:

- buyer: quote reservation source and base available destination;
- seller: base reservation source and quote available destination.

The incoming order also requires both market wallets as defined by ADR-026, even if the immediate
Financial reservation touches only one. Financial does not silently provision a receiving wallet.

Settlement is not used as a way to introduce new exposure after an asset is disabled. Cancellation
and self-trade-prevention release remain allowed because they only remove an existing commitment.
A future administration decision must coordinate market cancel-only state, mass cancellation, and
asset disablement.

## 10. Deterministic Lock Protocol

While the Trading market row remains the first book-level lock, Financial receives the complete
placement plan before posting so it can acquire its own locks once and in deterministic order.

The protocol is:

1. Trading locks the market and stabilizes the matching plan;
2. Financial locks existing reservation rows by order ID ascending;
3. Financial resolves all required wallets and ledger accounts;
4. Financial locks relevant asset rows for share in asset-code order;
5. Financial locks all affected ledger account rows by account ID ascending;
6. Financial derives authoritative balances and validates the complete plan;
7. Financial writes reservation, settlement, and optional release effects in deterministic
   execution order;
8. Trading and Financial changes commit once.

The implementation must use one consistent ordering across placement and cancellation. It must not
lock accounts one trade at a time in caller order because two commands on different markets could
otherwise hold opposite subsets and deadlock unnecessarily.

Market serialization makes the matching plan stable while locks are acquired. Deadlocks or
serialization failures remain retryable infrastructure outcomes; retries use the original Trading
idempotency key. Repositories do not hide unbounded retries.

## 11. Idempotency and Conflict Semantics

Trading's owner-scoped placement idempotency remains the user-command boundary. Financial adds
operation-specific durable defenses:

| Effect | Scope | Key |
| --- | --- | --- |
| Initial reservation | `trading.order.reserve` | order ID |
| Trade settlement | `trading.trade.settle` | trade ID |
| Terminal release | `trading.order.release` | order ID |

Each Financial journal persists a canonical intent hash containing its operation, business
references, account identities, posting order, exact directions, and exact amounts.

- Same identity and intent returns the existing effect.
- Same identity with different intent is an invariant conflict.
- Concurrent identical attempts can commit only one journal and movement set.
- A partially existing placement plan is an invariant failure, not permission to repair state
  opportunistically.
- A rolled-back plan leaves no committed idempotency record and may be attempted again.

The complete placement capability returns a small application result such as applied or existing,
plus expected pre-acceptance rejections for missing wallets, disabled assets, or insufficient
available balance. Missing maker reservations, reservation mismatches, insufficient reserved value,
partial replay state, and conflicting Financial intent are internal invariant failures that roll
back and are not presented as ordinary user validation errors.

## 12. Persistence and Constraint Ownership

Financial owns:

- `financial.trading_reservations`;
- `financial.trading_reservation_movements`;
- Trading-related journal operation rules;
- wallet and account resolution;
- reservation state transitions;
- journal and posting construction;
- balance validation and deterministic account locks.

Trading owns orders, trades, matching, market state, and when business effects are requested.

The Financial tables reference only Financial assets, accounts, journals, and their own reservation
rows. Trading IDs are opaque values without cross-schema foreign keys. Deferrable database
constraint triggers verify at least:

- every reservation journal has exactly one matching reservation resource and two correct postings;
- every release journal has exactly one matching release movement and two correct postings;
- every settlement journal has exactly two matching reservation movements and four or five correct
  postings;
- reservation remaining amount reconciles with immutable movements;
- journal, movement, asset, owner, order, trade, and operation identities agree;
- committed reservation and movement facts cannot be deleted or rewritten outside the permitted
  monotonic reservation-state update.

Application validation remains necessary. Database enforcement protects the durable Financial
shape without querying or mutating Trading-owned tables.

The Financial reservation tables, movement tables, functions, and triggers enter Atlas's committed
API migration sequence as Financial-owned schema. API startup does not create, seed, repair, or
alter them. Applied migrations remain immutable and advance the shared schema version.

## 13. Minimum Invariant Evidence

Implementation must prove at least:

- buy orders reserve exact quote notional at their limit;
- sell orders reserve exact base quantity;
- insufficient available balance creates no reservation, order, trade, or journal;
- missing required wallets create no partial state;
- one order cannot own two reservations or share another order's reservation;
- partial fills reduce seller and buyer reservations by the exact accepted amounts;
- buyer price improvement is exact and returned in the same settlement journal;
- multiple fills leave the exact residual reserve independent of fill fragmentation;
- full fills consume the reservation completely;
- owner cancellation releases the complete residual exactly once;
- self-trade prevention releases only the incoming residual and does not change the maker;
- release succeeds for a disabled asset while new placement fails;
- Financial resolves accounts internally and Trading never supplies posting directions;
- every trade has exactly one settlement journal and two reservation movements;
- reservation and movement facts reconcile with journal postings;
- identical retries return existing effects and conflicting identity reuse fails;
- concurrent placements cannot overdraw available or reserved accounts;
- cross-market placement locks affected accounts in one deterministic order;
- any Trading or Financial failure rolls back the entire composite transaction.

Pure quantity rules may use domain tests. Reservation persistence, journal shape, constraint
triggers, account locking, idempotency races, disabled-asset release, and cross-module atomicity use
real PostgreSQL reconstructed from committed migrations.

# Alternatives Considered

## Expose the generic journal command to Trading

Rejected because accepting account IDs and caller-defined postings would make Trading an accounting
authority and would expose Financial implementation details.

## Let each Financial operation start its own transaction

Rejected because an order or trade could commit without its reservation or settlement, or a journal
could commit without the Trading fact it references.

## Call reserve and settle capabilities one trade at a time

Rejected because Financial would discover and lock account subsets incrementally. Concurrent
cross-market commands could acquire overlapping owners in opposite order, and partial plan handling
would become harder to reason about.

## Store only journals without a reservation resource

Rejected because determining an order's remaining commitment would require repeated interpretation
of unstructured business references and would provide a weak concurrency boundary for settlement
and release.

## Store mutable reserved balances on orders

Rejected because Trading would become a second balance authority. Trading stores remaining lots;
Financial owns the exact reserved asset amount and its journal history.

## Store Financial account or journal IDs on Trading orders

Rejected because the shared order ID already provides stable correlation and because persistence
identifiers would couple Trading to Financial internals without improving correctness.

## One settlement journal for an entire incoming order

Rejected because a trade is the immutable execution fact and needs one independently idempotent,
auditable accounting event. One journal per trade makes retries and reconciliation explicit.

## Separate price-improvement release journal

Rejected because price improvement is part of one execution's quote settlement. A separate journal
could commit or retry independently and temporarily overstate reserved value.

## Reject release when an asset is disabled

Rejected because disabling new activity must not trap value already committed to an order.

## Cross-schema foreign keys to Trading orders and trades

Rejected because they create schema ownership cycles. The shared transaction, opaque business IDs,
Financial constraint triggers, and integration tests provide the required atomic evidence.

## Asynchronous settlement through events

Rejected because events cannot preserve the initial invariant that a committed trade and its ledger
effects exist atomically.

# Consequences

## Positive Consequences

- Trading cannot construct postings or select Financial accounts.
- Every order and trade commits atomically with exact Financial effects.
- Complete-plan locking reduces cross-market deadlock risk.
- Reservation resources make outstanding commitments explicit and auditable.
- One settlement journal per trade gives stable reconciliation and idempotency.
- Price improvement cannot be rounded or separated from settlement.
- Disabled assets can safely unwind reservations.
- The order ID provides correlation without leaking persistence identifiers.
- Existing journal and balance invariants remain the final accounting authority.

## Negative Consequences

- The composite unit of work requires deliberate cross-module infrastructure composition.
- Placement must stabilize the complete match plan before Financial posts effects.
- Reservation resources and movement history add schema and constraint complexity.
- One journal per trade increases journal volume for orders filled by many makers.
- Deferrable cross-row integrity triggers require careful real-PostgreSQL tests.
- Financial and Trading remain transactionally coupled inside one database.
- A future dedicated matching service will require a different settlement architecture.

# Deferred Decisions

This ADR does not decide:

1. public Trading HTTP routes, errors, authentication, CSRF, and rate limits;
2. order, trade, reservation, and journal observability fields exposed to users or operators;
3. order-book, ticker, candle, and Market Data projections;
4. browser order entry, confirmation, cancellation, and history workflows;
5. maker/taker fees and fee-revenue postings;
6. administrative market controls, mass cancellation, and asset-disable orchestration;
7. partial cancellation, order amendment, market orders, or additional time in force;
8. asynchronous or external settlement, clearing, custody, or reconciliation;
9. partitioning, archival, and high-volume journal or reservation projections;
10. a distributed transaction or dedicated matching service.

# Reconsider When

Review this decision when Trading and Financial no longer share one PostgreSQL transaction,
measured journal or constraint cost becomes a bottleneck, fees require richer settlement plans,
orders can amend or share collateral, margin introduces portfolio-level reservations, external
clearing makes settlement asynchronous, or cross-market account contention requires a different
locking architecture.

# Relationship to Other Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-021 — MVP Asset Catalog and System-Account Provisioning](ADR-021-mvp-asset-catalog-and-system-account-provisioning.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [ADR-027 — MVP Trading Market Catalog and Persistence Strategy](ADR-027-mvp-trading-market-catalog-and-persistence-strategy.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

Trading persistence, Financial reservation persistence, the composite transaction runner, and the
transaction-bound placement and cancellation capabilities may now be implemented. Public Trading
transport remains gated by its own focused contract decision.
