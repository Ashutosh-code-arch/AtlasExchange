import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
        {...(options.initialRoute === undefined ? {} : { initialRoute: options.initialRoute })}
      />
    </AuthenticationProvider>,
  );
}

describe("Atlas overview", () => {
  it("shows the current delivery phase", async () => {
    renderApp(() => Promise.resolve({ status: "ready" }));

    expect(screen.getByRole("heading", { name: /build trust/i })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Know what you hold" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Portfolio" })).toHaveAttribute("href", "#portfolio");
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(screen.getByText("Financial core").closest("li")).toHaveTextContent(
      /03\s*Financial core\s*Complete/i,
    );
    expect(screen.getByText("Trading").closest("li")).toHaveTextContent(/04\s*Trading\s*Complete/i);
    expect(screen.getByText("Product surfaces").closest("li")).toHaveTextContent(
      /06\s*Product surfaces\s*Complete/i,
    );
    expect(await screen.findByText("Operational")).toBeInTheDocument();
    expect(await screen.findByText(appUser.email)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Administration console" }),
    ).not.toBeInTheDocument();
  });

  it("composes the Administration console only for an administrator", async () => {
    renderApp(() => Promise.resolve({ status: "ready" }), {
      currentUser: { ...appUser, roles: ["user", "admin"] },
    });

    expect(await screen.findByRole("link", { name: "Admin" })).toHaveAttribute(
      "href",
      "#administration",
    );
    expect(
      await screen.findByRole("heading", { name: "Administration console" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No identity selected")).toBeInTheDocument();
  });

  it("shows a safe offline state when readiness cannot be loaded", async () => {
    renderApp(() => Promise.reject(new Error("network failure")));

    expect(await screen.findByText("Offline")).toBeInTheDocument();
    expect(screen.getByText(/cannot be reached/i)).toBeInTheDocument();
  });

  it("allows the operator to refresh readiness", async () => {
    const readinessClient = vi
      .fn()
      .mockResolvedValueOnce({ status: "not_ready" as const })
      .mockResolvedValueOnce({ status: "ready" as const });
    const user = userEvent.setup();
    renderApp(readinessClient);

    expect(await screen.findByText("Starting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /refresh status/i }));

    await waitFor(() => expect(readinessClient).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Operational")).toBeInTheDocument();
  });

  it("composes email verification without loading overview readiness", async () => {
    const readinessClient = vi.fn();
    const emailVerifier = vi.fn().mockResolvedValue(undefined);
    renderApp(readinessClient, {
      initialRoute: { name: "verify-email", token: "opaque.verification-token" },
      emailVerifier,
    });

    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(emailVerifier).toHaveBeenCalledWith(expect.anything(), "opaque.verification-token");
    expect(readinessClient).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /build trust/i })).not.toBeInTheDocument();
  });

  it("composes password reset without loading overview readiness", () => {
    const readinessClient = vi.fn();
    const passwordResetter = vi.fn().mockResolvedValue(undefined);
    renderApp(readinessClient, {
      initialRoute: { name: "reset-password", token: "opaque.reset-token" },
      passwordResetter,
    });

    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    expect(readinessClient).not.toHaveBeenCalled();
    expect(passwordResetter).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /build trust/i })).not.toBeInTheDocument();
  });
});
