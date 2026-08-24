# ADR-021 — MVP Asset Catalog and System-Account Provisioning

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-25  
**Last reviewed:** 2026-08-25  
**Canonical owner/source:** ADR-021

## Context

ADR-020 defines assets as stable ledger denominations and requires explicit external-custody and
fee-revenue accounts. The implemented Financial schema can store those records, but Atlas does not
yet have an application catalog or provisioned system accounts. Deposit, withdrawal, fee, and later
settlement capabilities cannot safely infer assets from request input or create accounting accounts
on demand.

The Project Specification defines Atlas as a simulated centralized exchange. The initial catalog
therefore needs to support an understandable demonstration portfolio without pretending that Atlas
has real blockchain custody, banking integration, token-contract discovery, or production asset
operations.

This decision defines the initial ledger denominations and how their system accounts enter each
environment. It does not define deposit or withdrawal lifecycles, public Financial HTTP behavior,
trading-pair precision, prices, blockchain networks, addresses, or custody-provider integration.

## Decision Drivers

The initial catalog should:

1. be reproducible across local, test, CI, staging, and production-like environments;
2. provide useful base and quote assets for the educational exchange;
3. use explicit, reviewable ledger scales;
4. guarantee the system accounts required by double-entry movements;
5. prevent request-driven or startup-driven creation of financial authority;
6. preserve stable asset identity and historical explainability;
7. remain small enough for one developer to operate;
8. distinguish simulated ledger denominations from real custody support.

# Decision

Atlas will provision a small **committed MVP asset catalog** through an immutable PostgreSQL
migration.

## 1. Initial Asset Catalog

The MVP catalog is:

| Code | Display name | Ledger scale | Initial status | Purpose |
| --- | --- | ---: | --- | --- |
| `BTC` | Bitcoin | 8 | `active` | Primary simulated crypto asset |
| `ETH` | Ethereum | 18 | `active` | Higher-precision simulated crypto asset |
| `USD` | US Dollar | 2 | `active` | Simulated fiat quote and settlement denomination |

These scales define Atlas's internal atomic-unit representation. They do not define market tick
size, order quantity increments, withdrawal fees, blockchain confirmation policy, or UI display
precision. Those concepts require their own decisions.

`USD` is a simulated ledger denomination. Its presence does not claim that Atlas has a bank,
payment-provider, money-transmission, or fiat-custody integration.

## 2. Catalog Authority

Committed migrations are the initial catalog's authoritative provisioning mechanism.

- API startup must not insert, repair, or mutate assets.
- Browser or ordinary user input must never create an asset.
- Environment variables must not silently change asset code, scale, or system-account identity.
- Test suites may create synthetic assets only inside isolated test databases.
- A catalog change requires a new reviewed migration; an applied migration is never edited.

The same committed catalog is used across Atlas environments. Environment-specific availability
may later be represented by an explicit operational policy, but it must not redefine ledger
identity.

## 3. System Accounts

Every catalog asset owns exactly one account of each initial system kind:

- `external_custody` — the counter-account for authorized value entering or leaving Atlas;
- `fee_revenue` — the destination for explicitly charged Atlas fees.

The database enforces uniqueness for `(asset_code, kind)` for system-owned accounts. System
accounts have no wallet owner and are resolved by asset code plus kind; callers do not depend on a
hard-coded UUID.

Provisioning an asset and both required system accounts occurs in the same migration transaction.
An environment must never contain an active catalog asset that is only partially provisioned.

System accounts are Financial implementation details. Other modules and public transports do not
receive their identifiers, query them directly, or construct postings against them.

## 4. Lifecycle and Immutability

Asset codes are permanent identifiers. Catalog assets are not renamed, repurposed, or deleted.
Ledger scale remains governed by ADR-020 and is immutable after use.

If an asset must stop accepting new operations, it is changed to `disabled` through a new migration
or a future controlled administrative capability. Disabling does not remove wallets, journals,
postings, balances, or system accounts, and historical reads remain available.

Removing an asset from a UI or future trading-pair catalog is not equivalent to deleting its
Financial history.

## 5. Scope Boundary

The asset catalog records only the identity required by the Financial ledger:

- stable code;
- display name;
- ledger scale;
- operational status;
- timestamps.

It does not yet store chain identifiers, token contract addresses, deposit addresses, confirmation
thresholds, withdrawal limits, icons, prices, market increments, or provider credentials. Adding
those fields before their owning capability exists would conflate ledger identity with custody,
market, or presentation metadata.

## 6. Implementation Evidence

The provisioning migration and tests must prove:

- all three catalog assets exist with the accepted names, scales, and status;
- each asset owns exactly one external-custody and one fee-revenue account;
- duplicate system accounts are rejected by PostgreSQL;
- system accounts cannot be attached to user wallets;
- migrations remain repeatable and advance schema compatibility;
- catalog and system-account identities retain the immutability rules from ADR-020.

# Alternatives Considered

## Runtime Seeding on API Startup

Rejected because startup side effects obscure schema authority, introduce races across API
instances, complicate readiness, and can silently repair or mutate financial configuration.

## Request-Driven Asset Creation

Rejected because untrusted input must not create ledger denominations or accounting authority.
Asset onboarding is an administrative and operational workflow, not ordinary application input.

## Environment-Specific Catalog Files

Rejected initially because different asset identities or scales across environments make behavior
and migrations less reproducible. A future operational availability layer can vary without
redefining the ledger catalog.

## Provision Only User Accounts

Rejected because deposits, withdrawals, and fees would then require direct balance mutation or
ad-hoc counter-accounts. Every movement must retain an explicit accounting source and destination.

## Begin with a Large Cryptocurrency Catalog

Rejected because each additional asset implies precision, custody, operational, testing, and later
market-policy decisions. Three assets are enough to exercise multiple scales and base/quote use.

# Consequences

## Positive Consequences

- Fresh environments receive the same usable Financial catalog.
- Deposit and withdrawal decisions can refer to explicit custody accounts.
- Fee movements have a defined destination before fees are implemented.
- Multiple precision models are exercised early.
- Runtime startup remains free of hidden financial writes.
- Later catalog changes remain visible in migration history.

## Negative Consequences

- Catalog changes require migrations until a controlled administrative workflow is designed.
- The initial catalog is deliberately small.
- One custody account per asset may become a lock hot spot under future load.
- `USD` remains a simulation and cannot be treated as evidence of real fiat support.

# Deferred Decisions

This ADR does not decide:

1. deposit observation, confirmation, rejection, and crediting;
2. withdrawal request, reservation, approval, fee, broadcast, cancellation, or completion;
3. public asset, wallet, balance, deposit, or withdrawal HTTP contracts;
4. trading pairs, tick sizes, lot sizes, prices, or rounding;
5. blockchain networks, token contracts, addresses, or custody providers;
6. administrative asset onboarding and operational availability controls;
7. reconciliation between simulated or external custody and Atlas journals.

# Reconsider When

Review this decision when Atlas adds real custody integration, needs environment-specific asset
availability, introduces controlled asset administration, requires multiple custody or revenue
accounts per asset, adds chain-specific representations, or measures system-account contention.

# Relationship to Other Decisions

- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-020 — Financial Accounting Foundation](ADR-020-financial-accounting-foundation.md)
- [Atlas Exchange Phase Delivery](../../engineering/phase-delivery.md)
- [Atlas Testing Strategy](../../engineering/testing-strategy.md)
