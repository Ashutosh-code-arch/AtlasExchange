import type { Notification } from "@atlas/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession, type AuthenticationHttpClient } from "../../authentication";
import {
  getNotificationPage,
  markNotificationRead,
  type NotificationPage,
  type NotificationReadReceipt,
} from "../api/notification-api";

type NotificationPageLoader = typeof getNotificationPage;
type NotificationReadMarker = typeof markNotificationRead;
type NotificationLoadStatus = "error" | "loading" | "ready" | "refreshing" | "stale";

export interface NotificationCenterProps {
  readonly pageLoader?: NotificationPageLoader;
  readonly readMarker?: NotificationReadMarker;
}

interface AuthenticatedNotificationCenterProps {
  readonly request: AuthenticationHttpClient["request"];
  readonly pageLoader: NotificationPageLoader;
  readonly readMarker: NotificationReadMarker;
}

interface NotificationViewState {
  readonly status: NotificationLoadStatus;
  readonly notifications: readonly Notification[];
  readonly unreadCount: string;
  readonly nextCursor: string | null;
  readonly rateLimited: boolean;
}

function displayTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function notificationCopy(notification: Notification): {
  readonly title: string;
  readonly detail: string;
} {
  switch (notification.kind) {
    case "financial.deposit_credited":
      return {
        title: "Deposit credited",
        detail: `${notification.payload.amount} ${notification.payload.assetCode} is available.`,
      };
    case "financial.withdrawal_completed":
      return {
        title: "Withdrawal completed",
        detail: `${notification.payload.amount} ${notification.payload.assetCode} left your simulated balance.`,
      };
  }
}

function decrementExactCount(value: string): string {
  const count = BigInt(value);
  return count === 0n ? "0" : (count - 1n).toString();
}

function badgeCount(value: string): string {
  const count = BigInt(value);
  return count > 99n ? "99+" : value;
}

function appendUnique(
  existing: readonly Notification[],
  additions: readonly Notification[],
): Notification[] {
  const knownIds = new Set(existing.map(({ id }) => id));
  return [...existing, ...additions.filter(({ id }) => !knownIds.has(id))];
}

function NotificationBell(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
      <path
        d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function AuthenticatedNotificationCenter({
  request,
  pageLoader,
  readMarker,
}: AuthenticatedNotificationCenterProps): React.JSX.Element {
  const generationRef = useRef(0);
  const lastValidRef = useRef<NotificationPage | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [markingIds, setMarkingIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<NotificationViewState>({
    status: "loading",
    notifications: [],
    unreadCount: "0",
    nextCursor: null,
    rateLimited: false,
  });

  const loadInitial = useCallback(
    (refresh: boolean): void => {
      const generation = ++generationRef.current;
      setActionError(null);
      setView((current) => ({
        ...current,
        status:
          refresh && current.notifications.length > 0
            ? "refreshing"
            : current.notifications.length > 0
              ? current.status
              : "loading",
        rateLimited: false,
      }));
      void pageLoader({ request })
        .then((page) => {
          if (generationRef.current !== generation) return;
          lastValidRef.current = page;
          setView({
            status: "ready",
            notifications: page.notifications,
            unreadCount: page.unreadCount,
            nextCursor: page.page.nextCursor,
            rateLimited: false,
          });
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generation) return;
          const existing = lastValidRef.current;
          setView({
            status: existing === null ? "error" : "stale",
            notifications: existing?.notifications ?? [],
            unreadCount: existing?.unreadCount ?? "0",
            nextCursor: existing?.page.nextCursor ?? null,
            rateLimited: error instanceof ApiHttpError && error.code === "RATE_LIMITED",
          });
        });
    },
    [pageLoader, request],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    void pageLoader({ request })
      .then((page) => {
        if (generationRef.current !== generation) return;
        lastValidRef.current = page;
        setView({
          status: "ready",
          notifications: page.notifications,
          unreadCount: page.unreadCount,
          nextCursor: page.page.nextCursor,
          rateLimited: false,
        });
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setView({
          status: "error",
          notifications: [],
          unreadCount: "0",
          nextCursor: null,
          rateLimited: error instanceof ApiHttpError && error.code === "RATE_LIMITED",
        });
      });
    return () => {
      generationRef.current += 1;
    };
  }, [pageLoader, request]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const loadMore = (): void => {
    const cursor = view.nextCursor;
    if (cursor === null || isLoadingMore) return;
    const generation = generationRef.current;
    setIsLoadingMore(true);
    setActionError(null);
    void pageLoader({ request }, { cursor })
      .then((page) => {
        if (generationRef.current !== generation) return;
        setView((current) => {
          const notifications = appendUnique(current.notifications, page.notifications);
          const next = {
            ...current,
            notifications,
            unreadCount: page.unreadCount,
            nextCursor: page.page.nextCursor,
          };
          lastValidRef.current = {
            notifications,
            unreadCount: next.unreadCount,
            page: { nextCursor: next.nextCursor },
          };
          return next;
        });
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setActionError(
          error instanceof ApiHttpError && error.code === "RATE_LIMITED"
            ? "Too many inbox requests. Wait briefly and try again."
            : "More notifications could not be loaded.",
        );
      })
      .finally(() => {
        if (generationRef.current === generation) setIsLoadingMore(false);
      });
  };

  const markRead = (notification: Notification): void => {
    if (notification.readAt !== null || markingIds.has(notification.id)) return;
    setMarkingIds((current) => new Set(current).add(notification.id));
    setActionError(null);
    void readMarker({ request }, notification.id)
      .then((receipt: NotificationReadReceipt) => {
        setView((current) => {
          const wasUnread = current.notifications.some(
            (candidate) => candidate.id === receipt.notificationId && candidate.readAt === null,
          );
          const notifications = current.notifications.map((candidate) =>
            candidate.id === receipt.notificationId
              ? { ...candidate, readAt: receipt.readAt }
              : candidate,
          );
          const unreadCount = wasUnread
            ? decrementExactCount(current.unreadCount)
            : current.unreadCount;
          const next = { ...current, notifications, unreadCount };
          lastValidRef.current = {
            notifications,
            unreadCount,
            page: { nextCursor: current.nextCursor },
          };
          return next;
        });
      })
      .catch((error: unknown) => {
        setActionError(
          error instanceof ApiHttpError && error.code === "RATE_LIMITED"
            ? "Too many read updates. Wait briefly and try again."
            : "The notification could not be marked read.",
        );
      })
      .finally(() => {
        setMarkingIds((current) => {
          const next = new Set(current);
          next.delete(notification.id);
          return next;
        });
      });
  };

  const hasUnread = view.unreadCount !== "0";
  return (
    <div className="notification-center">
      <button
        className="notification-center__trigger"
        type="button"
        aria-expanded={isOpen}
        aria-controls="notification-inbox-panel"
        aria-label={hasUnread ? `Notifications, ${view.unreadCount} unread` : "Notifications"}
        onClick={() => setIsOpen((current) => !current)}
      >
        <NotificationBell />
        {hasUnread ? (
          <span className="notification-center__badge" aria-hidden="true">
            {badgeCount(view.unreadCount)}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <section
          className="notification-inbox"
          id="notification-inbox-panel"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="notification-inbox__heading">
            <div>
              <span>Activity inbox</span>
              <strong>{hasUnread ? `${view.unreadCount} unread` : "All caught up"}</strong>
            </div>
            <button type="button" aria-label="Close notifications" onClick={() => setIsOpen(false)}>
              ×
            </button>
          </div>

          {view.status === "loading" ? (
            <p className="notification-inbox__state">Loading notifications…</p>
          ) : view.status === "error" ? (
            <div className="notification-inbox__state" role="alert">
              <p>
                {view.rateLimited
                  ? "Too many inbox requests. Wait briefly and try again."
                  : "Notifications are unavailable."}
              </p>
              <button className="text-button" type="button" onClick={() => loadInitial(true)}>
                Retry
              </button>
            </div>
          ) : (
            <>
              {view.status === "stale" ? (
                <div className="notification-inbox__notice" role="alert">
                  <span>
                    {view.rateLimited
                      ? "Refresh limit reached. Displayed notifications may be stale."
                      : "Refresh failed. Displayed notifications may be stale."}
                  </span>
                </div>
              ) : null}

              {view.notifications.length === 0 ? (
                <div className="notification-inbox__empty">
                  <strong>No activity yet</strong>
                  <p>Completed Atlas activity will appear here.</p>
                </div>
              ) : (
                <ol className="notification-inbox__list">
                  {view.notifications.map((notification) => {
                    const copy = notificationCopy(notification);
                    const isMarking = markingIds.has(notification.id);
                    return (
                      <li
                        key={notification.id}
                        className="notification-inbox__item"
                        data-read={String(notification.readAt !== null)}
                      >
                        <span className="notification-inbox__marker" aria-hidden="true" />
                        <div>
                          <strong>{copy.title}</strong>
                          <p>{copy.detail}</p>
                          <small>{displayTimestamp(notification.occurredAt)}</small>
                        </div>
                        {notification.readAt === null ? (
                          <button
                            className="notification-inbox__read"
                            type="button"
                            aria-label={`Mark read: ${copy.title}`}
                            disabled={isMarking || view.status === "refreshing" || isLoadingMore}
                            onClick={() => markRead(notification)}
                          >
                            {isMarking ? "Saving…" : "Mark read"}
                          </button>
                        ) : (
                          <span className="notification-inbox__read-state">
                            Read {displayTimestamp(notification.readAt)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}

              {actionError === null ? null : (
                <p className="notification-inbox__action-error" role="alert">
                  {actionError}
                </p>
              )}

              <div className="notification-inbox__footer">
                {view.nextCursor === null ? (
                  <span>End of activity</span>
                ) : (
                  <button
                    className="text-button"
                    type="button"
                    disabled={isLoadingMore || view.status === "refreshing" || markingIds.size > 0}
                    onClick={loadMore}
                  >
                    {isLoadingMore ? "Loading…" : "Load more"}
                  </button>
                )}
                <button
                  className="text-button"
                  type="button"
                  disabled={view.status === "refreshing" || isLoadingMore || markingIds.size > 0}
                  onClick={() => loadInitial(true)}
                >
                  {view.status === "refreshing" ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

export function NotificationCenter({
  pageLoader = getNotificationPage,
  readMarker = markNotificationRead,
}: NotificationCenterProps): React.JSX.Element | null {
  const { state, request } = useAuthenticationSession();
  return state.status === "authenticated" ? (
    <AuthenticatedNotificationCenter
      key={state.user.id}
      request={request}
      pageLoader={pageLoader}
      readMarker={readMarker}
    />
  ) : null;
}
