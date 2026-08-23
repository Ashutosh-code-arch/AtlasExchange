import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function SessionProbe(): React.JSX.Element {
  const { state, recheck } = useAuthenticationSession();
  return (
    <div>
      <span data-testid="session-status">{state.status}</span>
      {state.status === "authenticated" ? <span>{state.user.email}</span> : null}
      <button type="button" onClick={() => void recheck()}>
        Recheck session
      </button>
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
});
