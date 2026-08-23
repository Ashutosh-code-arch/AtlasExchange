import { resetPasswordRequestSchema, type ResetPasswordRequest } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function resetPassword(
  client: Pick<AuthenticationHttpClient, "request">,
  input: ResetPasswordRequest,
): Promise<void> {
  const requestBody = resetPasswordRequestSchema.parse(input);
  await client.request("/api/v1/auth/reset-password", {
    method: "POST",
    body: requestBody,
    recoverAuthentication: false,
  });
}
