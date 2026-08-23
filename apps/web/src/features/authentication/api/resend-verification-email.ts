import {
  resendVerificationAcceptedResponseSchema,
  resendVerificationRequestSchema,
  type ResendVerificationRequest,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function resendVerificationEmail(
  client: Pick<AuthenticationHttpClient, "request">,
  input: ResendVerificationRequest,
): Promise<void> {
  const requestBody = resendVerificationRequestSchema.parse(input);
  const response = await client.request("/api/v1/auth/resend-verification", {
    method: "POST",
    body: requestBody,
    recoverAuthentication: false,
  });
  const payload = (await response.json()) as unknown;
  resendVerificationAcceptedResponseSchema.parse(payload);
}
