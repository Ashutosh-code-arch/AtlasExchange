# ADR-055 — Light Product Interface and Visual System

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-30  
**Last reviewed:** 2026-08-30  
**Canonical owner/source:** ADR-055

## Context

Atlas completed its first six delivery phases with a dark, high-contrast engineering aesthetic.
That presentation made architectural progress visible, but its black canvas, fluorescent accent,
decorative grid, and large technical hero do not match the calm, information-dense environment
expected from a credible trading product.

Before production-readiness work begins, Atlas needs a stable visual foundation that supports the
existing Portfolio, Trading, Financial, Notification, Identity, and Administration workflows. The
interface should feel familiar to users of professional brokerage products without copying another
company's trade dress or hiding Atlas's own security and precision principles.

## Decision Drivers

The visual system should:

1. prioritize legibility, hierarchy, and sustained use over visual spectacle;
2. use a light neutral canvas with clear white work surfaces;
3. reserve colour for actions, state, financial direction, and recovery guidance;
4. retain high information density without making controls feel cramped;
5. keep exact values and operational state visually prominent;
6. work from narrow mobile screens through wide trading workstations;
7. preserve semantic HTML, keyboard access, reduced motion, and visible focus;
8. apply consistently to every existing product workspace; and
9. avoid introducing a component framework only for visual restyling.

# Decision

Atlas will use a **light-first, neutral professional product interface**. The primary visual tokens
are:

| Purpose | Direction |
|---|---|
| Application canvas | Soft cool grey |
| Primary surfaces | White |
| Primary text | Dark blue-charcoal |
| Secondary text | Muted slate |
| Borders | Quiet cool grey |
| Primary action and focus | Restrained Atlas blue |
| Positive and buy states | Muted accessible green |
| Negative and sell states | Muted accessible red |
| Warning and incomplete states | Amber-brown |

Black page backgrounds, fluorescent accents, glow effects, decorative grids, outlined display type,
and colour used only as decoration are removed.

## 1. Product shell

The application uses a bounded wide workspace on a soft-grey canvas. A translucent white sticky
header retains product identity and the primary destinations without consuming terminal space.
The Atlas mark becomes a simple blue rounded square rather than a rotated fluorescent symbol.

The authenticated Identity surface and each major capability appear as separate white work panels
with quiet borders, modest corner radii, and restrained elevation. The overview precedes the
capability workspaces so navigation and system context appear in reading order.

## 2. Information hierarchy

Manrope remains the primary interface face. DM Mono is limited to exact values, identifiers, compact
metadata, and operational labels. Headings use solid dark text; blue identifies product emphasis and
primary actions rather than acting as a decorative glow.

The former architecture orbit is replaced by a compact product-workspace preview describing the
four active capability groups without inventing prices or market performance. Exact balances,
order-book values, ticker values, and operational state remain more prominent than explanatory copy.

## 3. Work surfaces and controls

Portfolio, Trading, Financial, and Administration retain their established component structure and
business semantics. The redesign changes presentation, not source authority or workflows.

Inputs, buttons, status pills, grouped tables, terminal panels, and notification surfaces share one
border, radius, spacing, focus, and elevation vocabulary. Primary actions use Atlas blue. Buy and
positive state use green; sell, destructive actions, and failure use red; incomplete or cautionary
state uses amber. Colour always accompanies text or another state indicator.

## 4. Responsive behavior

Wide screens preserve dense multi-column trading and summary layouts. Tablet layouts stack major
terminal regions without changing their order. Mobile layouts reduce panel padding, retain touch-
sized controls, convert wide data tables to existing labelled cards where defined, simplify header
navigation, and keep notification content viewport-bound.

The mobile presentation is not a scaled desktop terminal. It prioritizes one task at a time while
preserving the same server-confirmed information and action labels.

## 5. Accessibility and motion

Interactive elements receive a visible blue focus ring. Text and semantic state colours are chosen
for readable contrast on white or light-grey surfaces. Existing labels, headings, regions, alerts,
status messages, keyboard behavior, and reduced-motion rules remain authoritative.

Hover feedback is subtle and never required to understand state. No information depends on colour
alone.

## 6. Scope

This slice does not introduce a dark theme, theme switcher, user-customizable density, charting
library, icon library, design-system package, new business capability, route redesign, or external
brand assets. A future dark theme must derive from semantic tokens and meet the same accessibility
and state requirements; it must not restore the previous fluorescent treatment.

## Alternatives Considered

### Retain the dark fluorescent interface

Rejected because it overemphasized visual identity at the expense of long-session readability,
calm operational state, and product credibility.

### Copy an existing brokerage terminal

Rejected because familiar information architecture is useful, but copying another product's exact
layout, colour, language, or trade dress would prevent Atlas from developing a coherent identity.

### Introduce a component framework during the redesign

Rejected because the existing semantic components are complete and tested. Replacing them would
increase bundle, migration, and regression cost without improving the current business boundaries.

### Ship light and dark themes together

Rejected because one polished, accessible baseline is more valuable than two partially governed
themes before production readiness.

## Consequences

### Positive Consequences

- Atlas now presents as a calm, credible trading product rather than a technical showcase.
- Existing capabilities share one consistent visual hierarchy and control language.
- Exact market and financial information remains dense and readable.
- Responsive behavior and keyboard focus are clearer.
- Semantic tokens leave a disciplined path to a future optional dark theme.

### Negative Consequences

- The stylesheet still contains feature-level rules in one application-owned file.
- Dark mode is unavailable.
- Some engineering-roadmap content remains visible in the product overview.
- Future visual additions must follow the accepted tokens rather than introducing local colours.

## Reconsider When

Review this decision when Atlas needs a separate reusable component package, user-selectable theme
or density, a dedicated mobile shell, multiple branded products, validated professional-user
research, or a charting system with additional visual tokens.

## Related Decisions

- [ADR-009 — Frontend Application Architecture](ADR-009-frontend-application-architecture.md)
- [ADR-041 — Candlestick Chart and Polling Delivery](ADR-041-candlestick-chart-and-polling-delivery.md)
- [ADR-046 — Browser Portfolio Snapshot Experience](ADR-046-browser-portfolio-snapshot-experience.md)
- [ADR-051 — Browser Notification Inbox Experience](ADR-051-browser-notification-inbox-experience.md)
- [ADR-054 — Browser Administration Console](ADR-054-browser-administration-console.md)
