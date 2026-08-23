import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiHttpError } from "../../../shared/api/http-client";
import {
  createAuthenticationHttpClient,
  type AuthenticationHttpClient,
  type CreateAuthenticationHttpClientOptions,
} from "../api/authentication-http-client";
import { getCurrentUser, type CurrentUser } from "../api/get-current-user";
import { loginWithPassword } from "../api/login-with-password";
import { listActiveSessions } from "../api/list-active-sessions";
import { logoutCurrentSession } from "../api/logout-current-session";
import { registerAccount } from "../api/register-account";
import { requestPasswordReset } from "../api/request-password-reset";
import { resetPassword } from "../api/reset-password";
import { resendVerificationEmail } from "../api/resend-verification-email";
import { verifyEmailAddress } from "../api/verify-email-address";
import type {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  ResendVerificationRequest,
  SessionSummary,
} from "@atlas/contracts";
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
  readonly accountRegistration?: (
    client: Pick<AuthenticationSessionClient, "request">,
    input: RegisterRequest,
  ) => Promise<void>;
  readonly verificationResender?: (
    client: Pick<AuthenticationSessionClient, "request">,
    input: ResendVerificationRequest,
  ) => Promise<void>;
  readonly passwordResetRequester?: (
    client: Pick<AuthenticationSessionClient, "request">,
    input: ForgotPasswordRequest,
  ) => Promise<void>;
  readonly passwordResetter?: (
    client: Pick<AuthenticationSessionClient, "request">,
    input: ResetPasswordRequest,
  ) => Promise<void>;
  readonly sessionLister?: (
    client: Pick<AuthenticationSessionClient, "request">,
  ) => Promise<readonly SessionSummary[]>;
  readonly emailVerifier?: (
    client: Pick<AuthenticationSessionClient, "request">,
    token: string,
  ) => Promise<void>;
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
  accountRegistration = registerAccount,
  verificationResender = resendVerificationEmail,
  passwordResetRequester = requestPasswordReset,
  passwordResetter = resetPassword,
  sessionLister = listActiveSessions,
  emailVerifier = verifyEmailAddress,
}: AuthenticationProviderProps): React.JSX.Element {
  const [state, setState] = useState<AuthenticationSessionState>(checkingState);
  const clientRef = useRef<AuthenticationSessionClient | null>(null);
  const loadSequenceRef = useRef(0);
  const signInFlightRef = useRef<Promise<void> | null>(null);
  const signOutFlightRef = useRef<Promise<void> | null>(null);
  const registrationFlightRef = useRef<Promise<void> | null>(null);
  const verificationResendFlightRef = useRef<Promise<void> | null>(null);
  const passwordResetRequestFlightRef = useRef<Promise<void> | null>(null);
  const passwordResetFlightRef = useRef<Promise<void> | null>(null);
  const sessionListFlightRef = useRef<Promise<readonly SessionSummary[]> | null>(null);
  const emailVerificationFlightRef = useRef<{
    readonly token: string;
    readonly operation: Promise<void>;
  } | null>(null);

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

  const register = useCallback(
    (input: RegisterRequest): Promise<void> => {
      if (registrationFlightRef.current !== null) {
        return registrationFlightRef.current;
      }
      const client = clientRef.current;
      if (client === null) {
        return Promise.reject(new Error("Authentication session is not ready."));
      }

      const operation = (async (): Promise<void> => {
        await accountRegistration(client, input);
      })();
      registrationFlightRef.current = operation;
      const clearRegistration = (): void => {
        if (registrationFlightRef.current === operation) {
          registrationFlightRef.current = null;
        }
      };
      void operation.then(clearRegistration, clearRegistration);
      return operation;
    },
    [accountRegistration],
  );

  const verifyEmail = useCallback(
    (token: string): Promise<void> => {
      const existing = emailVerificationFlightRef.current;
      if (existing !== null) {
        return existing.token === token
          ? existing.operation
          : Promise.reject(new Error("Another email verification is already in progress."));
      }
      const client = clientRef.current;
      if (client === null) {
        return Promise.reject(new Error("Authentication session is not ready."));
      }

      const operation = (async (): Promise<void> => {
        await emailVerifier(client, token);
      })();
      emailVerificationFlightRef.current = { token, operation };
      const clearVerification = (): void => {
        if (emailVerificationFlightRef.current?.operation === operation) {
          emailVerificationFlightRef.current = null;
        }
      };
      void operation.then(clearVerification, clearVerification);
      return operation;
    },
    [emailVerifier],
  );

  const resendVerification = useCallback(
    (input: ResendVerificationRequest): Promise<void> => {
      if (verificationResendFlightRef.current !== null) {
        return verificationResendFlightRef.current;
      }
      const client = clientRef.current;
      if (client === null) {
        return Promise.reject(new Error("Authentication session is not ready."));
      }

      const operation = (async (): Promise<void> => {
        await verificationResender(client, input);
      })();
      verificationResendFlightRef.current = operation;
      const clearResend = (): void => {
        if (verificationResendFlightRef.current === operation) {
          verificationResendFlightRef.current = null;
        }
      };
      void operation.then(clearResend, clearResend);
      return operation;
    },
    [verificationResender],
  );

  const requestPasswordResetForEmail = useCallback(
    (input: ForgotPasswordRequest): Promise<void> => {
      if (passwordResetRequestFlightRef.current !== null) {
        return passwordResetRequestFlightRef.current;
      }
      const client = clientRef.current;
      if (client === null) {
        return Promise.reject(new Error("Authentication session is not ready."));
      }

      const operation = (async (): Promise<void> => {
        await passwordResetRequester(client, input);
      })();
      passwordResetRequestFlightRef.current = operation;
      const clearRequest = (): void => {
        if (passwordResetRequestFlightRef.current === operation) {
          passwordResetRequestFlightRef.current = null;
        }
      };
      void operation.then(clearRequest, clearRequest);
      return operation;
    },
    [passwordResetRequester],
  );

  const replacePassword = useCallback(
    (input: ResetPasswordRequest): Promise<void> => {
      if (passwordResetFlightRef.current !== null) {
        return passwordResetFlightRef.current;
      }
      const client = clientRef.current;
      if (client === null) {
        return Promise.reject(new Error("Authentication session is not ready."));
      }

      const operation = (async (): Promise<void> => {
        await passwordResetter(client, input);
        if (clientRef.current !== client) {
          return;
        }
        client.announceAuthenticationLost();
        loadSequenceRef.current += 1;
        setState(unauthenticatedState);
      })();
      passwordResetFlightRef.current = operation;
      const clearReset = (): void => {
        if (passwordResetFlightRef.current === operation) {
          passwordResetFlightRef.current = null;
        }
      };
      void operation.then(clearReset, clearReset);
      return operation;
    },
    [passwordResetter],
  );

  const listSessions = useCallback((): Promise<readonly SessionSummary[]> => {
    if (sessionListFlightRef.current !== null) {
      return sessionListFlightRef.current;
    }
    const client = clientRef.current;
    if (client === null) {
      return Promise.reject(new Error("Authentication session is not ready."));
    }

    const operation = (async (): Promise<readonly SessionSummary[]> => sessionLister(client))();
    sessionListFlightRef.current = operation;
    const clearList = (): void => {
      if (sessionListFlightRef.current === operation) {
        sessionListFlightRef.current = null;
      }
    };
    void operation.then(clearList, clearList);
    return operation;
  }, [sessionLister]);

  const value = useMemo(
    () => ({
      state,
      recheck,
      signIn,
      signOut,
      register,
      resendVerification,
      requestPasswordReset: requestPasswordResetForEmail,
      resetPassword: replacePassword,
      listSessions,
      verifyEmail,
    }),
    [
      state,
      recheck,
      signIn,
      signOut,
      register,
      resendVerification,
      requestPasswordResetForEmail,
      replacePassword,
      listSessions,
      verifyEmail,
    ],
  );
  return <AuthenticationSessionContext value={value}>{children}</AuthenticationSessionContext>;
}
