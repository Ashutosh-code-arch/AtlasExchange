import { revokeSessionParamsSchema } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "./authentication-http-client";

export async function revokeActiveSession(
  client: Pick<AuthenticationHttpClient, "request">,
  sessionId: string,
): Promise<void> {
  const params = revokeSessionParamsSchema.parse({ sessionId });
  await client.request(`/api/v1/auth/sessions/${encodeURIComponent(params.sessionId)}`, {
    method: "DELETE",
    csrf: true,
  });
}
