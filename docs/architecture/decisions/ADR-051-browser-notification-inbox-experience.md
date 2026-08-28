# ADR-051 — Browser Notification Inbox Experience

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-051

## Context

ADR-050 exposes authenticated list and mark-read HTTP contracts for the durable Notification inbox.
Atlas now needs a browser surface that feels native to an exchange workspace while preserving exact
server-owned data, authenticated lifecycle isolation, and truthful failure states.

The initial shell contains long Portfolio, Trading, Financial, and operational surfaces. A full
in-page Notification section would force users away from current work, while browser-only toasts
would lose history and confuse delivery with durable state. The experience must remain useful on
desktop and narrow screens without inventing realtime behavior that the API does not provide.

## Decision Drivers

The browser experience should:

1. expose unread activity without displacing the current Trading workflow;
2. load private data only after server-confirmed authentication;
3. preserve exact amount and count strings without binary-number conversion;
4. distinguish initial failure, stale retained data, pagination failure, and mutation failure;
5. acknowledge a fact only after the server confirms its immutable receipt;
6. preserve cursor order and avoid duplicates when pages overlap;
7. reset private state when the authenticated user changes or signs out;
8. remain keyboard and screen-reader operable; and
9. avoid claiming realtime delivery before a realtime contract exists.

# Decision

Atlas will add an authenticated Notification Center to the overview header. It consists of a bell
trigger, exact unread badge, and responsive activity-inbox panel.

## 1. Authenticated lifecycle

The Notification Center renders and loads only while the shared authentication session state is
`authenticated`. Checking, unavailable, and anonymous states expose no trigger and perform no inbox
request.

The authenticated component is keyed by user ID. A user transition unmounts the prior instance and
clears its items, cursors, unread count, errors, pending marks, and open state before the next owner
loads. The browser never persists Notification data in local storage, session storage, IndexedDB,
or a service-worker cache.

## 2. Header trigger and badge

The overview header shows a keyboard-operable bell button. Its accessible name is `Notifications`
when the exact unread count is zero and `Notifications, N unread` otherwise.

The visible badge uses the server's exact canonical integer string. Counts through 99 are displayed
directly; larger counts display `99+` visually while the accessible name retains the full exact
value. Count comparisons and decrements use `BigInt`, never `number` or floating point.

The trigger uses `aria-expanded` and `aria-controls`. The panel is a labelled non-modal dialog,
provides an explicit close control, and closes on Escape.

## 3. Inbox presentation

Each item presents:

- a kind-specific title;
- the exact canonical amount and asset code;
- source occurrence time in the user's locale;
- unread or read visual state; and
- either a mark-read action or the authoritative first-read time.

The initial supported copy is:

| Kind | Title | Meaning |
|---|---|---|
| `financial.deposit_credited` | Deposit credited | Exact amount is available |
| `financial.withdrawal_completed` | Withdrawal completed | Exact amount left the simulated balance |

The browser does not display the owner ID, source UUID, schema version, internal status, persistence
details, request ID, or transaction internals. Notifications are activity facts, not executable
quotes, balances, custody confirmations, or profit/loss.

Desktop uses a header-anchored panel. At narrow widths it becomes a full-width panel below the fixed
header boundary, with the same content order and controls rather than a separate mobile feature.

## 4. Loading, refresh, and stale data

One first page loads automatically after authentication so the header badge is meaningful. Atlas
does not poll in this increment. Users explicitly refresh the panel, and product actions do not
silently fabricate or inject Notification items.

A successful refresh replaces the list, unread count, and cursor from the first page. If refresh
fails after a valid page exists, Atlas retains that last valid page and labels it visibly stale. If
the first load fails, the panel shows a bounded unavailable or rate-limited state with a retry
control and no invented empty state.

The UI never exposes server messages, validation diagnostics, limiter keys, request IDs, or
transport exception details.

## 5. Pagination

`Load more` requests the opaque `nextCursor` and appends the returned page. Items are deduplicated by
notification ID while retaining server order. The latest response supplies the exact unread count
and next cursor. Pagination failure preserves every previously validated item and provides bounded
retry guidance.

No infinite scroll is used. Explicit pagination avoids surprising database work, preserves keyboard
position, and makes the end-of-activity state visible.

## 6. Mark-read interaction

Unread items expose an item-specific `Mark read` button. While its request is in flight, only that
item's action is disabled and labelled as saving.

The browser changes an item's read state only after the strict server receipt is validated and its
notification ID matches the requested resource. It uses the server's `readAt` and decrements the
exact unread count once only when the item was previously unread. A failed request keeps the item
unread and shows safe, actionable guidance.

The browser does not mark items read merely because the panel opens, a page loads, or an item enters
the viewport. It does not provide mark-unread, mark-all-read, deletion, preferences, or toast
dismissal in this increment.

## 7. Test boundary

Strict API-client tests reject malformed pages and mismatched receipts. Component tests cover
authenticated loading, exact large badges, successful acknowledgement, pagination deduplication,
stale retention, safe failures, and anonymous non-loading.

An isolated real-stack browser journey creates and verifies an account, commits a simulated deposit,
explicitly refreshes the inbox, observes its durable fact, marks it read through CSRF-protected HTTP,
and proves that the original read receipt survives reload.

## Alternatives Considered

### Dedicated Notification page only

Rejected for the initial exchange shell because unread activity should remain visible while working
in Portfolio or Trading. A future full activity page may complement the panel when history grows.

### Browser toast only

Rejected because toasts are ephemeral, miss facts created while disconnected, and cannot represent
durable read state.

### Poll continuously

Rejected until request frequency, visibility behavior, backoff, multi-tab coordination, and server
cost are measured and accepted. Explicit refresh is truthful and sufficient for this increment.

### Mark every visible item read automatically

Rejected because rendering is not an intentional acknowledgement and background refresh could erase
unread state without user action.

### Optimistically mark read before the response

Rejected because failure would temporarily present false durable state and require rollback across
badge and item views.

### Convert counts and amounts to JavaScript numbers

Rejected because it can lose exactness and silently change authoritative financial text.

### Store the inbox in browser persistence

Rejected because private cross-session data would require encryption, invalidation, owner partition,
and logout cleanup that provide no current product benefit.

## Consequences

### Positive Consequences

- Durable activity is visible from the exchange header without interrupting Trading work.
- Exact badges and financial strings preserve server authority.
- Authentication changes cannot retain the prior owner's inbox in the component tree.
- Refresh and mutation failures never erase the last trusted state or claim false acknowledgement.
- Cursor pagination is explicit, ordered, and deduplicated.
- Desktop and narrow layouts share one accessible behavior model.
- A real browser journey proves capture, delivery, acknowledgement, and reload persistence together.

### Negative Consequences

- New notifications do not appear until initial load or explicit refresh.
- The header bundle grows because the Notification Center is part of the overview shell.
- Locale-formatted times can differ between users and do not provide relative-time updates.
- Only one item can be acknowledged per action.
- The panel is not yet a complete searchable activity history.

## Reconsider When

Review this decision when measured usage justifies polling or authenticated realtime delivery,
notification history needs search or filtering, bulk acknowledgement becomes a product requirement,
additional kinds require richer destination links, or browser persistence gains a clear offline use
case and reviewed privacy model.

## Related Decisions

- [ADR-043 — Browser Market Data Streaming and Recovery](ADR-043-browser-market-data-streaming-and-recovery.md)
- [ADR-046 — Browser Portfolio Snapshot Experience](ADR-046-browser-portfolio-snapshot-experience.md)
- [ADR-049 — Private Notification Inbox Read Model](ADR-049-private-notification-inbox-read-model.md)
- [ADR-050 — Authenticated Notification HTTP Contract](ADR-050-authenticated-notification-http-contract.md)
