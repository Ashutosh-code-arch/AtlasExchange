import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@atlas/contracts";

import {
  ActiveSessions,
  AuthenticationProvider,
  type AuthenticationProviderProps,
  type AuthenticationSessionClient,
} from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

type SessionLister = NonNullable<AuthenticationProviderProps["sessionLister"]>;
type SessionRevoker = NonNullable<AuthenticationProviderProps["sessionRevoker"]>;

const sessions: readonly SessionSummary[] = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-08-20T10:00:00.000Z",
    lastActivityAt: "2026-08-23T10:00:00.000Z",
    idleExpiresAt: "2026-08-30T10:00:00.000Z",
    absoluteExpiresAt: "2026-09-19T10:00:00.000Z",
    current: true,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-08-18T08:00:00.000Z",
    lastActivityAt: "2026-08-22T09:30:00.000Z",
    idleExpiresAt: "2026-08-29T09:30:00.000Z",
    absoluteExpiresAt: "2026-09-17T08:00:00.000Z",
    current: false,
  },
];

function renderSessions(
  sessionLister: SessionLister,
  sessionRevoker: SessionRevoker = () => Promise.resolve(),
  onClose = vi.fn(),
): void {
  const client: AuthenticationSessionClient = {
    request: vi.fn(),
    dispose: vi.fn(),
    announceAuthenticationLost: vi.fn(),
  };
  render(
    <AuthenticationProvider
      apiBaseUrl="http://api.test"
      clientFactory={() => client}
      currentUserLoader={() => Promise.reject(new ApiHttpError(401))}
      sessionLister={sessionLister}
      sessionRevoker={sessionRevoker}
    >
      <ActiveSessions onClose={onClose} />
    </AuthenticationProvider>,
  );
}

describe("ActiveSessions", () => {
  it("distinguishes the current session and presents lifecycle metadata in UTC", async () => {
    const sessionLister = vi.fn<SessionLister>().mockResolvedValue(sessions);
    renderSessions(sessionLister);

    expect(screen.getByText("Loading active sessions…")).toBeInTheDocument();
    expect(await screen.findByText("This session")).toBeInTheDocument();
    expect(screen.getByText("Other active session")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/23 Aug 2026/)).toHaveAttribute("datetime", "2026-08-23T10:00:00.000Z");
    expect(screen.queryByText(/22222222|33333333/)).not.toBeInTheDocument();
  });

  it("shows an explicit empty inventory", async () => {
    renderSessions(() => Promise.resolve([]));

    expect(await screen.findByText("No active sessions were returned.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("recovers from a safe unavailable state without exposing backend details", async () => {
    const sessionLister = vi
      .fn<SessionLister>()
      .mockRejectedValueOnce(
        new ApiHttpError(503, "INTERNAL_ERROR", "sensitive-request-id", "internal backend detail"),
      )
      .mockResolvedValueOnce(sessions);
    const user = userEvent.setup();
    renderSessions(sessionLister);

    expect(
      await screen.findByText("Active sessions cannot be loaded right now."),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal backend detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("This session")).toBeInTheDocument();
    expect(sessionLister).toHaveBeenCalledTimes(2);
  });

  it("revokes another session only after confirmation and removes it after completion", async () => {
    let completeRevocation = (): void => undefined;
    const revocationResult = new Promise<void>((resolve) => {
      completeRevocation = resolve;
    });
    const sessionRevoker = vi.fn<SessionRevoker>().mockReturnValue(revocationResult);
    const user = userEvent.setup();
    renderSessions(() => Promise.resolve(sessions), sessionRevoker);

    expect(await screen.findByText("Other active session")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke other session" }));
    expect(sessionRevoker).not.toHaveBeenCalled();
    expect(screen.getByText(/all credentials in its token family/i)).toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Confirm revoke other session" }));

    expect(sessionRevoker).toHaveBeenCalledOnce();
    expect(sessionRevoker).toHaveBeenCalledWith(
      expect.anything(),
      "33333333-3333-4333-8333-333333333333",
    );
    expect(screen.getByRole("button", { name: "Revoking session…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel revocation" })).toBeDisabled();

    completeRevocation();
    expect(await screen.findByText("This session")).toBeInTheDocument();
    expect(screen.queryByText("Other active session")).not.toBeInTheDocument();
  });

  it("allows a pending revocation confirmation to be cancelled", async () => {
    const sessionRevoker = vi.fn<SessionRevoker>();
    const user = userEvent.setup();
    renderSessions(() => Promise.resolve(sessions), sessionRevoker);

    expect(await screen.findByText("Other active session")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke other session" }));
    await user.click(screen.getByRole("button", { name: "Cancel revocation" }));

    expect(sessionRevoker).not.toHaveBeenCalled();
    expect(screen.queryByText(/all credentials in its token family/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke other session" })).toBeInTheDocument();
  });

  it("keeps the session visible when revocation fails and hides backend details", async () => {
    const sessionRevoker = vi
      .fn<SessionRevoker>()
      .mockRejectedValue(
        new ApiHttpError(403, "CSRF_FAILED", "sensitive-request-id", "internal backend detail"),
      );
    const user = userEvent.setup();
    renderSessions(() => Promise.resolve(sessions), sessionRevoker);

    expect(await screen.findByText("Other active session")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke other session" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke other session" }));

    expect(
      await screen.findByText("This session could not be revoked. Refresh and try again."),
    ).toBeInTheDocument();
    expect(screen.getByText("Other active session")).toBeInTheDocument();
    expect(screen.queryByText("internal backend detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
  });
});
