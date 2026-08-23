# Atlas Exchange Phase Delivery

**Status:** Active  
**Last reviewed:** 2026-08-24

This document translates the canonical product and sprint documents into small, demonstrable
delivery increments. A phase is complete only after its acceptance checks pass.

| Phase                     | Outcome                                                          | Status      |
| ------------------------- | ---------------------------------------------------------------- | ----------- |
| 1. Engineering foundation | Reproducible monorepo, web/API shells, PostgreSQL, quality gates | Implemented |
| 2. Identity               | Registration, login, session rotation, roles, account profile    | Implemented |
| 3. Financial foundation   | Assets, wallets, double-entry ledger, deposits, withdrawals      | Active      |
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

## Phase 2 acceptance criteria

- Registration, email verification, login, logout, session listing/revocation, refresh rotation,
  and password recovery are exposed through the accepted Identity HTTP contract.
- Enumeration-resistant responses, account-state checks, compromised-password checks, exact-origin
  validation, CSRF protection, and guarded cookie policies enforce the accepted security boundaries.
- Opaque access and rotating refresh credentials are persisted server-side; replay revokes the
  affected session family.
- The current-user contract exposes the authenticated account profile and assigned roles without
  leaking persistence representations.
- Identity unit and real-PostgreSQL integration tests cover lifecycle, rollback, replay, expiry, and
  security-sensitive failure behavior.
- The isolated browser journey proves registration, captured-email verification, and authenticated
  session bootstrap through the real web, API, PostgreSQL, and Mailpit stack.

## Phase 3 entry criteria

- [ADR-020 — Financial Accounting Foundation](../architecture/decisions/ADR-020-financial-accounting-foundation.md)
  defines asset quantities, wallets, ledger accounts, journal authority, idempotency, and concurrency.
- Deposit, withdrawal, and public Financial API behavior remain gated by focused follow-up decisions.
- The first implementation increment is the independently testable asset-quantity and accounting
  domain core; persistence follows only with its invariant-preserving migration and integration tests.

## Phase transition rule

Do not begin a later phase merely because folders can be scaffolded. Begin it when the preceding
phase passes its automated checks and its business rules, API contract, data design, and acceptance
criteria have been reviewed.
