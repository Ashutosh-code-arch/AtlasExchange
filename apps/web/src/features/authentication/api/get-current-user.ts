import { currentUserResponseSchema, type CurrentUserResponse } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export type CurrentUser = CurrentUserResponse["data"]["user"];

export async function getCurrentUser(
  client: Pick<AuthenticationHttpClient, "request">,
): Promise<CurrentUser> {
  const response = await client.request("/api/v1/auth/me", { method: "GET" });
  const payload = (await response.json()) as unknown;
  return currentUserResponseSchema.parse(payload).data.user;
}
