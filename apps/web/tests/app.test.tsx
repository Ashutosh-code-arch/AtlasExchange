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
      currentUserLoader={() => Promise.resolve(appUser)}
      {...(options.emailVerifier === undefined ? {} : { emailVerifier: options.emailVerifier })}
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
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(await screen.findByText("Operational")).toBeInTheDocument();
    expect(await screen.findByText(appUser.email)).toBeInTheDocument();
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
});
