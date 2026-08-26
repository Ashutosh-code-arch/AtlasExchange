# ADR-027 — MVP Trading Market Catalog and Persistence Strategy

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-26  
**Last reviewed:** 2026-08-26  
**Canonical owner/source:** ADR-027

## Context

ADR-026 defines Atlas's synchronous spot limit-order book, exact lots and ticks, order lifecycle,
price-time priority, maker-price execution, cancel-taker self-trade prevention, reservation rules,
atomic settlement, idempotency, and per-market concurrency authority. The independently testable
market, order, and matcher domain core is implemented.

Trading still has no accepted market catalog or persistence model. Without those decisions, a
migration could accidentally choose increments that require rounding, duplicate Financial asset
authority, permit impossible order states, make matching order dependent on timestamps, or weaken
module ownership through direct cross-module table access.

ADR-010 makes committed migrations authoritative and permits Trading and Financial to participate
in one PostgreSQL transaction through public application capabilities. ADR-020 and ADR-021 make
Financial the authority for asset identity, scale, wallets, accounts, journals, and balances. This
decision must preserve those boundaries while giving PostgreSQL enough structure to protect
durable Trading facts.

This ADR decides the initial market catalog, the shape and authority of the Trading schema, durable
order and trade invariants, matching indexes, immutability, and the initial locking boundary. It
does not define Financial reservation capability signatures, HTTP contracts, browser workflows,
or Market Data projections.

## Decision Drivers

The Trading persistence foundation should:

1. provision a small, reproducible market catalog through committed migrations;
2. guarantee exact settlement for every whole lot and price tick without hidden rounding;
3. preserve Financial as the authority for asset code and ledger scale;
4. make impossible order lifecycle combinations unrepresentable in PostgreSQL;
5. preserve deterministic price-time priority across processes and retries;
6. retain immutable, independently explainable trade facts;
7. support efficient best-price matching and owner-scoped history reads;
8. enforce placement idempotency at the durable uniqueness boundary;
9. preserve the module rules from ADR-008 while using reviewed relational integrity;
10. remain understandable and operable by one developer.

# Decision

Atlas will provision **BTC-USD** and **ETH-USD** as its initial active markets and persist Trading
state in one application-owned PostgreSQL schema named `trading`.

~~~text
financial.assets                         trading
authoritative code + scale               owns market and execution state
       │                                      │
       └── reviewed asset foreign keys ───────┤
                                              ├── markets
                                              ├── orders
                                              └── trades

Trading application composition
       ├── loads Trading market record
       ├── resolves Financial asset descriptors through a public capability
       └── reconstructs the exact Market domain object
~~~

The database protects relational identity, lifecycle shape, immutability, and matching order. The
Trading application remains responsible for business transitions, cross-row role consistency,
cross-module orchestration, and exact Financial effects.

## 1. Initial Market Catalog

The migration-provisioned MVP catalog is:

| Market | Base scale | Quote scale | Base lot | Price tick | Minimum | Maximum | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `BTC-USD` | 8 | 2 | `0.001 BTC` | `10.00 USD/BTC` | `0.001 BTC` | `10 BTC` | `active` |
| `ETH-USD` | 18 | 2 | `0.01 ETH` | `1.00 USD/ETH` | `0.01 ETH` | `1,000 ETH` | `active` |

The authoritative stored integer values are:

| Market | Base atomic units per lot | Quote atomic units per price tick | Minimum lots | Maximum lots |
| --- | ---: | ---: | ---: | ---: |
| `BTC-USD` | `100000` | `1000` | `1` | `10000` |
| `ETH-USD` | `10000000000000000` | `100` | `1` | `100000` |

`quote atomic units per price tick` means the quote-asset atomic units added to the unit price for
one whole base asset. For USD scale two, `1000` is 10.00 USD and `100` is 1.00 USD.

These increments satisfy ADR-026's exact-divisibility rule at the smallest combination:

~~~text
BTC-USD: 100000 × 1000 / 100000000 = 1 USD atomic unit
ETH-USD: 10000000000000000 × 100 / 1000000000000000000 = 1 USD atomic unit
~~~

Therefore every whole-lot and whole-tick notional settles to an integral USD cent regardless of
how an order is fragmented across fills. The relatively coarse increments are deliberate: Atlas
prefers visible exactness over pretending that a two-decimal USD ledger can settle arbitrarily
fine crypto quantity and price combinations.

Both initial markets share USD as quote asset. A crypto-crypto market would add a second settlement
precision model without proving a new MVP capability. Market prices are simulated user inputs;
Atlas does not claim they reflect an external venue or fair value.

## 2. Catalog Authority and Lifecycle

Committed migrations are the initial catalog authority.

- API startup does not seed, repair, or mutate markets.
- Ordinary requests cannot create markets or change their increments.
- Environment variables cannot redefine market identity or precision.
- A catalog addition requires a reviewed migration until an administrative capability is accepted.
- An applied catalog migration is immutable; corrections use a later migration.

The market row records:

- stable code;
- base and quote asset codes;
- base atomic units per lot;
- quote atomic units per price tick;
- minimum and maximum whole lots;
- operational status;
- creation and update timestamps.

Market code, base asset, quote asset, lot size, price tick, and creation timestamp are immutable.
Minimum and maximum order lots may later change prospectively through a controlled capability;
they do not reinterpret an existing order's original quantity. Status may change according to
ADR-026. The database maintains the update timestamp.

A transition to `disabled` is permitted only when the market has no open or partially filled
orders. The application command proves this while holding the market lock, and a database trigger
rejects a disabled state while an active order remains. The first migration does not expose a
runtime status-management command; when that command is introduced, a real-PostgreSQL integration
test must prove that the transition and residual reservation release are atomic.

## 3. Asset References and Module Ownership

`trading.markets.base_asset_code` and `quote_asset_code` reference
`financial.assets(code)` with restricted update and deletion. This is an explicitly reviewed
relational-integrity exception, not permission for Trading to consume Financial persistence.

The exception is narrow because:

- both schemas live in the same PostgreSQL database and migration sequence;
- asset codes are stable shared identifiers already exposed by Financial;
- deleting or renaming an asset referenced by a historical market must fail;
- the foreign key prevents an impossible catalog record at low operational cost.

Trading does not duplicate asset display names or ledger scales. A Trading repository reads only
the `trading` schema. Application composition obtains asset descriptors through a Financial public
catalog capability and combines them with the Trading record to construct the Market domain
object. Direct Trading repository joins to Financial tables remain prohibited.

Order owner IDs are opaque Identity subject identifiers and deliberately have no foreign key to an
Identity table. Identity lifecycle and authentication remain separate from immutable Trading
history.

## 4. Market Persistence

`trading.markets` uses the stable market code as its primary key and enforces:

- canonical `BASE-QUOTE` code shape;
- distinct base and quote assets;
- one market per ordered base/quote pair;
- positive integral lot and tick values within Atlas's 38-digit atomic-value bound;
- positive integral minimum and maximum lots;
- maximum lots greater than or equal to minimum lots;
- status restricted to `active`, `cancel_only`, or `disabled`.

PostgreSQL cannot validate the exact-divisibility formula without reading Financial's asset scale.
That invariant is proven when application composition constructs the Market and by migration
integration tests that load every provisioned market with the authoritative Financial catalog.

The market row is also the initial order-book serialization lock. It is both durable configuration
and a stable coordination record; it is not an aggregate balance or an in-memory book snapshot.

## 5. Order Persistence

`trading.orders` stores immutable accepted intent and mutable current lifecycle state.

| Concern | Stored fields |
| --- | --- |
| Identity | order ID, owner ID, market code |
| Intent | side, order type, time in force, original lots, limit-price ticks |
| Retry identity | idempotency key, canonical intent hash |
| Priority | database-generated acceptance priority |
| Lifecycle | filled lots, remaining lots, status, terminal reason, version |
| Time | created and updated timestamps |

Order IDs use Atlas's UUIDv7 convention. Owner ID and market code are required. The only accepted
values initially are:

- side: `buy` or `sell`;
- order type: `limit`;
- time in force: `good_til_cancelled`;
- status: `open`, `partially_filled`, `filled`, or `cancelled`;
- terminal reason: `owner_cancelled` or `self_trade_prevention`.

Original, filled, and remaining lots and limit ticks are positive or non-negative integral
NUMERIC values constrained to Atlas's 38-digit bound. PostgreSQL NUMERIC values are decoded to
strings and converted explicitly to bigint-backed domain values; JavaScript number is never an
authoritative persistence representation.

The row-level lifecycle constraints are:

~~~text
filled lots + remaining lots = original lots

open:
  filled = 0, remaining > 0, terminal reason is absent

partially_filled:
  filled > 0, remaining > 0, terminal reason is absent

filled:
  filled = original, remaining = 0, terminal reason is absent

cancelled:
  remaining > 0, terminal reason is present
~~~

A cancelled order may have zero or positive filled lots because owner cancellation or self-trade
prevention can follow earlier fills. A filled order cannot also be cancelled. The current order
row is the lifecycle authority; immutable trades explain its filled quantity.

Order ID, owner, market, side, type, time in force, original lots, limit ticks, priority,
idempotency identity, intent hash, and creation timestamp are immutable. Updates may change only
filled lots, remaining lots, status, terminal reason, version, and the managed update timestamp.
Application updates use the expected version so stale lifecycle writes fail rather than overwrite
newer state. A database transition trigger additionally requires filled lots to be non-decreasing,
remaining lots to be non-increasing, and version to increase by exactly one for each lifecycle
update. It permits only open to partially filled, filled, or cancelled; partially filled to another
partially filled state, filled, or cancelled; and no transition out of a terminal state. Terminal
rows never reopen.

## 6. Durable Acceptance Priority

Acceptance priority is a positive BIGINT supplied by a PostgreSQL sequence and protected by a
unique constraint. It is assigned while the application holds the market row lock and accepts the
order. Sequence gaps caused by rollbacks are expected and have no business meaning.

Priority is globally monotonic rather than reset per market. Price-time comparison is always
within one market, so a global sequence is simpler and still supplies a total acceptance order.
The immutable UUID is the final tie-breaker even though the unique priority constraint should make
ties impossible under normal persistence.

Created timestamps are observability and presentation data. They do not determine matching order.

## 7. Placement Idempotency

Every order row stores the caller's placement idempotency key and a lowercase hexadecimal SHA-256
hash of the canonical placement intent. The database enforces uniqueness on owner ID plus
idempotency key.

The key is trimmed, between 1 and 200 characters, and opaque to the server. The intent hash covers
market, side, fixed type, fixed time in force, exact lots, and exact limit ticks. It does not cover
derived reservation values or timestamps.

This constraint is the durable final boundary for concurrent retries:

- an identical committed retry resolves the existing order and result;
- different intent under the same owner and key is an idempotency conflict;
- two owners may use the same opaque key independently;
- rollback removes the order and every associated Financial effect, permitting a later retry.

No separate generic idempotency table is introduced for the first placement lifecycle. If later
commands need durable results that do not naturally own a resource, Atlas may revisit a shared
command-record pattern without changing this order identity.

## 8. Trade Persistence

`trading.trades` is an append-only record of committed executions. Each row records:

- UUIDv7 trade ID;
- market code;
- maker and taker order IDs;
- buyer and seller order IDs;
- positive execution lots;
- positive maker-price ticks;
- database-generated execution sequence;
- execution timestamp.

Maker and taker must be different orders; buyer and seller must be different orders. All four order
references use restricted deletion. The database also protects a unique execution sequence.

Ordinary CHECK constraints cannot prove that all referenced orders belong to the stored market or
that buyer and seller sides match their declared roles. A deferred database constraint trigger
therefore requires all four order references to belong to the trade's market, requires the declared
buyer and seller to have the corresponding sides, and requires maker plus taker to be the same two
orders as buyer plus seller. The Trading application proves the same facts before insertion, and
real-PostgreSQL integration tests exercise the complete operation.

Trade rows cannot be updated or deleted. Corrections require compensating business actions; they do
not rewrite execution history. An execution-sequence gap is not a missing trade and carries no
business meaning.

Trading does not store Financial account IDs or construct journal postings. Financial journals use
order and trade IDs as business references under the capability contract decided next. Whether
Trading stores a direct reservation or settlement resource identifier is deferred to that
cross-module capability decision so the persistence model does not invent Financial ownership.

## 9. Matching and History Indexes

The initial schema creates two explicit partial matching indexes:

~~~text
sell makers:
  market, limit ticks ASC, priority ASC, order ID ASC
  where side = sell and status in (open, partially_filled)

buy makers:
  market, limit ticks DESC, priority ASC, order ID ASC
  where side = buy and status in (open, partially_filled)
~~~

Separate bid and ask indexes make the accepted best-price directions visible and avoid relying on
one generic index whose ordering is correct for only one side.

The schema also supports:

- owner order history by owner ID, creation time descending, then order ID descending;
- market execution history by market code and execution sequence;
- lookup from each trade role to its referenced order where query plans demonstrate the need.

Indexes are implementation support, not public read-model contracts. Order-book depth, ticker,
candle, and browser history projections require their own decisions. Indexes are added from
measured query plans rather than pre-creating every possible combination.

## 10. Transaction and Lock Protocol

The place-order application use case follows ADR-026's correctness-first protocol:

1. resolve an identical committed retry;
2. select the market row for update;
3. resolve authoritative Financial asset descriptors and reconstruct the Market;
4. validate status, exact increments, bounds, wallets, and available balance;
5. insert the accepted order and reserve its maximum spend through Financial;
6. select and lock crossing makers in the matching index's deterministic order;
7. insert trades and versioned order transitions;
8. settle and release through Financial's deterministic account-locking protocol;
9. commit once.

Cancellation acquires the same market lock before the order and Financial account effects. Market
locks are acquired before Trading order locks; Financial capabilities then acquire ledger-account
locks in their accepted deterministic order. Repositories do not independently choose transaction
boundaries or hide unbounded retries.

The market lock serializes placement and cancellation only within one market. Different markets
may proceed concurrently, subject to owners sharing Financial accounts. Atlas does not select
universal SERIALIZABLE isolation or a distributed lock for the first implementation. A more
concurrent order-book authority requires measured contention and a replacement design that still
proves price-time priority.

## 11. Migration and Verification Rules

The Trading schema and catalog enter the same committed API migration sequence as Financial and
Identity. There is one root migration history, not an independently pushed Trading schema.

- Production migration is a separate deployment step; API startup never pushes schema.
- Applied migrations are immutable.
- Tests reconstruct schema from the committed migration history.
- Catalog provisioning occurs in migration SQL, not runtime seed code.
- Kysely and pg access remains behind Trading infrastructure adapters.
- Migration SQL advances Atlas's system schema version.

Implementation must prove at least:

- both catalog markets load with exact accepted increments and bounds;
- every provisioned market reconstructs against Financial's authoritative scales;
- the exact-divisibility property holds for each catalog entry;
- unknown assets, duplicate pairs, identical base/quote, invalid status, and invalid bounds fail;
- immutable market identity and increment changes fail;
- disabling a market with an active order fails;
- impossible order lifecycle combinations fail at the database boundary;
- immutable order intent, invalid monotonic transitions, and terminal reopening fail;
- owner-scoped idempotency permits one effect and detects conflicting intent;
- priority and execution sequences remain unique under concurrency;
- matching queries return best price, then earliest priority, then ID;
- trade facts are append-only and preserve valid market, maker/taker, and buyer/seller roles;
- concurrent takers cannot consume the same maker quantity twice;
- cancellation racing matching produces one valid committed outcome;
- a rolled-back order or trade leaves no partial Trading or Financial effect.

Pure arithmetic and matching remain domain tests. Constraints, migrations, query ordering, locks,
idempotency races, and cross-module atomicity use real PostgreSQL.

# Alternatives Considered

## Finer USD price ticks with smaller crypto lots

Rejected because the smallest lot-and-tick product would require fractional USD cents. Hidden
rounding would make notional depend on fill fragmentation and contradict ADR-026.

## Decimal quantity and price columns with implicit rounding

Rejected because arbitrary decimal values obscure market increments and allow persistence to accept
values that the matcher or ledger cannot settle exactly.

## Duplicate Financial asset scales in Trading

Rejected because two authoritative scale records could diverge and reinterpret the same atomic
quantity. Trading obtains scales through Financial's public catalog capability.

## Trading repositories join Financial tables

Rejected because a relational foreign key does not grant another module access to Financial's
implementation. Cross-module behavior uses public application capabilities.

## No cross-schema asset foreign keys

Rejected initially because the schemas share one database and asset identity is immutable. The
narrow restricted foreign key cheaply prevents markets from referencing nonexistent or deleted
assets while preserving repository isolation.

## Timestamp-only order priority

Rejected because timestamps can collide and do not provide a durable total acceptance order under
concurrent processes.

## One generic matching index

Rejected because bids and asks have opposite best-price directions. Explicit partial indexes make
the intended access paths reviewable and exclude terminal rows.

## Event-sourced orders

Rejected initially because immutable trades plus a constrained current order row provide the
required auditability with less projection and recovery complexity.

## Runtime market seeding or request-driven creation

Rejected because startup and ordinary request paths must not silently create Trading authority.

## Separate Trading database or service

Rejected because Atlas needs atomic local Trading and Financial transactions and has no measured
organizational or scaling reason for a distributed boundary.

# Consequences

## Positive Consequences

- Fresh environments receive the same exact-settlement-compatible markets.
- PostgreSQL rejects many impossible order states before they can become durable.
- Matching priority remains deterministic across restarts and API instances.
- Immutable trades provide an explainable execution history.
- Financial remains the only asset-scale, wallet, account, journal, and balance authority.
- Separate bid and ask indexes support the accepted matching order directly.
- Placement retries have a durable owner-scoped uniqueness boundary.
- The market row provides a simple, auditable initial concurrency authority.

## Negative Consequences

- Coarse price ticks limit price granularity in the educational MVP.
- The reviewed cross-schema foreign keys couple migration ordering inside the shared database.
- Per-market serialization limits peak throughput for a highly active market.
- Mutable order rows require careful versioned updates and constraints.
- Cross-row trade-role invariants still require application and integration evidence.
- Global sequences contain harmless gaps and cannot be treated as event counts.
- Catalog and increment changes require migrations until administration is designed.

# Deferred Decisions

This ADR does not decide:

1. Financial reservation, release, settlement, and price-improvement capability signatures;
2. whether Trading stores an explicit reservation relationship identifier;
3. the exact journal operation types and business-reference shapes for orders and trades;
4. public placement, cancellation, order, trade, and market HTTP contracts;
5. authenticated rate limits, CSRF behavior, and public Trading error taxonomy;
6. order-book, market-history, ticker, candle, and Market Data projections;
7. browser order entry, confirmation, open orders, cancellation, and trade history;
8. market administration, status transitions, limit changes, and mass cancellation;
9. maker/taker fees, fee precision, and fee settlement;
10. additional markets, quote assets, order types, time in force, and price bands;
11. archive, partition, retention, and high-volume read-model strategy;
12. a dedicated or more concurrent matching authority.

# Reconsider When

Review this decision when a two-decimal USD ledger cannot support required market granularity,
measured market-lock contention prevents required throughput, order or trade volume requires
partitioning, asset identity moves outside the shared database, controlled market administration
enters scope, more quote assets need different precision rules, or a dedicated matching service
becomes operationally justified.

# Relationship to Other Decisions

- [ADR-004 — Testing Architecture](ADR-004-testing-architecture.md)
- [ADR-008 — Backend Application Architecture](ADR-008-backend-application-architecture.md)
- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [ADR-021 — MVP Asset Catalog and System-Account Provisioning](ADR-021-mvp-asset-catalog-and-system-account-provisioning.md)
- [ADR-026 — Trading Market, Order, and Matching Foundation](ADR-026-trading-market-order-and-matching-foundation.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)

# Status

**Accepted**

The Trading market catalog and persistence migration may now be implemented. Cross-module
reservation, release, settlement, and price-improvement orchestration remains gated by the focused
Financial capability decision that follows.
