import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationProvider,
  type AuthenticationSessionClient,
  type CurrentUser,
} from "../src/features/authentication";
import {
  NotificationCenter,
  type NotificationCenterProps,
  type NotificationPage,
} from "../src/features/notifications";
import { ApiHttpError, ApiTransportError } from "../src/shared/api/http-client";

const currentUser: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "notified@example.com",
  roles: ["user"],
};
const depositId = "01900000-0000-7000-8000-000000000961";
const withdrawalId = "01900000-0000-7000-8000-000000000960";
const olderId = "01900000-0000-7000-8000-000000000959";

function page(overrides: Partial<NotificationPage> = {}): NotificationPage {
  return {
    notifications: [
      {
        id: depositId,
        kind: "financial.deposit_credited",
        sourceId: "01900000-0000-7000-8000-000000000971",
        payload: { assetCode: "BTC", amount: "1.25" },
        occurredAt: "2026-08-29T20:00:00.000Z",
        createdAt: "2026-08-29T20:00:01.000Z",
        readAt: null,
      },
      {
        id: withdrawalId,
        kind: "financial.withdrawal_completed",
        sourceId: "01900000-0000-7000-8000-000000000970",
        payload: { assetCode: "USD", amount: "25" },
        occurredAt: "2026-08-29T19:59:00.000Z",
        createdAt: "2026-08-29T19:59:01.000Z",
        readAt: null,
      },
    ],
    unreadCount: "2",
    page: { nextCursor: null },
    ...overrides,
  };
}

function renderCenter(
  props: NotificationCenterProps = {},
  authenticated = true,
): ReturnType<typeof vi.fn<AuthenticationSessionClient["request"]>> {
  const request = vi.fn<AuthenticationSessionClient["request"]>();
  const client: AuthenticationSessionClient = {
    request,
    dispose: vi.fn(),
    announceAuthenticationLost: vi.fn(),
  };
  render(
    <AuthenticationProvider
      apiBaseUrl="http://api.test"
      clientFactory={() => client}
      currentUserLoader={() =>
        authenticated
          ? Promise.resolve(currentUser)
          : Promise.reject(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous"))
      }
    >
      <NotificationCenter {...props} />
    </AuthenticationProvider>,
  );
  return request;
}

describe("NotificationCenter", () => {
  it("loads only after authentication and presents exact unread activity", async () => {
    const pageLoader = vi
      .fn<NonNullable<NotificationCenterProps["pageLoader"]>>()
      .mockResolvedValue(page());
    const user = userEvent.setup();
    renderCenter({ pageLoader });

    const trigger = await screen.findByRole("button", { name: "Notifications, 2 unread" });
    expect(pageLoader).toHaveBeenCalledOnce();
    expect(typeof pageLoader.mock.calls[0]?.[0].request).toBe("function");
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(dialog).getByText("2 unread")).toBeInTheDocument();
    expect(within(dialog).getByText("Deposit credited")).toBeInTheDocument();
    expect(within(dialog).getByText("1.25 BTC is available.")).toBeInTheDocument();
    expect(within(dialog).getByText("Withdrawal completed")).toBeInTheDocument();
    expect(within(dialog).getByText("25 USD left your simulated balance.")).toBeInTheDocument();
  });

  it("uses the server receipt before decrementing the exact unread badge", async () => {
    const pageLoader = vi
      .fn<NonNullable<NotificationCenterProps["pageLoader"]>>()
      .mockResolvedValue(page({ unreadCount: "100" }));
    const readMarker = vi
      .fn<NonNullable<NotificationCenterProps["readMarker"]>>()
      .mockResolvedValue({
        notificationId: depositId,
        readAt: "2026-08-29T20:01:00.000Z",
      });
    const user = userEvent.setup();
    renderCenter({ pageLoader, readMarker });

    const trigger = await screen.findByRole("button", { name: "Notifications, 100 unread" });
    expect(trigger).toHaveTextContent("99+");
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Mark read: Deposit credited" }));

    await waitFor(() => expect(readMarker).toHaveBeenCalledOnce());
    expect(typeof readMarker.mock.calls[0]?.[0].request).toBe("function");
    expect(readMarker.mock.calls[0]?.[1]).toBe(depositId);
    expect(
      await screen.findByRole("button", { name: "Notifications, 99 unread" }),
    ).toHaveTextContent("99");
    expect(screen.getByText(/^Read /)).toBeInTheDocument();
  });

  it("appends cursor pages without duplicating existing items", async () => {
    const pageLoader = vi
      .fn<NonNullable<NotificationCenterProps["pageLoader"]>>()
      .mockResolvedValueOnce(page({ page: { nextCursor: "older_cursor" } }))
      .mockResolvedValueOnce(
        page({
          notifications: [
            page().notifications[1]!,
            {
              ...page().notifications[1]!,
              id: olderId,
              sourceId: "01900000-0000-7000-8000-000000000969",
              occurredAt: "2026-08-29T19:58:00.000Z",
            },
          ],
          unreadCount: "3",
          page: { nextCursor: null },
        }),
      );
    const user = userEvent.setup();
    renderCenter({ pageLoader });

    await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => expect(pageLoader).toHaveBeenCalledTimes(2));
    expect(typeof pageLoader.mock.calls[1]?.[0].request).toBe("function");
    expect(pageLoader.mock.calls[1]?.[1]).toEqual({ cursor: "older_cursor" });
    expect(screen.getAllByText("Withdrawal completed")).toHaveLength(2);
    expect(screen.getByText("3 unread")).toBeInTheDocument();
    expect(screen.getByText("End of activity")).toBeInTheDocument();
  });

  it("retains the last valid inbox as visibly stale when refresh fails", async () => {
    const pageLoader = vi
      .fn<NonNullable<NotificationCenterProps["pageLoader"]>>()
      .mockResolvedValueOnce(page())
      .mockRejectedValueOnce(new ApiTransportError(new Error("connection reset")))
      .mockResolvedValueOnce(page({ unreadCount: "1" }));
    const user = userEvent.setup();
    renderCenter({ pageLoader });

    await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refresh failed. Displayed notifications may be stale.",
    );
    expect(screen.getByText("Deposit credited")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("1 unread")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows bounded load and mark errors without changing trusted state", async () => {
    const pageLoader = vi
      .fn<NonNullable<NotificationCenterProps["pageLoader"]>>()
      .mockResolvedValue(page());
    const readMarker = vi
      .fn<NonNullable<NotificationCenterProps["readMarker"]>>()
      .mockRejectedValue(
        new ApiHttpError(429, "RATE_LIMITED", "private-request", "internal limiter detail"),
      );
    const user = userEvent.setup();
    renderCenter({ pageLoader, readMarker });

    await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    await user.click(screen.getByRole("button", { name: "Mark read: Deposit credited" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many read updates. Wait briefly and try again.",
    );
    expect(screen.getByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
    expect(screen.queryByText(/internal limiter|private-request/i)).not.toBeInTheDocument();
  });

  it("does not load or expose the private inbox before authentication", async () => {
    const pageLoader = vi.fn<NonNullable<NotificationCenterProps["pageLoader"]>>();
    renderCenter({ pageLoader }, false);

    await waitFor(() => expect(pageLoader).not.toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Notifications/ })).not.toBeInTheDocument();
  });
});
