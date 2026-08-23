import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationProvider,
  useAuthenticationSession,
  type AuthenticationProviderProps,
  type AuthenticationSessionClient,
  type AuthenticationSessionClientFactory,
  type AuthenticationSessionClientFactoryOptions,
  type CurrentUser,
} from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

const firstUser: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "First@Example.com",
  roles: ["user"],
};
const secondUser: CurrentUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "Second@Example.com",
  roles: ["admin", "user"],
};

type CurrentUserLoader = NonNullable<AuthenticationProviderProps["currentUserLoader"]>;
type PasswordLogin = NonNullable<AuthenticationProviderProps["passwordLogin"]>;
type SessionLogout = NonNullable<AuthenticationProviderProps["sessionLogout"]>;
type AccountRegistration = NonNullable<AuthenticationProviderProps["accountRegistration"]>;

function SessionProbe(): React.JSX.Element {
  const { state, recheck, signIn, signOut, register } = useAuthenticationSession();
  const [signInFailed, setSignInFailed] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [registrationFailed, setRegistrationFailed] = useState(false);
  return (
    <div>
      <span data-testid="session-status">{state.status}</span>
      {state.status === "authenticated" ? <span>{state.user.email}</span> : null}
      <button type="button" onClick={() => void recheck()}>
        Recheck session
      </button>
      <button
        type="button"
        onClick={() => {
          void signIn({ email: "user@example.com", password: "safe login passphrase" }).catch(() =>
            setSignInFailed(true),
          );
        }}
      >
        Sign in
      </button>
      <button
        type="button"
        onClick={() => {
          void signOut().catch(() => setSignOutFailed(true));
        }}
      >
        Sign out
      </button>
      <button
        type="button"
        onClick={() => {
          void register({
            email: "new@example.com",
            password: "safe registration passphrase",
          }).catch(() => setRegistrationFailed(true));
        }}
      >
        Register account
      </button>
      {signInFailed ? <span>Sign in failed</span> : null}
      {signOutFailed ? <span>Sign out failed</span> : null}
      {registrationFailed ? <span>Registration failed</span> : null}
    </div>
  );
}

function createClientHarness(): {
  readonly client: AuthenticationSessionClient;
  readonly clientFactory: AuthenticationSessionClientFactory;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly factoryOptions: () => AuthenticationSessionClientFactoryOptions | undefined;
  authenticationLost(): void;
} {
  const dispose = vi.fn();
  const client: AuthenticationSessionClient = {
    request: vi.fn(),
    dispose,
    announceAuthenticationLost: vi.fn(),
  };
  let authenticationLost = (): void => undefined;
  let receivedFactoryOptions: AuthenticationSessionClientFactoryOptions | undefined;
  const createClient: AuthenticationSessionClientFactory = (options) => {
    receivedFactoryOptions = options;
    authenticationLost = options.onAuthenticationLost;
    return client;
  };
  const clientFactory = vi.fn(createClient);
  return {
    client,
    clientFactory,
    dispose,
    factoryOptions: () => receivedFactoryOptions,
    authenticationLost: () => authenticationLost(),
  };
}

describe("AuthenticationProvider", () => {
  it("bootstraps and exposes the authenticated current user", async () => {
    const harness = createClientHarness();
    const currentUserLoader = vi.fn<CurrentUserLoader>().mockResolvedValue(firstUser);
    const view = render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={currentUserLoader}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(screen.getByTestId("session-status")).toHaveTextContent("checking");
    expect(await screen.findByText(firstUser.email)).toBeInTheDocument();
    expect(screen.getByTestId("session-status")).toHaveTextContent("authenticated");
    expect(currentUserLoader).toHaveBeenCalledWith(harness.client);
    expect(harness.factoryOptions()?.apiBaseUrl).toBe("http://api.test");
    expect(harness.factoryOptions()?.onAuthenticationLost).toBeTypeOf("function");

    view.unmount();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("distinguishes an anonymous session from an unavailable API", async () => {
    const anonymous = createClientHarness();
    const anonymousLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValue(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous-request"));
    const anonymousView = render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={anonymous.clientFactory}
        currentUserLoader={anonymousLoader}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );
    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
    anonymousView.unmount();

    const unavailable = createClientHarness();
    const unavailableView = render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={unavailable.clientFactory}
        currentUserLoader={() => Promise.reject(new Error("network unavailable"))}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    unavailableView.unmount();
  });

  it("reacts to cross-tab authentication loss and can explicitly recheck", async () => {
    const harness = createClientHarness();
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockResolvedValueOnce(firstUser)
      .mockResolvedValueOnce(secondUser);
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={currentUserLoader}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText(firstUser.email)).toBeInTheDocument();
    act(() => harness.authenticationLost());
    expect(screen.getByTestId("session-status")).toHaveTextContent("unauthenticated");

    await user.click(screen.getByRole("button", { name: "Recheck session" }));
    expect(await screen.findByText(secondUser.email)).toBeInTheDocument();
    expect(currentUserLoader).toHaveBeenCalledTimes(2);
  });

  it("establishes authoritative session state after a confirmed password login", async () => {
    const harness = createClientHarness();
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValueOnce(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous-request"))
      .mockResolvedValueOnce(firstUser);
    const passwordLogin = vi.fn<PasswordLogin>().mockResolvedValue();
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={currentUserLoader}
        passwordLogin={passwordLogin}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(firstUser.email)).toBeInTheDocument();
    expect(passwordLogin).toHaveBeenCalledWith(harness.client, {
      email: "user@example.com",
      password: "safe login passphrase",
    });
    expect(currentUserLoader).toHaveBeenCalledTimes(2);
  });

  it("preserves unauthenticated state when password login fails", async () => {
    const harness = createClientHarness();
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValue(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous-request"));
    const passwordLogin = vi
      .fn<PasswordLogin>()
      .mockRejectedValue(new ApiHttpError(401, "AUTHENTICATION_FAILED", "login-request"));
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={currentUserLoader}
        passwordLogin={passwordLogin}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Sign in failed")).toBeInTheDocument();
    expect(screen.getByTestId("session-status")).toHaveTextContent("unauthenticated");
    expect(currentUserLoader).toHaveBeenCalledOnce();
  });

  it("terminates the current session and exposes authoritative anonymous state", async () => {
    const harness = createClientHarness();
    const currentUserLoader = vi.fn<CurrentUserLoader>().mockResolvedValue(firstUser);
    const sessionLogout = vi.fn<SessionLogout>().mockResolvedValue();
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={currentUserLoader}
        sessionLogout={sessionLogout}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText(firstUser.email)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
    expect(sessionLogout).toHaveBeenCalledWith(harness.client);
    expect(harness.client.announceAuthenticationLost).toHaveBeenCalledOnce();
    expect(currentUserLoader).toHaveBeenCalledOnce();
  });

  it("preserves authenticated state when current-session logout fails", async () => {
    const harness = createClientHarness();
    const sessionLogout = vi
      .fn<SessionLogout>()
      .mockRejectedValue(new ApiHttpError(403, "CSRF_FAILED", "logout-request"));
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={() => Promise.resolve(firstUser)}
        sessionLogout={sessionLogout}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText(firstUser.email)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Sign out failed")).toBeInTheDocument();
    expect(screen.getByTestId("session-status")).toHaveTextContent("authenticated");
  });

  it("deduplicates concurrent password-login submissions", async () => {
    const harness = createClientHarness();
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValueOnce(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous-request"))
      .mockResolvedValueOnce(firstUser);
    let completeLogin = (): void => undefined;
    const loginResult = new Promise<void>((resolve) => {
      completeLogin = resolve;
    });
    const passwordLogin = vi.fn<PasswordLogin>().mockReturnValue(loginResult);
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={currentUserLoader}
        passwordLogin={passwordLogin}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Sign in" }));
    expect(passwordLogin).toHaveBeenCalledOnce();

    completeLogin();
    expect(await screen.findByText(firstUser.email)).toBeInTheDocument();
    expect(currentUserLoader).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent current-session logout submissions", async () => {
    const harness = createClientHarness();
    let completeLogout = (): void => undefined;
    const logoutResult = new Promise<void>((resolve) => {
      completeLogout = resolve;
    });
    const sessionLogout = vi.fn<SessionLogout>().mockReturnValue(logoutResult);
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={() => Promise.resolve(firstUser)}
        sessionLogout={sessionLogout}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText(firstUser.email)).toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Sign out" }));
    expect(sessionLogout).toHaveBeenCalledOnce();

    completeLogout();
    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
  });

  it("registers an account without inferring an authenticated session", async () => {
    const harness = createClientHarness();
    const currentUserLoader = vi
      .fn<CurrentUserLoader>()
      .mockRejectedValue(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous-request"));
    const accountRegistration = vi.fn<AccountRegistration>().mockResolvedValue();
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={currentUserLoader}
        accountRegistration={accountRegistration}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Register account" }));

    expect(accountRegistration).toHaveBeenCalledWith(harness.client, {
      email: "new@example.com",
      password: "safe registration passphrase",
    });
    expect(screen.getByTestId("session-status")).toHaveTextContent("unauthenticated");
    expect(currentUserLoader).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent account-registration submissions", async () => {
    const harness = createClientHarness();
    let completeRegistration = (): void => undefined;
    const registrationResult = new Promise<void>((resolve) => {
      completeRegistration = resolve;
    });
    const accountRegistration = vi.fn<AccountRegistration>().mockReturnValue(registrationResult);
    const user = userEvent.setup();
    render(
      <AuthenticationProvider
        apiBaseUrl="http://api.test"
        clientFactory={harness.clientFactory}
        currentUserLoader={() => Promise.reject(new ApiHttpError(401))}
        accountRegistration={accountRegistration}
      >
        <SessionProbe />
      </AuthenticationProvider>,
    );

    expect(await screen.findByText("unauthenticated")).toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Register account" }));
    expect(accountRegistration).toHaveBeenCalledOnce();

    completeRegistration();
    await expect(registrationResult).resolves.toBeUndefined();
  });
});
