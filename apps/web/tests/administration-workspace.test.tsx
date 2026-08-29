import type { AdministrationUser } from "@atlas/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AdministrationWorkspace,
  type AdministrationWorkspaceProps,
} from "../src/features/administration";
import {
  AuthenticationProvider,
  type AuthenticationSessionClient,
  type CurrentUser,
} from "../src/features/authentication";
import { ApiHttpError, ApiTransportError } from "../src/shared/api/http-client";

const actor: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "operator@atlas.test",
  roles: ["user", "admin"],
};
const ordinaryUser: CurrentUser = { ...actor, roles: ["user"] };
const targetId = "00000000-0000-4000-8000-000000000902";
const operationId = "00000000-0000-4000-8000-000000000903";
const target: AdministrationUser = {
  id: targetId,
  email: "target@atlas.test",
  state: "active",
  roles: ["user"],
  createdAt: "2026-08-29T21:00:00.000Z",
};

function renderWorkspace(
  props: AdministrationWorkspaceProps = {},
  currentUser: CurrentUser | null = actor,
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
        currentUser === null
          ? Promise.reject(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous"))
          : Promise.resolve(currentUser)
      }
    >
      <AdministrationWorkspace {...props} />
    </AuthenticationProvider>,
  );
  return request;
}

async function findTarget(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText("Exact user ID"), targetId);
  await user.click(screen.getByRole("button", { name: "Find user" }));
  expect(await screen.findByText(target.email)).toBeInTheDocument();
}

describe("AdministrationWorkspace", () => {
  it("mounts only for an authenticated administrator and never performs automatic discovery", async () => {
    const userLoader = vi.fn<NonNullable<AdministrationWorkspaceProps["userLoader"]>>();
    renderWorkspace({ userLoader });
    expect(
      await screen.findByRole("heading", { name: "Administration console" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No identity selected")).toBeInTheDocument();
    expect(userLoader).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary user", ordinaryUser],
    ["anonymous visitor", null],
  ])("does not disclose the console to an %s", async (_label, currentUser) => {
    const userLoader = vi.fn<NonNullable<AdministrationWorkspaceProps["userLoader"]>>();
    renderWorkspace({ userLoader }, currentUser);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Administration console" }),
      ).not.toBeInTheDocument(),
    );
    expect(userLoader).not.toHaveBeenCalled();
  });

  it("loads and displays only the exact requested public user record", async () => {
    const user = userEvent.setup();
    const userLoader = vi
      .fn<NonNullable<AdministrationWorkspaceProps["userLoader"]>>()
      .mockResolvedValue(target);
    renderWorkspace({ userLoader });

    await findTarget(user);

    expect(userLoader).toHaveBeenCalledTimes(1);
    const [client, requestedId] = userLoader.mock.calls[0]!;
    expect(typeof client.request).toBe("function");
    expect(requestedId).toBe(targetId);
    expect(screen.getByText(targetId)).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Server confirmed")).toBeInTheDocument();
    expect(screen.queryByText(/password|session token/i)).not.toBeInTheDocument();
  });

  it("applies a server-confirmed suspension with an explicit reviewed reason", async () => {
    const user = userEvent.setup();
    const stateChanger = vi
      .fn<NonNullable<AdministrationWorkspaceProps["stateChanger"]>>()
      .mockResolvedValue({ ...target, state: "suspended" });
    renderWorkspace({
      userLoader: () => Promise.resolve(target),
      stateChanger,
      operationIdFactory: () => operationId,
    });
    await findTarget(user);

    await user.type(screen.getAllByLabelText("Reviewed reason")[0]!, "Reviewed abuse report.");
    await user.click(screen.getByRole("button", { name: "Confirm suspension" }));

    await waitFor(() =>
      expect(stateChanger).toHaveBeenCalledWith(expect.anything(), {
        userId: targetId,
        operationId,
        state: "suspended",
        reason: "Reviewed abuse report.",
      }),
    );
    expect(await screen.findByText("suspended")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("active sessions revoked");
  });

  it("applies a server-confirmed admin grant and communicates session revocation", async () => {
    const user = userEvent.setup();
    const roleChanger = vi
      .fn<NonNullable<AdministrationWorkspaceProps["roleChanger"]>>()
      .mockResolvedValue({ ...target, roles: ["user", "admin"] });
    renderWorkspace({
      userLoader: () => Promise.resolve(target),
      roleChanger,
      operationIdFactory: () => operationId,
    });
    await findTarget(user);

    await user.type(screen.getAllByLabelText("Reviewed reason")[1]!, "Approved support duty.");
    await user.click(screen.getByRole("button", { name: "Confirm admin grant" }));

    await waitFor(() =>
      expect(roleChanger).toHaveBeenCalledWith(expect.anything(), {
        userId: targetId,
        operationId,
        assigned: true,
        reason: "Approved support duty.",
      }),
    );
    expect(await screen.findByText("user · admin")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("target sessions were revoked");
  });

  it("blocks self-management after lookup", async () => {
    const user = userEvent.setup();
    renderWorkspace({ userLoader: () => Promise.resolve({ ...target, id: actor.id }) });

    await user.type(await screen.findByLabelText("Exact user ID"), actor.id);
    await user.click(screen.getByRole("button", { name: "Find user" }));

    expect(await screen.findByText("Self-management blocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm suspension/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm admin grant/ })).not.toBeInTheDocument();
  });

  it("reuses the same operation ID when an unchanged failed mutation is retried", async () => {
    const user = userEvent.setup();
    const operationIdFactory = vi.fn(() => operationId);
    const stateChanger = vi
      .fn<NonNullable<AdministrationWorkspaceProps["stateChanger"]>>()
      .mockRejectedValueOnce(new ApiTransportError(new Error("connection reset")))
      .mockResolvedValueOnce({ ...target, state: "suspended" });
    renderWorkspace({
      userLoader: () => Promise.resolve(target),
      stateChanger,
      operationIdFactory,
    });
    await findTarget(user);
    await user.type(screen.getAllByLabelText("Reviewed reason")[0]!, "Reviewed abuse report.");

    await user.click(screen.getByRole("button", { name: "Confirm suspension" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("change was not confirmed");
    await user.click(screen.getByRole("button", { name: "Confirm suspension" }));

    await waitFor(() => expect(stateChanger).toHaveBeenCalledTimes(2));
    expect(stateChanger.mock.calls[0]?.[1].operationId).toBe(operationId);
    expect(stateChanger.mock.calls[1]?.[1].operationId).toBe(operationId);
    expect(operationIdFactory).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed same-user reload visibly stale and disables mutations", async () => {
    const user = userEvent.setup();
    const userLoader = vi
      .fn<NonNullable<AdministrationWorkspaceProps["userLoader"]>>()
      .mockResolvedValueOnce(target)
      .mockRejectedValueOnce(new ApiTransportError(new Error("offline")));
    renderWorkspace({ userLoader });
    await findTarget(user);

    await user.click(screen.getByRole("button", { name: "Reload user" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("remains visible as stale");
    expect(screen.getByText("Stale · reload required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm suspension" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm admin grant" })).toBeDisabled();
  });

  it("maps lookup failures safely without exposing backend details", async () => {
    const user = userEvent.setup();
    renderWorkspace({
      userLoader: () =>
        Promise.reject(
          new ApiHttpError(404, "USER_NOT_FOUND", "sensitive-request-id", "private SQL detail"),
        ),
    });

    await user.type(await screen.findByLabelText("Exact user ID"), targetId);
    await user.click(screen.getByRole("button", { name: "Find user" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No user was found");
    expect(screen.queryByText(/private SQL detail|sensitive-request-id/i)).not.toBeInTheDocument();
  });
});
