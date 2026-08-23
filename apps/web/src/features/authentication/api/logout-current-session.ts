import { logoutRequestSchema } from "@atlas/contracts";

import { ApiHttpError } from "../../../shared/api/http-client";
import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function logoutCurrentSession(
  client: Pick<AuthenticationHttpClient, "request">,
): Promise<void> {
  try {
    await client.request("/api/v1/auth/logout", {
      method: "POST",
      body: logoutRequestSchema.parse({}),
      csrf: true,
      recoverAuthentication: false,
    });
  } catch (error) {
    if (
      error instanceof ApiHttpError &&
      error.status === 401 &&
      error.code === "AUTHENTICATION_REQUIRED"
    ) {
      return;
    }
    throw error;
  }
}
