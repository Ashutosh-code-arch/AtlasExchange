# ADR-049 — Private Notification Inbox Read Model

**Classification:** Canonical  
**Status:** Accepted  
**Date:** 2026-08-29  
**Last reviewed:** 2026-08-29  
**Canonical owner/source:** ADR-049

## Context

ADR-047 provisions an owner-scoped durable inbox and immutable read receipts. ADR-048 captures new
completed simulated deposits and withdrawals atomically, but Atlas has no application capability for
an owner to read those facts or acknowledge them as read.

The read boundary must remain private, scale beyond an initial page, report useful unread state, and
avoid turning a read acknowledgement into mutable notification content. Its contracts must be
usable by a later authenticated HTTP adapter without coupling the application layer to Express.

## Decision Drivers

The capability should:

1. never expose one owner's facts or existence to another owner;
2. paginate deterministically when occurrence timestamps are equal;
3. avoid offset drift as newer notifications are captured;
4. preserve exact unread state without JavaScript integer coercion;
5. make read acknowledgement monotonic and safe to retry;
6. keep page items and their unread count internally coherent;
7. expose no framework, cookie, session, or transport concerns; and
8. use the existing schema and owner timeline index without speculative persistence.

# Decision

Notifications will expose application capabilities for listing an owner's private inbox and marking
one owned notification read.

## 1. Owner-scoped list contract

The list input contains an owner ID, optional cursor, and optional limit. The application output is:

~~~text
notifications[]
  id
  kind
  sourceId
  payload
  occurredAt
  createdAt
  readAt | null
unreadCount
nextCursor | null
~~~

The owner ID is required for authorization scope but is omitted from every returned item. Repository
queries apply the owner predicate before ordering, pagination, or read-state joining. An empty inbox
is a successful result with an empty collection, unread count `"0"`, and no cursor.

`unreadCount` is an exact non-negative decimal integer string. PostgreSQL `COUNT` is not narrowed to
a JavaScript `number`.

## 2. Stable newest-first pagination

Items are ordered by:

~~~text
occurred_at DESC, id DESC
~~~

The opaque cursor contains a versioned representation of the last returned `(occurredAt, id)` tuple.
The next page applies an exclusive tuple boundary:

~~~text
occurred_at < cursor.occurredAt
OR (occurred_at = cursor.occurredAt AND id < cursor.id)
~~~

This prevents duplicate boundary items, resolves equal timestamps deterministically, and avoids the
shifting behavior of offset pagination when newer facts arrive. A cursor is syntax and integrity
checked before persistence is called. It contains no owner identifier or credential; the database
owner predicate remains authoritative.

The default page size is 20 and the maximum is 50. The application requests one additional record
to determine whether a continuation cursor is necessary.

## 3. Coherent page and unread count

The PostgreSQL reader obtains the page and exact owner unread count inside one read-only,
repeatable-read transaction. Both values therefore describe one database snapshot even when capture
or acknowledgement occurs concurrently.

Unread means that no row exists in `notifications.read_receipts` for the inbox item. Read state is
not inferred from browser state, page access, or delivery time.

## 4. Monotonic owner-scoped acknowledgement

Mark-read inserts a receipt only by selecting a notification ID belonging to the supplied owner. Its
result is one of:

- `created`, with the first read timestamp;
- `existing`, with that same original timestamp; or
- `not_found` for both an absent notification and another owner's notification.

Retries never update `read_at`. The API does not distinguish absent from forbidden resources, so a
future HTTP adapter cannot use this capability to enumerate another owner's notifications.

Atlas does not add mark-unread, mark-all-read, notification deletion, retention, or mutable content
in this increment.

## 5. Boundary and composition

The application contracts contain plain TypeScript values and typed validation errors. PostgreSQL
adapters own joins, tuple predicates, exact counts, and receipt insertion. No Express request,
response, session, cookie, or status-code concept enters this capability.

The HTTP contract, authenticated router composition, rate limiting, and browser presentation remain
separate delivery decisions. This increment requires no migration because migration 0014 already
contains the inbox, owner timeline index, and immutable receipt table.

## Alternatives Considered

### Offset pagination

Rejected because inserting newer notifications shifts offsets and can cause duplicates or omissions
across page requests.

### Order by creation time alone

Rejected because product chronology is the source fact's occurrence time, and a timestamp without a
unique tie-breaker is not a total ordering.

### Return unread count as a JavaScript number

Rejected because PostgreSQL counts are exact 64-bit values while JavaScript numbers do not preserve
every integer in that range.

### Mark a notification read whenever it is listed

Rejected because fetching and acknowledging are distinct user actions, automatic mutation breaks
safe reads, and background refresh could silently clear unread state.

### Return forbidden for another owner's notification

Rejected because it confirms that the resource exists.

### Store `read_at` on the inbox row

Rejected because notification facts are immutable and migration 0014 deliberately separates
monotonic delivery state from content.

## Consequences

### Positive Consequences

- Owners receive deterministic, isolated pages and exact unread state.
- New captures do not destabilize continuation pages.
- Equal occurrence timestamps have a reproducible total order.
- Mark-read is idempotent and preserves the first acknowledgement time.
- Page contents and unread count come from one coherent PostgreSQL snapshot.
- Future HTTP and browser adapters can depend on a framework-neutral public module interface.

### Negative Consequences

- The unread count adds a second query to each list operation.
- Cursors are intentionally opaque and must remain backwards compatible once exposed over HTTP.
- A repeatable-read transaction is held for both bounded read queries.
- There is still no user-visible inbox until delivery adapters are added.
- No bulk acknowledgement or retention mechanism exists yet.

## Reconsider When

Review this decision when exact counting becomes a measured bottleneck, inbox volume requires
partitioning or retention, a product requirement introduces bulk acknowledgement, cursor evolution
needs signing or expiration, or Notifications moves to a persistence system without snapshot
transactions.

## Related Decisions

- [ADR-010 — PostgreSQL Access, Transaction, and Migration Strategy](ADR-010-postgresql-access-transaction-and-migration-strategy.md)
- [ADR-047 — Durable Notification Inbox and Event-Capture Foundation](ADR-047-durable-notification-inbox-and-event-capture-foundation.md)
- [ADR-048 — Atomic Financial Notification Capture](ADR-048-atomic-financial-notification-capture.md)
