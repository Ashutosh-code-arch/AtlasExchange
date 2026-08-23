import { use } from "react";

import { AuthenticationSessionContext } from "./authentication-session-context";
import type { AuthenticationSessionValue } from "./authentication-session-context";

export function useAuthenticationSession(): AuthenticationSessionValue {
  const session = use(AuthenticationSessionContext);
  if (session === undefined) {
    throw new Error("useAuthenticationSession must be used within AuthenticationProvider.");
  }
  return session;
}
