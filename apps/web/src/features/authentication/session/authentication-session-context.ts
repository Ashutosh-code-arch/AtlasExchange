import { createContext } from "react";
import type {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  ResendVerificationRequest,
  SessionSummary,
} from "@atlas/contracts";

import type { CurrentUser } from "../api/get-current-user";

export type AuthenticationSessionState =
  | { readonly status: "checking" }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" }
  | { readonly status: "authenticated"; readonly user: CurrentUser };

export type SessionRevocationTarget = Pick<SessionSummary, "id" | "current">;

export interface AuthenticationSessionValue {
  readonly state: AuthenticationSessionState;
  readonly recheck: () => Promise<void>;
  readonly signIn: (input: LoginRequest) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly register: (input: RegisterRequest) => Promise<void>;
  readonly resendVerification: (input: ResendVerificationRequest) => Promise<void>;
  readonly requestPasswordReset: (input: ForgotPasswordRequest) => Promise<void>;
  readonly resetPassword: (input: ResetPasswordRequest) => Promise<void>;
  readonly listSessions: () => Promise<readonly SessionSummary[]>;
  readonly revokeSession: (target: SessionRevocationTarget) => Promise<void>;
  readonly verifyEmail: (token: string) => Promise<void>;
}

export const AuthenticationSessionContext = createContext<AuthenticationSessionValue | undefined>(
  undefined,
);
