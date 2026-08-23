import { verifyEmailRequestSchema } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function verifyEmailAddress(
  client: Pick<AuthenticationHttpClient, "request">,
  token: string,
): Promise<void> {
  const requestBody = verifyEmailRequestSchema.parse({ token });
  await client.request("/api/v1/auth/verify-email", {
    method: "POST",
    body: requestBody,
    recoverAuthentication: false,
  });
}
