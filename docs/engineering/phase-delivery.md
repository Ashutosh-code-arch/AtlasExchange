# Atlas Exchange Phase Delivery

**Status:** Active  
**Last reviewed:** 2026-08-19

This document translates the canonical product and sprint documents into small, demonstrable
delivery increments. A phase is complete only after its acceptance checks pass.

| Phase                     | Outcome                                                          | Status      |
| ------------------------- | ---------------------------------------------------------------- | ----------- |
| 1. Engineering foundation | Reproducible monorepo, web/API shells, PostgreSQL, quality gates | In Progress |
| 2. Identity               | Registration, login, refresh-token rotation, RBAC, profiles      | Planned     |
| 3. Financial foundation   | Assets, wallets, double-entry ledger, deposits, withdrawals      | Planned     |
| 4. Trading                | Orders, reservation, matching, trades, atomic settlement         | Planned     |
| 5. Market data            | Order-book views, tickers, candles, WebSocket streams            | Planned     |
| 6. Product surfaces       | Portfolio, notifications, administration                         | Planned     |
| 7. Production readiness   | Security hardening, metrics, rate limits, performance            | Planned     |
| 8. Deployment             | Deployment, runbooks, monitoring, interview evidence             | Planned     |

## Phase 1 acceptance criteria

- A clean install is reproducible from one root lockfile.
- Each workspace can type-check, test, and build independently.
- `GET /health/live` proves only process liveness.
- `GET /health/ready` reports `503` until lifecycle and PostgreSQL checks pass.
- Configuration is validated once at the application boundary and secrets are not logged.
- PostgreSQL starts from an explicitly versioned Compose service and migrations are repeatable.
- `pnpm verify` and `pnpm build` provide the local/CI quality contract.

## Phase transition rule

Do not begin a later phase merely because folders can be scaffolded. Begin it when the preceding
phase passes its automated checks and its business rules, API contract, data design, and acceptance
criteria have been reviewed.
