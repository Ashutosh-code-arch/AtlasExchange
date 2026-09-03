# Authenticated Interface Release Acceptance

**Classification:** Canonical

**Status:** Active

**Last reviewed:** 2026-09-03

This checklist implements
[ADR-081](../architecture/decisions/ADR-081-authenticated-interface-release-acceptance.md). It is the
handoff between completing the routed brokerage interface and preparing a new immutable Atlas
release. It does not authorize a live deployment.

## Product route inventory

| Route | User task | Release evidence |
| --- | --- | --- |
| `/app/dashboard` | Review account state and open a primary task | Component tests and identity E2E |
| `/app/trade/:market` | Inspect reference data and place simulated orders | Trading tests and trading E2E |
| `/app/orders` | Review orders, executions, and cancellation state | Trading tests and trading E2E |
| `/app/portfolio` | Review exact holdings and transparent valuation | Portfolio tests and identity/trading E2E |
| `/app/funds` | Open wallets and move simulated value | Financial tests and all local E2E journeys |
| `/app/profile` | Review identity and control sessions | Authentication tests and identity E2E |
| `/app/admin` | Perform exact-target restricted operations | Administration tests and identity E2E |

Administration remains absent for non-admin users. Profile remains reachable from the top bar rather
than the five-item mobile navigation because it is an account/security task, not a primary trading
destination.

## Local acceptance sequence

Start Docker Desktop before the database-backed lanes. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm build
pnpm test:e2e
```

The run is accepted only when all commands pass for the same source revision. Do not convert a
missing Docker daemon, unavailable PostgreSQL, failed image pull, or absent browser into a skipped
success.

The browser lane must prove:

- registration, verification, login, and server-confirmed session continuity;
- routed Funds and Portfolio operations;
- exact-target Administration changes and audit evidence;
- Profile session inventory;
- narrow-screen mobile navigation and absence of horizontal overflow;
- two-user simulated matching, settlement, order history, and portfolio valuation; and
- notification creation, read acknowledgement, and persistence.

## Visual review

Before release publication, review the built interface at wide desktop and `390 × 844` mobile sizes.
Check:

- active navigation and page title match the URL;
- no page-level horizontal overflow exists;
- fixed mobile navigation does not prevent reaching the last control;
- tables retain labels or bounded panel scrolling;
- destructive actions retain text labels and confirmation states;
- focus remains visible; and
- Coinbase reference data, Atlas simulation, and server-confirmed account state remain distinct.

Visual review supplements automated assertions; it cannot replace them.

## Current handoff state

The routed interface source and route-aware E2E definitions are complete. A new release is not yet
published or deployed. The live zero-cost demo remains `v0.2.1` until all unchecked gates below are
completed for a new candidate:

- [x] Run `pnpm verify` with local PostgreSQL available (passed 2026-09-03).
- [x] Run `pnpm build` for contracts, API, web, and gateway (passed 2026-09-03).
- [x] Run `pnpm test:e2e` with disposable Docker services (three journeys passed 2026-09-03).
- [ ] Record the final source revision after all acceptance changes are committed.
- [ ] Select and commit the next stable semantic version.
- [ ] Push the reviewed source and annotated release tag.
- [ ] Verify the GitHub quality and release workflows.
- [ ] Record the immutable API image digest and Worker revision.
- [ ] Obtain explicit authorization for Render/Cloudflare/Neon promotion.
- [ ] Execute the zero-cost demo runbook and sanitized live smoke checks.

Do not mark an item complete based on a previous candidate. Do not put credentials, invited identity
details, cookies, provider secrets, or private browser artifacts in this document or Git.

## Promotion boundary

Once the first three local gates pass, continue with the canonical
[release runbook](release-and-deployment.md). For the hosted environment, continue with the
[zero-cost demo runbook](free-demo-hosting.md). Paid staging and production-readiness documents do
not authorize changes to the current free demo.
