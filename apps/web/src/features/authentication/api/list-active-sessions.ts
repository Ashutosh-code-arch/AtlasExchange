import { sessionsResponseSchema, type SessionSummary } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function listActiveSessions(
  client: Pick<AuthenticationHttpClient, "request">,
): Promise<readonly SessionSummary[]> {
  const response = await client.request("/api/v1/auth/sessions", { method: "GET" });
  const payload = (await response.json()) as unknown;
  return sessionsResponseSchema.parse(payload).data.sessions;
}
