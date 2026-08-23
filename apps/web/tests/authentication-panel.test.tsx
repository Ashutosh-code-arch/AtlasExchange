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
type AllSessionsLogout = NonNullable<AuthenticationProviderProps["allSessionsLogout"]>;
type AccountRegistration = NonNullable<AuthenticationProviderProps["accountRegistration"]>;
type VerificationResender = NonNullable<AuthenticationProviderProps["verificationResender"]>;
type PasswordResetRequester = NonNullable<AuthenticationProviderProps["passwordResetRequester"]>;
type SessionLister = NonNullable<AuthenticationProviderProps["sessionLister"]>;

function renderPanel(options: {
  readonly currentUserLoader: CurrentUserLoader;
  readonly passwordLogin?: PasswordLogin;
  readonly sessionLogout?: SessionLogout;
  readonly allSessionsLogout?: AllSessionsLogout;
  readonly accountRegistration?: AccountRegistration;
  readonly verificationResender?: VerificationResender;
  readonly passwordResetRequester?: PasswordResetRequester;
  readonly sessionLister?: SessionLister;
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
      {...(options.allSessionsLogout === undefined
        ? {}
        : { allSessionsLogout: options.allSessionsLogout })}
      {...(options.accountRegistration === undefined
        ? {}
        : { accountRegistration: options.accountRegistration })}
      {...(options.verificationResender === undefined
        ? {}
        : { verificationResender: options.verificationResender })}
      {...(options.passwordResetRequester === undefined
        ? {}
        : { passwordResetRequester: options.passwordResetRequester })}
      {...(options.sessionLister === undefined ? {} : { sessionLister: options.sessionLister })}
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

  it("recovers an unverified account with an enumeration-resistant resend", async () => {
    const currentUserLoader = vi.fn<CurrentUserLoader>().mockRejectedValue(anonymousSession());
    const passwordLogin = vi
      .fn<PasswordLogin>()
      .mockRejectedValue(new ApiHttpError(403, "ACCOUNT_VERIFICATION_REQUIRED", "login-request"));
    let completeResend = (): void => undefined;
    const resendResult = new Promise<void>((resolve) => {
      completeResend = resolve;
    });
    const verificationResender = vi.fn<VerificationResender>().mockReturnValue(resendResult);
    const user = userEvent.setup();
    renderPanel({ currentUserLoader, passwordLogin, verificationResender });

    const email = await screen.findByRole("textbox", { name: "Email" });
    const password = screen.getByLabelText("Password");
    await user.type(email, "pending@example.com");
    await user.type(password, "safe login passphrase");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Verify your email before signing in.")).toBeInTheDocument();
    expect(password).toHaveValue("");
    await user.dblClick(screen.getByRole("button", { name: "Resend verification email" }));

    expect(verificationResender).toHaveBeenCalledOnce();
    expect(verificationResender).toHaveBeenCalledWith(expect.anything(), {
      email: "pending@example.com",
    });
    expect(screen.getByRole("button", { name: "Requesting verification…" })).toBeDisabled();

    completeResend();
    expect(
      await screen.findByText(
        "If this address is eligible, Atlas will send new verification instructions shortly.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/account exists/i)).not.toBeInTheDocument();
  });

  it("maps verification-resend failures without exposing backend details", async () => {
    const passwordLogin = vi
      .fn<PasswordLogin>()
      .mockRejectedValue(new ApiHttpError(403, "ACCOUNT_VERIFICATION_REQUIRED", "login-request"));
    const verificationResender = vi
      .fn<VerificationResender>()
      .mockRejectedValue(
        new ApiHttpError(429, "RATE_LIMITED", "sensitive-request-id", "internal backend detail"),
      );
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.reject(anonymousSession()),
      passwordLogin,
      verificationResender,
    });

    await user.type(await screen.findByRole("textbox", { name: "Email" }), "pending@example.com");
    await user.type(screen.getByLabelText("Password"), "safe login passphrase");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(await screen.findByRole("button", { name: "Resend verification email" }));

    expect(
      await screen.findByText("Too many verification requests. Try again later."),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal backend detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
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

  it("requests password recovery and shows an enumeration-resistant accepted state", async () => {
    const passwordResetRequester = vi.fn<PasswordResetRequester>().mockResolvedValue();
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.reject(anonymousSession()),
      passwordResetRequester,
    });

    await user.click(await screen.findByRole("button", { name: "Forgot password?" }));
    const email = screen.getByRole("textbox", { name: "Email" });
    expect(email).toHaveAttribute("autocomplete", "username");
    await user.type(email, "recover@example.com");
    await user.dblClick(screen.getByRole("button", { name: "Request password reset" }));

    expect(passwordResetRequester).toHaveBeenCalledOnce();
    expect(passwordResetRequester).toHaveBeenCalledWith(expect.anything(), {
      email: "recover@example.com",
    });
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText(/if this address is eligible for recovery/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Return to sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("maps password-recovery failures without exposing backend details", async () => {
    const passwordResetRequester = vi
      .fn<PasswordResetRequester>()
      .mockRejectedValue(
        new ApiHttpError(429, "RATE_LIMITED", "sensitive-request-id", "internal backend detail"),
      );
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.reject(anonymousSession()),
      passwordResetRequester,
    });

    await user.click(await screen.findByRole("button", { name: "Forgot password?" }));
    await user.type(screen.getByRole("textbox", { name: "Email" }), "recover@example.com");
    await user.click(screen.getByRole("button", { name: "Request password reset" }));

    expect(
      await screen.findByText("Too many recovery attempts. Try again later."),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal backend detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
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

  it("opens and closes the authenticated session inventory on demand", async () => {
    const sessionLister = vi.fn<SessionLister>().mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-08-20T10:00:00.000Z",
        lastActivityAt: "2026-08-23T10:00:00.000Z",
        idleExpiresAt: "2026-08-30T10:00:00.000Z",
        absoluteExpiresAt: "2026-09-19T10:00:00.000Z",
        current: true,
      },
    ]);
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.resolve(currentUser),
      sessionLister,
    });

    expect(await screen.findByText(currentUser.email)).toBeInTheDocument();
    expect(sessionLister).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "View sessions" }));

    expect(await screen.findByRole("heading", { name: "Active sessions" })).toBeInTheDocument();
    expect(screen.getByText("This session")).toBeInTheDocument();
    expect(sessionLister).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Active sessions" })).not.toBeInTheDocument();
  });

  it("signs out every session and returns to the anonymous flow", async () => {
    const allSessionsLogout = vi.fn<AllSessionsLogout>().mockResolvedValue();
    const sessionLister = vi.fn<SessionLister>().mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-08-20T10:00:00.000Z",
        lastActivityAt: "2026-08-23T10:00:00.000Z",
        idleExpiresAt: "2026-08-30T10:00:00.000Z",
        absoluteExpiresAt: "2026-09-19T10:00:00.000Z",
        current: true,
      },
    ]);
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.resolve(currentUser),
      sessionLister,
      allSessionsLogout,
    });

    expect(await screen.findByText(currentUser.email)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View sessions" }));
    await user.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
    await user.click(screen.getByRole("button", { name: "Confirm sign out everywhere" }));

    expect(allSessionsLogout).toHaveBeenCalledWith(expect.anything());
    expect(await screen.findByRole("textbox", { name: "Email" })).toBeInTheDocument();
    expect(screen.queryByText(currentUser.email)).not.toBeInTheDocument();
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

  it("creates an account and shows an enumeration-resistant accepted state", async () => {
    const currentUserLoader = vi.fn<CurrentUserLoader>().mockRejectedValue(anonymousSession());
    let completeRegistration = (): void => undefined;
    const registrationResult = new Promise<void>((resolve) => {
      completeRegistration = resolve;
    });
    const accountRegistration = vi.fn<AccountRegistration>().mockReturnValue(registrationResult);
    const user = userEvent.setup();
    renderPanel({ currentUserLoader, accountRegistration });

    await user.click(await screen.findByRole("button", { name: "Create account" }));
    const email = screen.getByRole("textbox", { name: "Email" });
    const password = screen.getByLabelText("Password");
    const confirmation = screen.getByLabelText("Confirm password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(confirmation).toHaveAttribute("autocomplete", "new-password");

    await user.type(email, "new@example.com");
    await user.type(password, "safe registration passphrase");
    await user.type(confirmation, "safe registration passphrase");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(accountRegistration).toHaveBeenCalledWith(expect.anything(), {
      email: "new@example.com",
      password: "safe registration passphrase",
    });
    expect(screen.getByRole("button", { name: "Creating account…" })).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();

    completeRegistration();
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText(/if this address can be registered/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Return to sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("rejects mismatched registration passwords before transport", async () => {
    const accountRegistration = vi.fn<AccountRegistration>();
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.reject(anonymousSession()),
      accountRegistration,
    });

    await user.click(await screen.findByRole("button", { name: "Create account" }));
    await user.type(screen.getByRole("textbox", { name: "Email" }), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "safe registration passphrase");
    await user.type(screen.getByLabelText("Confirm password"), "different registration phrase");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(accountRegistration).not.toHaveBeenCalled();
  });

  it("maps registration failures without exposing backend details", async () => {
    const accountRegistration = vi
      .fn<AccountRegistration>()
      .mockRejectedValue(
        new ApiHttpError(429, "RATE_LIMITED", "sensitive-request-id", "internal backend detail"),
      );
    const user = userEvent.setup();
    renderPanel({
      currentUserLoader: () => Promise.reject(anonymousSession()),
      accountRegistration,
    });

    await user.click(await screen.findByRole("button", { name: "Create account" }));
    await user.type(screen.getByRole("textbox", { name: "Email" }), "new@example.com");
    await user.type(screen.getByLabelText("Password"), "safe registration passphrase");
    await user.type(screen.getByLabelText("Confirm password"), "safe registration passphrase");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("Too many registration attempts. Try again later."),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal backend detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
  });
});
