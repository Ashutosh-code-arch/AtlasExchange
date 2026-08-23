import {
  loginRequestSchema,
  loginSuccessResponseSchema,
  type LoginRequest,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function loginWithPassword(
  client: Pick<AuthenticationHttpClient, "request">,
  input: LoginRequest,
): Promise<void> {
  const requestBody = loginRequestSchema.parse(input);
  const response = await client.request("/api/v1/auth/login", {
    method: "POST",
    body: requestBody,
    recoverAuthentication: false,
  });
  const payload = (await response.json()) as unknown;
  loginSuccessResponseSchema.parse(payload);
}
