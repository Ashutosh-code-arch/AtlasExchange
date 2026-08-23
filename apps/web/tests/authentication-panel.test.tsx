import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationPanel,
  AuthenticationProvider,
  type AuthenticationProviderProps,
  type AuthenticationSessionClient,
  type CurrentUser,
} from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

const currentUser: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "Trader@Example.com",
  roles: ["admin", "user"],
};

type CurrentUserLoader = NonNullable<AuthenticationProviderProps["currentUserLoader"]>;
type PasswordLogin = NonNullable<AuthenticationProviderProps["passwordLogin"]>;
type SessionLogout = NonNullable<AuthenticationProviderProps["sessionLogout"]>;

function renderPanel(options: {
  readonly currentUserLoader: CurrentUserLoader;
  readonly passwordLogin?: PasswordLogin;
  readonly sessionLogout?: SessionLogout;
}): void {
  const client: AuthenticationSessionClient = {
    request: vi.fn(),
    dispose: vi.fn(),
    announceAuthenticationLost: vi.fn(),
  };
  render(
    <AuthenticationProvider
      apiBaseUrl="http://api.test"
      clientFactory={() => client}
      currentUserLoader={options.currentUserLoader}
      {...(options.passwordLogin === undefined ? {} : { passwordLogin: options.passwordLogin })}
      {...(options.sessionLogout === undefined ? {} : { sessionLogout: options.sessionLogout })}
    >
      <AuthenticationPanel />
    </AuthenticationProvider>,
  );
}

const anonymousSession = (): ApiHttpError =>
  new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous-request");

describe("AuthenticationPanel", () => {
  it("submits password-manager-friendly credentials and shows server-confirmed identity", async () => {
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValueOnce(anonymousSession())
      .mockResolvedValueOnce(currentUser);
    const passwordLogin = vi.fn<PasswordLogin>().mockResolvedValue();
    const user = userEvent.setup();
    renderPanel({ currentUserLoader, passwordLogin });

    const email = await screen.findByRole("textbox", { name: "Email" });
    const password = screen.getByLabelText("Password");
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");

    await user.type(email, "Trader@Example.com");
    await user.type(password, "safe login passphrase");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(passwordLogin).toHaveBeenCalledWith(expect.anything(), {
      email: "Trader@Example.com",
      password: "safe login passphrase",
    });
    expect(await screen.findByText(currentUser.email)).toBeInTheDocument();
    expect(screen.getByText("admin · user")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it.each([
    ["AUTHENTICATION_FAILED", "Email or password is incorrect."],
    ["ACCOUNT_VERIFICATION_REQUIRED", "Verify your email before signing in."],
    ["ACCOUNT_UNAVAILABLE", "This account is currently unavailable."],
    ["RATE_LIMITED", "Too many sign-in attempts. Try again later."],
  ])("maps %s to a safe public message", async (code, expectedMessage) => {
    const currentUserLoader = vi.fn<CurrentUserLoader>().mockRejectedValue(anonymousSession());
    const passwordLogin = vi
      .fn<PasswordLogin>()
      .mockRejectedValue(
        new ApiHttpError(401, code, "sensitive-request-id", "internal backend detail"),
      );
    const user = userEvent.setup();
    renderPanel({ currentUserLoader, passwordLogin });

    await user.type(await screen.findByRole("textbox", { name: "Email" }), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "safe login passphrase");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(screen.queryByText("internal backend detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
  });

  it("locks the form while a sign-in submission is pending", async () => {
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValueOnce(anonymousSession())
      .mockResolvedValueOnce(currentUser);
    let completeLogin = (): void => undefined;
    const loginResult = new Promise<void>((resolve) => {
      completeLogin = resolve;
    });
    const passwordLogin = vi.fn<PasswordLogin>().mockReturnValue(loginResult);
    const user = userEvent.setup();
    renderPanel({ currentUserLoader, passwordLogin });

    await user.type(await screen.findByRole("textbox", { name: "Email" }), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "safe login passphrase");
    const submit = screen.getByRole("button", { name: "Sign in" });
    await user.dblClick(submit);

    expect(passwordLogin).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();

    completeLogin();
    expect(await screen.findByText(currentUser.email)).toBeInTheDocument();
  });

  it("allows an unavailable session check to be retried", async () => {
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(currentUser);
    const user = userEvent.setup();
    renderPanel({ currentUserLoader });

    expect(await screen.findByText(/identity services cannot be reached/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry session check" }));

    expect(await screen.findByText(currentUser.email)).toBeInTheDocument();
    await waitFor(() => expect(currentUserLoader).toHaveBeenCalledTimes(2));
  });

  it("locks current-session sign-out and returns to the anonymous form", async () => {
    let completeLogout = (): void => undefined;
    const logoutResult = new Promise<void>((resolve) => {
      completeLogout = resolve;
    });
    const sessionLogout = vi.fn<SessionLogout>().mockReturnValue(logoutResult);
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.resolve(currentUser),
      sessionLogout,
    });

    expect(await screen.findByText(currentUser.email)).toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Sign out" }));

    expect(sessionLogout).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();

    completeLogout();
    expect(await screen.findByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });

  it("keeps identity visible and hides backend details when sign-out fails", async () => {
    const sessionLogout = vi
      .fn<SessionLogout>()
      .mockRejectedValue(
        new ApiHttpError(403, "CSRF_FAILED", "sensitive-request-id", "internal backend detail"),
      );
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.resolve(currentUser),
      sessionLogout,
    });

    expect(await screen.findByText(currentUser.email)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Sign out is unavailable. Try again.")).toBeInTheDocument();
    expect(screen.getByText(currentUser.email)).toBeInTheDocument();
    expect(screen.queryByText("internal backend detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
  });
});
