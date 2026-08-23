import {
  forgotPasswordAcceptedResponseSchema,
  forgotPasswordRequestSchema,
  type ForgotPasswordRequest,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function requestPasswordReset(
  client: Pick<AuthenticationHttpClient, "request">,
  input: ForgotPasswordRequest,
): Promise<void> {
  const requestBody = forgotPasswordRequestSchema.parse(input);
  const response = await client.request("/api/v1/auth/forgot-password", {
    method: "POST",
    body: requestBody,
    recoverAuthentication: false,
  });
  const payload = (await response.json()) as unknown;
  forgotPasswordAcceptedResponseSchema.parse(payload);
}
