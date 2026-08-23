import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import {
  createAuthenticationHttpClient,
  type AuthenticationHttpClient,
  type CreateAuthenticationHttpClientOptions,
} from "../api/authentication-http-client";
import { getCurrentUser, type CurrentUser } from "../api/get-current-user";
import {
  AuthenticationSessionContext,
  type AuthenticationSessionState,
} from "./authentication-session-context";

export type AuthenticationSessionClient = Pick<AuthenticationHttpClient, "request" | "dispose">;

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
}: AuthenticationProviderProps): React.JSX.Element {
  const [state, setState] = useState<AuthenticationSessionState>(checkingState);
  const clientRef = useRef<AuthenticationSessionClient | null>(null);
  const loadSequenceRef = useRef(0);

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

  const value = useMemo(() => ({ state, recheck }), [state, recheck]);
  return <AuthenticationSessionContext value={value}>{children}</AuthenticationSessionContext>;
}
