# ADR-026 — Trading Market, Order, and Matching Foundation

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-26  
**Last reviewed:** 2026-08-26  
**Canonical owner/source:** ADR-026

## Context

Atlas has completed its Financial foundation. Exact asset quantities, owner-scoped wallets,
available and reserved accounts, immutable balanced journals, authoritative balance reads, and
retry-safe simulated money movement are implemented. Trading can now reserve and settle value
without inventing a second balance authority.

ADR-008 assigns business orchestration to application use cases and prohibits cross-module
repository access. ADR-010 permits Trading and Financial to participate in one PostgreSQL
transaction through explicit public capabilities. ADR-020 requires Trading to request reservation,
release, and settlement from Financial rather than constructing postings or updating balances.

Those decisions do not define a market, price and quantity increments, order types, lifecycle,
matching priority, self-trade behavior, execution price, reservation amount, settlement semantics,
idempotency, or the concurrency authority for an order book. These rules must be decided before the
first Trading migration because the schema and lock protocol would otherwise become an accidental
matching specification.

## Decision Drivers

The Trading foundation should:

1. preserve exact base and quote quantities without floating-point arithmetic or hidden rounding;
2. implement deterministic, explainable matching behavior;
3. prevent an order from spending value that was not reserved for it;
4. settle every trade atomically with its order and Financial effects;
5. preserve price-time priority under concurrent commands;
6. make placement retries safe and conflicting duplicate requests visible;
7. prevent self-trading under an explicit policy;
8. keep Trading, Financial, Identity, and future Market Data ownership distinct;
9. remain understandable and operable by one developer;
10. avoid premature market orders, asynchronous matching, event sourcing, and distributed services.

# Decision

Atlas will implement a **synchronous spot limit-order book** with deterministic price-time priority.
The Trading application command owns one PostgreSQL transaction containing order persistence,
reservation, matching, immutable trades, settlement, and any required release.

~~~text
Authenticated owner + market + limit order + idempotency key
                              ↓
                   resolve committed retry
                              ↓
                    lock the market book
                              ↓
             validate and reserve exact value
                              ↓
             match by price, then acceptance order
                              ↓
       persist trades and update both order lifecycles
                              ↓
         settle and release through Financial capabilities
                              ↓
                         commit once
~~~

## 1. Market Model

A market is an explicitly provisioned Trading aggregate containing:

- an immutable stable market code;
- one base asset code and one different quote asset code;
- an immutable base quantity lot size;
- an immutable price tick;
- minimum and optional maximum order quantities expressed as whole lots;
- an operational status;
- timestamps.

The market code uses the canonical form BASE-QUOTE, for example BTC-USD. Asset codes refer to the
immutable Financial catalog identifiers, but Trading repositories do not query Financial tables.
The application validates asset existence and operational eligibility through a Financial public
capability.

An initial market catalog and its concrete increments require a focused follow-up decision. Markets
are provisioned through committed migrations initially; ordinary requests cannot create or alter
market authority.

The initial lifecycle is:

- active — accepts new orders and permits matching and cancellation;
- cancel_only — rejects new orders and matching but permits cancellation of resting orders;
- disabled — has no resting orders and permits neither new orders nor matching. A market may enter
  this state only after every resting order is cancelled and its reservation is released.

Changing a market status never rewrites existing orders or trades. Changing base asset, quote asset,
lot size, or price tick after the market has an order is prohibited because it would reinterpret
historical facts.

## 2. Exact Lots, Ticks, and Notional

Authoritative Trading arithmetic uses bigint-backed integer value objects:

~~~text
base quantity atomic = quantity lots × base atomic units per lot
unit price            = price ticks × quote atomic units per price tick per whole base unit
quote notional atomic =
  (base quantity atomic × unit price) / base atomic units per whole base unit
~~~

The transport may present quantity and unit price as canonical decimal strings, but an adapter must
convert them exactly into the market's integer lots and ticks. A value between increments is invalid;
Atlas never rounds an order onto a valid increment.

The market configuration must make the notional numerator exactly divisible by the base atomic
units per whole base unit for every valid whole-lot and whole-tick product. This rule keeps price
tick in its conventional unit-price meaning while preventing settlement from depending on rounding
direction, fill fragmentation, or binary floating point. A catalog decision must demonstrate this
property for every provisioned market.

Rules:

- quantities and prices are strictly positive;
- zero-lot and zero-tick orders are invalid;
- arithmetic across different markets or asset pairs is rejected;
- multiplication checks the Financial NUMERIC(38, 0) atomic-unit bound before persistence;
- displayed unit prices are derived exactly from ticks and quote-asset scale;
- JSON numbers are never authoritative Trading quantities or prices.

Fees are zero in the initial Trading lifecycle. A fee decision must define fee asset, basis,
precision, rounding, presentation, and Financial postings before any fee can be charged.

## 3. Initial Order Scope

The MVP accepts only:

- spot orders;
- buy and sell sides;
- limit orders;
- good_til_cancelled time in force.

The placement intent contains only:

- the authenticated owner from trusted server context;
- market code;
- side;
- canonical limit-price string;
- canonical quantity string;
- fixed order type and time in force;
- caller-supplied idempotency key.

The client cannot supply owner IDs, wallet IDs, account IDs, reserved amounts, filled quantities,
status, priority, trades, journal identifiers, postings, fees, or execution prices.

Market orders, stop orders, stop limits, trailing orders, iceberg orders, post-only,
immediate-or-cancel, fill-or-kill, expiry, margin, leverage, short selling, borrowing, and order
amendment are deferred. A changed price or quantity requires cancellation followed by a new order
with a new idempotency intent.

Both base and quote wallets must already exist for the authenticated owner. Placement does not
silently create a receiving wallet or infer ownership from client input.

## 4. Order Lifecycle and Authority

Trading persists the immutable original intent and mutable current execution state. The lifecycle
is:

~~~text
accepted → open → partially_filled → filled
                  └───────────────→ cancelled
accepted ─────────────────────────→ filled
accepted/open/partially_filled ───→ cancelled by self-trade prevention
~~~

An order records at minimum:

- immutable order ID, owner ID, market, side, type, time in force, original lots, limit ticks,
  idempotency identity, and acceptance priority;
- current filled lots, remaining lots, status, version, and update timestamp;
- an optional terminal reason such as owner_cancelled or self_trade_prevention.

Invariants:

- filled lots plus remaining lots equals original lots;
- open means no fill and positive remaining lots;
- partially_filled means positive filled and remaining lots;
- filled means filled equals original and remaining is zero;
- cancelled preserves the unfilled remaining quantity and cannot match again;
- terminal orders cannot reopen;
- original intent and acceptance priority never change.

The mutable order row is the current lifecycle authority; immutable trades explain every fill.
Atlas will not introduce full event sourcing for orders initially. Database constraints and
transactional application checks protect lifecycle transitions.

## 5. Deterministic Price-Time Matching

An accepted incoming order acts as the taker while it executes synchronously. Resting opposite-side
orders are makers. Orders cross when:

~~~text
incoming buy limit  >= resting sell limit
incoming sell limit <= resting buy limit
~~~

Eligible makers are selected in this order:

1. best price — lowest sell price or highest buy price;
2. earliest immutable acceptance priority;
3. immutable order ID as a final deterministic tie-breaker.

Acceptance priority comes from a database-generated monotonic sequence assigned when the order is
accepted. Wall-clock timestamps do not decide ties.

Each execution uses the resting maker's limit price. The execution quantity is the smaller of the
taker's remaining lots and maker's remaining lots. Matching continues until the taker is filled, no
crossing maker remains, self-trade prevention cancels its residual, or an invariant failure rolls
back the whole command.

Any unfilled, uncancelled taker residual becomes a resting order without losing its original
acceptance priority. Matching never depends on process memory, JavaScript collection iteration
order, random selection, or external market data.

## 6. Self-Trade Prevention

Atlas will use **cancel-taker** self-trade prevention. When the next price-priority maker belongs to
the incoming order's owner:

- no self-trade is created;
- the incoming order's remaining quantity is cancelled;
- earlier legitimate fills in the same command remain part of the atomic result;
- the resting maker remains unchanged;
- the terminal reason is self_trade_prevention.

Skipping the owner's maker and matching a worse-priority order would violate transparent price-time
priority. Allowing the self-trade would create misleading volume and avoidable abuse risk. More
configurable account-group policies remain deferred.

## 7. Reservation Rules

An order may be accepted only after Financial reserves its maximum spend:

~~~text
sell reserve = original base quantity
buy reserve  = exact quote notional at the order's limit price
~~~

Reservation moves value from the owner's available account to reserved account through a balanced
Financial journal. Trading stores the business relationship between the order and reservation but
does not receive account identifiers or construct postings.

Orders cannot share one reservation. A placement with insufficient available balance fails without
an order, trade, or journal. Disabled assets, unavailable markets, missing wallets, invalid
increments, and out-of-bound values likewise create no partial state.

For a resting order, the required reserve always equals its remaining maximum spend:

- sell order — remaining base quantity;
- buy order — remaining lots valued at the immutable limit price.

## 8. Trade Settlement and Price Improvement

Every match creates one immutable trade recording:

- trade ID and market;
- maker and taker order IDs;
- buyer and seller order IDs;
- exact execution lots and maker price ticks;
- immutable execution sequence and timestamp.

Settlement occurs through Financial inside the same transaction:

~~~text
Base asset:
  debit  seller reserved
  credit buyer available

Quote asset:
  debit  buyer reserved
  credit seller available
~~~

For a buy order executing below its limit, Financial also releases the exact unused quote reserve
for the filled lots from buyer reserved back to buyer available. After each execution, the
reservation remaining for an open buy equals its remaining lots valued at its limit, not the last
execution price.

A sell order's reserved base decreases by the executed base quantity. Filled orders retain no
reservation. Cancellation releases the entire residual reservation to available balance.

The trade, both order-state transitions, settlement journal, price-improvement release, and
reservation state commit atomically. No successful trade may exist without its Financial effects,
and no settlement journal may reference a trade that did not commit.

## 9. Transaction and Concurrency Authority

The place-order use case owns the cross-module transaction. It:

1. resolves a committed identical retry;
2. locks the market row as the order-book serialization boundary;
3. validates the market, assets, wallets, increments, and command;
4. persists the accepted order and exact reservation;
5. locks eligible maker orders in deterministic priority order;
6. executes deterministic matches;
7. persists trades and order transitions;
8. invokes Financial settlement and release capabilities using their deterministic account-locking
   protocol;
9. commits once.

Only one placement command mutates a market book at a time initially. This correctness-first
pessimistic boundary prevents two takers from consuming the same maker and makes price-time priority
observable. Commands for different markets may proceed concurrently, subject to Financial account
locks.

Cancellation also locks the market before the target order and its Financial accounts. It succeeds
only for the authenticated owner and only for a non-terminal order with remaining quantity.
Repeated cancellation of an already owner-cancelled order returns its existing result without a
second release. A filled order cannot be cancelled.

Deadlocks and serialization failures are retryable infrastructure outcomes. A caller retries place
order only with the original idempotency key and intent. Repositories do not hide unbounded retries.
The market-row boundary may be reconsidered only after measured contention justifies a more
concurrent matching architecture.

## 10. Placement Idempotency

Every externally initiated placement requires an idempotency key scoped to the authenticated owner
and place-order operation. The canonical intent includes market, side, type, time in force, exact
limit ticks, and exact quantity lots.

- First key and intent: accept, reserve, match, and persist one result.
- Same key and intent: return the original order and placement result without reserving or matching
  again.
- Same key with different intent: reject with an idempotency conflict.
- Concurrent same-key requests: exactly one placement effect may commit.

Idempotency identity, canonical intent hash, order, trades, and Financial effects share one
transaction. A committed identical retry resolves before current market or asset availability is
applied, preserving recovery after an ambiguous response.

Process-local deduplication may reduce duplicate work but is never the final correctness boundary.

## 11. Module Boundaries

Trading owns:

- market definitions and operational state;
- order intent, lifecycle, priority, and ownership;
- deterministic matching and self-trade prevention;
- trade records and maker/taker semantics;
- placement and cancellation idempotency;
- orchestration of reservation, release, and settlement.

Financial owns:

- wallets, accounts, balances, journals, and postings;
- exact asset quantities and asset operational eligibility;
- reservation, release, settlement, and price-improvement accounting invariants;
- deterministic account locking and non-negative balance enforcement.

Identity supplies only the authenticated subject through its public contract. Future Market Data
consumes committed Trading facts to build order-book, ticker, candle, and stream projections; it
does not participate in matching authority.

Trading modules do not import Financial internals, query Financial tables, receive Kysely or pg
objects, choose ledger accounts, or construct debit and credit postings. Cross-module calls use
narrow public application capabilities and one transaction context.

Post-commit events may notify future projections or users. They are not a substitute for atomic
order and Financial persistence.

## 12. Minimum Invariant Evidence

Implementation must prove at least:

- exact conversion between canonical decimals, lots, ticks, and quote atomic units;
- rejection of zero, negative, over-precision, off-increment, overflow, and mismatched-market values;
- deterministic best-price then earliest-priority matching;
- maker-price execution for incoming buys and sells;
- full fills, multiple partial fills, and resting residual orders;
- immutable original intent and terminal lifecycle enforcement;
- cancel-taker self-trade prevention without maker mutation;
- exact sell-base and buy-quote reservation;
- exact release on owner cancellation and price improvement;
- insufficient balance creates no order, trade, or journal;
- identical retries return one placement result and conflicting key reuse fails;
- concurrent takers cannot fill the same maker quantity twice;
- cancellation racing matching has one valid committed outcome;
- every trade and its order, reservation, settlement, and release effects commit or roll back together;
- base and quote journals balance independently and user balances remain non-negative;
- Trading cannot read or mutate another owner's order.

Pure matching rules receive deterministic domain tests. Persistence, locking, retry, cancellation,
and settlement behavior use real PostgreSQL reconstructed from committed migrations. A high-value
browser journey is added only after the public Trading contract and user workflow exist.

# Alternatives Considered

## Market orders in the first lifecycle

Rejected because market orders require price-protection, slippage, partial-liquidity, estimation,
and user-confirmation policies that are not needed to prove the core matching and settlement model.

## Asynchronous matching worker

Rejected initially because acknowledgement before reservation and matching introduces durable
queue, recovery, ordering, and eventual-consistency concerns without a demonstrated throughput need.

## In-memory order book as authority

Rejected because process restarts, multiple instances, and ambiguous persistence ordering could
lose orders or produce trades without durable settlement.

## Timestamp-only priority

Rejected because timestamps can collide and do not provide a sufficient deterministic acceptance
order under concurrent requests.

## Taker-price execution

Rejected because resting liquidity should retain its accepted price and maker-price execution is a
clear, deterministic rule.

## Skip self-owned makers

Rejected because bypassing a better-priority maker to execute against a worse order violates the
visible price-time ordering of the book.

## Trading-owned balance columns

Rejected because this would create a second financial authority outside the append-only ledger and
allow order state to diverge from withdrawable value.

## Hidden notional rounding

Rejected because fill fragmentation could change the settled quote amount and make matching results
difficult to explain or reproduce.

# Consequences

## Positive Consequences

- Matching behavior is deterministic and explainable from durable facts.
- Reservations prevent withdrawals or other orders from double-spending committed value.
- Exact lots and ticks remove hidden settlement rounding.
- Every trade and its accounting effects are atomic.
- Price-time priority remains correct under the initial concurrency model.
- Retries cannot place or execute an order twice.
- Trading and Financial retain explicit business ownership.
- The first implementation can begin with independently testable domain primitives and matching.

## Negative Consequences

- Serializing placement per market limits peak throughput.
- Cross-module transactions require deliberate composition and lock ordering.
- Requiring both wallets adds a user preparation step.
- Limit-only, good-til-cancelled scope is intentionally narrow.
- Exact-settlement-compatible market increments constrain catalog design.
- Mutable order lifecycle rows require careful constraints and concurrency tests.
- Zero fees make the MVP economically incomplete.

# Deferred Decisions

Follow-up decisions must define:

1. the initial market catalog, lot sizes, price ticks, and order bounds;
2. the Trading persistence schema and database-level lifecycle constraints;
3. Financial public reservation, release, and settlement capability shapes;
4. public Trading HTTP routes, authentication, CSRF, idempotency headers, and errors;
5. order, trade, and book read models;
6. the browser order-entry, confirmation, open-order, cancellation, and trade-history workflow;
7. Market Data projections, WebSocket delivery, snapshots, sequence recovery, tickers, and candles;
8. maker/taker fees and fee-accounting policy;
9. market orders and additional time-in-force policies;
10. administrative market controls and mass cancellation;
11. external liquidity, custody, compliance, surveillance, and account-group self-trade policy;
12. performance targets and a more concurrent or in-memory matching architecture.

# Reconsider When

Review this decision when measured market-lock contention prevents required throughput, multiple API
instances need a dedicated matching authority, fees or market orders enter scope, fractional
settlement needs a different precision model, orders span more than spot balances, external
liquidity is introduced, or regulatory surveillance requirements change the self-trade policy.

# Relationship to Other Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-021 — MVP Asset Catalog and System-Account Provisioning](ADR-021-mvp-asset-catalog-and-system-account-provisioning.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

Trading implementation may begin with exact market value objects, order lifecycle primitives, and a
pure deterministic matcher. Persistence and public exposure remain gated by the focused decisions
listed above.
