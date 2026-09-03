# ADR-081 — Authenticated Interface Release Acceptance

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-03

**Last reviewed:** 2026-09-03

**Canonical owner/source:** ADR-081

## Context

ADRs 077–080 replaced Atlas's single-page capability presentation with an authenticated brokerage
shell and distinct Dashboard, Trade, Orders, Portfolio, Funds, Profile, and Administration routes.
The component suites and manual browser review cover each workspace, but the repository-level
browser journeys still targeted the superseded single-page headings and composition.

A polished interface is not release evidence by itself. Atlas needs one explicit acceptance
boundary that joins route navigation, real-stack behavior, responsive shell behavior, production
builds, and deployment separation without claiming that repository completion changed the live
zero-cost demo.

## Decision Drivers

Interface release acceptance should:

1. exercise the real routed product rather than obsolete single-page selectors;
2. retain real PostgreSQL, API, web, Mailpit, and Chromium boundaries for critical journeys;
3. prove both desktop and narrow-screen navigation;
4. avoid duplicating every component assertion in E2E;
5. detect page-level horizontal overflow at the mobile breakpoint;
6. keep rich local failure artifacts out of Git;
7. require a production build independently of browser success; and
8. distinguish source acceptance, release publication, and live demo promotion.

## Decision

Atlas will treat the authenticated interface as a release candidate only when the route-aware local
browser lane, ordinary repository quality gates, and production build pass for the same source.

The accepted browser route matrix is:

| Journey | Required routed surfaces |
| --- | --- |
| Identity and account operations | Public access, Dashboard, Funds, Portfolio, Admin, Profile |
| Trading and settlement | Public access, Dashboard, Funds, Trade, Portfolio, Orders, Profile |
| Durable notifications | Public access, Dashboard, Funds, notification dialog |
| Responsive shell | Profile and one primary destination through Mobile navigation |

## 1. Route-aware E2E

Local E2E continues to use the isolated infrastructure owned by `pnpm test:e2e`: disposable
PostgreSQL and Mailpit containers, committed migrations, production web assets, an Atlas API
process, and Chromium.

Journeys must navigate through visible product links and verify the destination URL and primary
workspace heading. Tests may not reach a workspace by relying on the old overview composition.

Focused unit, component, HTTP, and integration tests remain responsible for exhaustive errors,
validation, exact arithmetic, and state transitions. E2E proves a small number of critical
cross-application paths.

## 2. Responsive Acceptance

The identity journey will switch the authenticated page to a `390 × 844` viewport after validating
Profile and active sessions. It must prove:

- the desktop sidebar is hidden;
- Mobile navigation is visible with the five primary destinations;
- a primary destination can be opened through that navigation;
- the routed heading is visible; and
- document width does not exceed the viewport width.

Component tests and browser visual review continue to cover detailed reflow. Atlas will not run the
entire stateful E2E suite once per device because that would duplicate durable mutations, lengthen
the solo-developer feedback loop, and add little boundary coverage.

## 3. Release Acceptance Commands

The interface candidate requires:

```bash
pnpm verify
pnpm build
pnpm test:e2e
```

`pnpm verify` remains the non-E2E quality contract and requires local PostgreSQL for API integration
tests. `pnpm test:e2e` remains separate because it owns Docker services and a browser.

Browser screenshots and traces are diagnostic artifacts generated only on failure. They remain
untracked and must be reviewed for sensitive test data before external sharing.

## 4. Release and Deployment Separation

Passing this boundary means the source is eligible for release preparation. It does not:

- change the package version;
- create or push a Git tag;
- publish a GitHub Release or container image;
- migrate Neon;
- update Render or Cloudflare;
- alter the invited demo identity; or
- claim production readiness.

The currently deployed `v0.2.1` remains authoritative until a separately approved release and
zero-cost demo promotion completes. Live promotion must follow the release and demo runbooks with
immutable candidate identity and explicit user authorization.

## Alternatives Considered

### Keep manual responsive inspection only

Rejected because the product shell now has separate desktop and mobile navigation. A breakpoint
regression can make every feature unreachable even when component tests pass.

### Run every E2E journey in desktop and mobile projects

Rejected because the current journeys create identities and mutate disposable financial and
trading state. Repeating all journeys would increase runtime and fixture complexity without
materially improving responsive-shell evidence.

### Test routes by calling `page.goto` directly

Rejected as the primary approach because it would not prove visible navigation, client-side route
state, active-link behavior, or mobile reachability.

### Deploy automatically after a green local run

Rejected because local acceptance does not create immutable release artifacts, provider evidence,
rollback identity, or authorization for external changes.

## Consequences

### Positive

- Real-browser journeys now match the shipped route architecture.
- Desktop and mobile reachability have an automated cross-application check.
- Critical identity, financial, trading, notification, and administration paths remain covered.
- Release completion cannot be confused with changing the live demo.

### Negative

- Full local acceptance requires Docker and Chromium.
- One responsive journey cannot detect every visual defect.
- Route-label changes now require deliberate E2E maintenance.

## Reconsider When

Review this decision when Atlas introduces multiple authenticated shells, installable/mobile apps,
device-specific trading behavior, visual-regression infrastructure, parallel isolated E2E
databases, or a continuous preview environment per source revision.

## Related Decisions

- [ADR-016 — Continuous Integration and Quality Gate Strategy](ADR-016-continuous-integration-and-quality-gate-strategy.md)
- [ADR-071 — Staging Smoke Execution and Sanitized Evidence](ADR-071-staging-smoke-execution-and-sanitized-evidence.md)
- [ADR-075 — Zero-Cost Private Demo Hosting and Reference Market Data](ADR-075-zero-cost-private-demo-hosting-and-reference-market-data.md)
- [ADR-077 — Authenticated Product Shell, Routing, and Interface Density](ADR-077-authenticated-product-shell-routing-and-interface-density.md)
- [ADR-078 — Trading Workstation Information Architecture](ADR-078-trading-workstation-information-architecture.md)
- [ADR-079 — Account Activity, Portfolio, and Funds Information Architecture](ADR-079-account-activity-portfolio-and-funds-information-architecture.md)
- [ADR-080 — Profile, Session Security, and Administration Information Architecture](ADR-080-profile-session-security-and-administration-information-architecture.md)
