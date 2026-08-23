import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import {
  createAuthenticationHttpClient,
  type AuthenticationHttpClient,
  type CreateAuthenticationHttpClientOptions,
} from "../api/authentication-http-client";
import { getCurrentUser, type CurrentUser } from "../api/get-current-user";
import { loginWithPassword } from "../api/login-with-password";
import { logoutCurrentSession } from "../api/logout-current-session";
import type { LoginRequest } from "@atlas/contracts";
import {
  AuthenticationSessionContext,
  type AuthenticationSessionState,
} from "./authentication-session-context";

export type AuthenticationSessionClient = Pick<
  AuthenticationHttpClient,
  "request" | "dispose" | "announceAuthenticationLost"
>;

export type AuthenticationSessionClientFactoryOptions = Pick<
  CreateAuthenticationHttpClientOptions,
  "apiBaseUrl" | "onAuthenticationLost"
>;

export type AuthenticationSessionClientFactory = (
  options: AuthenticationSessionClientFactoryOptions,
) => AuthenticationSessionClient;

export interface AuthenticationProviderProps {
  readonly apiBaseUrl: string;
  readonly children: React.ReactNode;
  readonly clientFactory?: AuthenticationSessionClientFactory;
  readonly currentUserLoader?: (
    client: Pick<AuthenticationSessionClient, "request">,
  ) => Promise<CurrentUser>;
  readonly passwordLogin?: (
    client: Pick<AuthenticationSessionClient, "request">,
    input: LoginRequest,
  ) => Promise<void>;
  readonly sessionLogout?: (client: Pick<AuthenticationSessionClient, "request">) => Promise<void>;
}

const checkingState = { status: "checking" } as const;
const unauthenticatedState = { status: "unauthenticated" } as const;
const unavailableState = { status: "unavailable" } as const;

const defaultClientFactory: AuthenticationSessionClientFactory = (options) =>
  createAuthenticationHttpClient(options);

export function AuthenticationProvider({
  apiBaseUrl,
  children,
  clientFactory = defaultClientFactory,
  currentUserLoader = getCurrentUser,
  passwordLogin = loginWithPassword,
  sessionLogout = logoutCurrentSession,
}: AuthenticationProviderProps): React.JSX.Element {
  const [state, setState] = useState<AuthenticationSessionState>(checkingState);
  const clientRef = useRef<AuthenticationSessionClient | null>(null);
  const loadSequenceRef = useRef(0);
  const signInFlightRef = useRef<Promise<void> | null>(null);
  const signOutFlightRef = useRef<Promise<void> | null>(null);

  const loadCurrentSession = useCallback(
    async (client: AuthenticationSessionClient): Promise<void> => {
      const sequence = ++loadSequenceRef.current;
      try {
        const user = await currentUserLoader(client);
        if (clientRef.current === client && loadSequenceRef.current === sequence) {
          setState({ status: "authenticated", user });
        }
      } catch (error) {
        if (clientRef.current !== client || loadSequenceRef.current !== sequence) {
          return;
        }
        setState(
          error instanceof ApiHttpError && error.status === 401
            ? unauthenticatedState
            : unavailableState,
        );
      }
    },
    [currentUserLoader],
  );

  useEffect(() => {
    let active = true;
    const clientHolder: { current: AuthenticationSessionClient | null } = { current: null };
    const client = clientFactory({
      apiBaseUrl,
      onAuthenticationLost: () => {
        if (active && clientHolder.current !== null && clientRef.current === clientHolder.current) {
          loadSequenceRef.current += 1;
          setState(unauthenticatedState);
        }
      },
    });
    clientHolder.current = client;
    clientRef.current = client;
    void loadCurrentSession(client);

    return () => {
      active = false;
      loadSequenceRef.current += 1;
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      client.dispose();
    };
  }, [apiBaseUrl, clientFactory, loadCurrentSession]);

  const recheck = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (client === null) {
      return;
    }
    setState(checkingState);
    await loadCurrentSession(client);
  }, [loadCurrentSession]);

  const signIn = useCallback(
    (input: LoginRequest): Promise<void> => {
      if (signInFlightRef.current !== null) {
        return signInFlightRef.current;
      }
      const client = clientRef.current;
      if (client === null) {
        return Promise.reject(new Error("Authentication session is not ready."));
      }

      const operation = (async (): Promise<void> => {
        await passwordLogin(client, input);
        if (clientRef.current !== client) {
          return;
        }
        setState(checkingState);
        await loadCurrentSession(client);
      })();
      signInFlightRef.current = operation;
      const clearSignIn = (): void => {
        if (signInFlightRef.current === operation) {
          signInFlightRef.current = null;
        }
      };
      void operation.then(clearSignIn, clearSignIn);
      return operation;
    },
    [loadCurrentSession, passwordLogin],
  );

  const signOut = useCallback((): Promise<void> => {
    if (signOutFlightRef.current !== null) {
      return signOutFlightRef.current;
    }
    const client = clientRef.current;
    if (client === null) {
      return Promise.reject(new Error("Authentication session is not ready."));
    }

    const operation = (async (): Promise<void> => {
      await sessionLogout(client);
      if (clientRef.current !== client) {
        return;
      }
      client.announceAuthenticationLost();
      loadSequenceRef.current += 1;
      setState(unauthenticatedState);
    })();
    signOutFlightRef.current = operation;
    const clearSignOut = (): void => {
      if (signOutFlightRef.current === operation) {
        signOutFlightRef.current = null;
      }
    };
    void operation.then(clearSignOut, clearSignOut);
    return operation;
  }, [sessionLogout]);

  const value = useMemo(
    () => ({ state, recheck, signIn, signOut }),
    [state, recheck, signIn, signOut],
  );
  return <AuthenticationSessionContext value={value}>{children}</AuthenticationSessionContext>;
}
