import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app";
import type { ApplicationRoute } from "../src/app/initial-route";
import {
  AuthenticationProvider,
  type AuthenticationProviderProps,
  type AuthenticationSessionClient,
  type CurrentUser,
} from "../src/features/authentication";

const appUser: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "Shell@Example.com",
  roles: ["user"],
};

function renderApp(
  readinessClient: NonNullable<React.ComponentProps<typeof App>["readinessClient"]>,
  options: {
    readonly initialRoute?: ApplicationRoute;
    readonly emailVerifier?: NonNullable<AuthenticationProviderProps["emailVerifier"]>;
    readonly passwordResetter?: NonNullable<AuthenticationProviderProps["passwordResetter"]>;
    readonly currentUser?: CurrentUser;
    readonly environment?: React.ComponentProps<typeof App>["environment"];
  } = {},
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
      currentUserLoader={() => Promise.resolve(options.currentUser ?? appUser)}
      {...(options.emailVerifier === undefined ? {} : { emailVerifier: options.emailVerifier })}
      {...(options.passwordResetter === undefined
        ? {}
        : { passwordResetter: options.passwordResetter })}
    >
      <App
        apiBaseUrl="http://api.test"
        readinessClient={readinessClient}
        {...(options.environment === undefined ? {} : { environment: options.environment })}
        {...(options.initialRoute === undefined ? {} : { initialRoute: options.initialRoute })}
      />
    </AuthenticationProvider>,
  );
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("Atlas product shell", () => {
  it("shows a focused authenticated dashboard instead of the delivery roadmap", async () => {
    renderApp(() => Promise.resolve({ status: "ready" }));

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: appUser.email })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Know what you hold" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Portfolio" })[0]).toHaveAttribute(
      "href",
      "/app/portfolio",
    );
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByText("Delivery roadmap")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /repository/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("keeps the demo simulation boundary visible without dominating the workspace", async () => {
    renderApp(() => Promise.resolve({ status: "ready" }), { environment: "demo" });

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByText("Simulation only")).toBeInTheDocument();
  });

  it("navigates between product pages with a real browser path", async () => {
    const user = userEvent.setup();
    renderApp(() => Promise.resolve({ status: "ready" }));

    const tradeLinks = await screen.findAllByRole("link", { name: "Trade" });
    await user.click(tradeLinks[0]!);

    expect(window.location.pathname).toBe("/app/trade/BTC-USD");
    expect(await screen.findByRole("heading", { name: "Trade" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Execute with precision" }),
    ).toBeInTheDocument();
  });

  it("shows the Administration destination only to an administrator", async () => {
    renderApp(() => Promise.resolve({ status: "ready" }), {
      currentUser: { ...appUser, roles: ["user", "admin"] },
      initialRoute: { name: "admin" },
    });

    expect(await screen.findByRole("link", { name: "Admin" })).toHaveAttribute(
      "href",
      "/app/admin",
    );
    expect(
      await screen.findByRole("heading", { name: "Administration console" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No identity selected")).toBeInTheDocument();
  });

  it("falls back to the dashboard when a non-admin requests the admin route", async () => {
    renderApp(() => Promise.resolve({ status: "ready" }), {
      initialRoute: { name: "admin" },
    });

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Administration console" }),
    ).not.toBeInTheDocument();
  });

  it("shows a safe offline state and allows a connection retry", async () => {
    const readinessClient = vi
      .fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({ status: "ready" as const });
    const user = userEvent.setup();
    renderApp(readinessClient);

    expect(await screen.findByText("Atlas cannot be reached right now.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    await waitFor(() => expect(readinessClient).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Atlas services are connected.")).toBeInTheDocument();
  });

  it("composes email verification without loading product readiness", async () => {
    const readinessClient = vi.fn();
    const emailVerifier = vi.fn().mockResolvedValue(undefined);
    renderApp(readinessClient, {
      initialRoute: { name: "verify-email", token: "opaque.verification-token" },
      emailVerifier,
    });

    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(emailVerifier).toHaveBeenCalledWith(expect.anything(), "opaque.verification-token");
    expect(readinessClient).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Dashboard" })).not.toBeInTheDocument();
  });

  it("composes password reset without loading product readiness", () => {
    const readinessClient = vi.fn();
    const passwordResetter = vi.fn().mockResolvedValue(undefined);
    renderApp(readinessClient, {
      initialRoute: { name: "reset-password", token: "opaque.reset-token" },
      passwordResetter,
    });

    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    expect(readinessClient).not.toHaveBeenCalled();
    expect(passwordResetter).not.toHaveBeenCalled();
  });
});
