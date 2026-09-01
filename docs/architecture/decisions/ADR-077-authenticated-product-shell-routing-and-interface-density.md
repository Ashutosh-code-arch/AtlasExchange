# ADR-077 — Authenticated Product Shell, Routing, and Interface Density

**Classification:** Canonical

**Status:** Accepted

**Date:** 2026-09-01

**Last reviewed:** 2026-09-01

**Canonical owner/source:** ADR-077

## Context

Atlas has complete browser surfaces for identity, portfolio, trading, funds, notifications, and
administration. They are currently composed as one long page below a delivery-oriented hero,
system-status card, and engineering roadmap. Anchor navigation makes completed capabilities look
like sections of a project showcase rather than destinations in a trading application.

ADR-055 established the correct light visual direction, but intentionally deferred route redesign.
The current interface also uses 8–10 pixel labels in information-dense areas. Those sizes weaken
legibility and hierarchy during sustained use.

Atlas now needs a stable application frame that feels familiar to users of modern brokerage
products without copying another product's brand, wording, or exact layout.

## Decision Drivers

The product interface should:

1. present product capabilities rather than the engineering delivery process;
2. give every primary task a stable, shareable URL;
3. preserve the requested destination through authentication;
4. keep simulation and connection state visible without dominating the workspace;
5. support dense trading information at readable sizes;
6. keep navigation usable from mobile through wide desktop screens;
7. reuse the completed feature behavior and server-authoritative contracts;
8. avoid adding a routing or component dependency before its value is demonstrated; and
9. preserve administrator navigation as an authorization-dependent capability.

## Decision

Atlas will use an **authenticated multi-page product shell** with a light neutral visual system.

The initial routes are:

```text
/login
/app/dashboard
/app/trade/:marketCode
/app/orders
/app/portfolio
/app/funds
/app/profile
/app/admin        administrator only
```

`/verify-email` and `/reset-password` remain public identity routes. `/` resolves to the dashboard.
Unknown application paths fail safely to the dashboard during this initial client-routing slice.

Atlas will initially use a small application-owned History API router. The route set is static,
there are no nested data loaders, and the current requirement does not justify a routing library.
Navigation uses real links, `pushState`, and `popstate`, so URLs remain shareable and browser
back/forward navigation works. Reconsider a dedicated router when nested layouts, route-level data
loading, complex search parameters, or guarded workflows make the local implementation costly.

## 1. Shell and navigation

Authenticated pages share:

- a persistent left navigation rail on desktop;
- a compact top bar containing page context, connection state, notifications, and profile access;
- a bottom navigation bar for primary destinations on narrow screens; and
- one scrollable content region for the active route.

Primary navigation contains Dashboard, Trade, Orders, Portfolio, Funds, and Profile.
Administration appears only when the server-confirmed session includes the `admin` role.

The authenticated product removes the marketing hero, repository link, delivery roadmap, phase
status, architecture copy, and engineering footer. Those remain available in canonical
documentation rather than occupying trading workspace attention.

## 2. Page ownership

Route pages remain thin composition boundaries in accordance with ADR-009:

```text
application shell
  ↓
route page
  ↓
feature public interface
```

Dashboard composes a concise welcome, task shortcuts, connection state, and a real portfolio
snapshot. Trade owns market selection, reference chart, order book, and order entry. Orders owns
private order and execution history. Portfolio, Funds, Profile, and Administration compose their
existing feature surfaces.

This decision changes presentation and composition only. Backend authority, exact decimal
handling, authentication, CSRF, orders, balances, and market-data recovery remain unchanged.

## 3. Visual tokens

The accepted light direction is refined to the following semantic baseline:

| Purpose | Token |
|---|---|
| Application canvas | `#f4f6f8` |
| Primary surface | `#ffffff` |
| Primary text | `#172033` |
| Secondary text | `#667085` |
| Divider | `#dfe4eb` |
| Selected navigation | `#e9effc` |
| Primary action/focus | `#2457d6` |
| Buy/positive | `#13765b` |
| Sell/negative | `#b9384f` |
| Warning | `#9a5b0a` |

Colour communicates action or state and is never the only state signal. Black canvases,
fluorescent accents, ornamental gradients, and glow effects are prohibited in the product shell.

## 4. Typography and density

Atlas uses an Inter-first system UI stack without a runtime third-party font request:

```text
Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

If Inter is not installed, the operating-system interface font is used. Exact prices, quantities,
balances, identifiers, and timestamps use tabular numerals through `font-variant-numeric` rather
than a second externally loaded font.

The initial type scale is:

| Use | Size |
|---|---|
| Page title | 20–22px |
| Major financial value | 24–32px |
| Section title | 18–22px |
| Body and form control | 14px |
| Navigation and tables | 13px |
| Labels and metadata | 12px minimum |
| Mobile form controls | 16px minimum |

No meaningful product text may render below 12px. Compactness comes from spacing, alignment, and
progressive disclosure rather than unreadably small type.

## 5. Responsive behavior

Desktop prioritizes simultaneous context and keeps a 216px navigation rail. Tablet collapses the
rail while retaining the top bar. Mobile uses a five-destination bottom bar, moves secondary
destinations to profile, and preserves at least 44px interactive targets. Trading content stacks in
task order instead of shrinking the desktop grid.

## Alternatives Considered

### Keep the single-page product showcase

Rejected because capability ownership, browser navigation, and task focus remain unclear.

### Copy Zerodha Kite exactly

Rejected. Familiar brokerage information architecture is useful, but Atlas needs its own visual
identity and cannot inherit another product's trade dress or interaction assumptions.

### Add a routing library now

Deferred because the current route graph is small and static. A library becomes appropriate when
it removes demonstrated application complexity rather than merely replacing a small route table.

### Retain very small labels to maximize density

Rejected because information that is technically present but difficult to read is not useful
density.

## Consequences

### Positive

- Atlas reads as a trading application rather than an engineering roadmap.
- Primary capabilities have stable URLs and clear navigation ownership.
- Existing feature behavior is reused without backend or persistence changes.
- The minimum type floor improves sustained-use legibility.
- Responsive navigation supports both workstation and mobile use.

### Negative

- The application-owned router must remain deliberately small.
- Existing feature surfaces require incremental density and layout refinement inside the new shell.
- Orders initially reuses the trading feature controller until its presentation is further split.
- Inter is not guaranteed unless Atlas later self-hosts the font files.

## Reconsider When

Review this decision when route-level loaders, nested layouts, search/filter URL state, multiple
authenticated shells, user-selectable density, a dark theme, or shared design primitives justify
new infrastructure.

## Related Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-017 — Identity and Session Security Strategy](ADR-017-identity-and-session-security-strategy.md)
- [ADR-043 — Browser Market Data Streaming and Recovery](ADR-043-browser-market-data-streaming-and-recovery.md)
- [ADR-055 — Light Product Interface and Visual System](ADR-055-light-product-interface-and-visual-system.md)
- [ADR-075 — Zero-Cost Private Demo Hosting and Reference Market Data](ADR-075-zero-cost-private-demo-hosting-and-reference-market-data.md)
