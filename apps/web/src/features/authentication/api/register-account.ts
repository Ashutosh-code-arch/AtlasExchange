import {
  registerAcceptedResponseSchema,
  registerRequestSchema,
  type RegisterRequest,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function registerAccount(
  client: Pick<AuthenticationHttpClient, "request">,
  input: RegisterRequest,
): Promise<void> {
  const requestBody = registerRequestSchema.parse(input);
  const response = await client.request("/api/v1/auth/register", {
    method: "POST",
    body: requestBody,
    recoverAuthentication: false,
  });
  const payload = (await response.json()) as unknown;
  registerAcceptedResponseSchema.parse(payload);
}
