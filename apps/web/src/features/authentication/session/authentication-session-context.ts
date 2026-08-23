import { createContext } from "react";
import type { LoginRequest } from "@atlas/contracts";

import type { CurrentUser } from "../api/get-current-user";

export type AuthenticationSessionState =
  | { readonly status: "checking" }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" }
  | { readonly status: "authenticated"; readonly user: CurrentUser };

export interface AuthenticationSessionValue {
  readonly state: AuthenticationSessionState;
  readonly recheck: () => Promise<void>;
  readonly signIn: (input: LoginRequest) => Promise<void>;
}

export const AuthenticationSessionContext = createContext<AuthenticationSessionValue | undefined>(
  undefined,
);
