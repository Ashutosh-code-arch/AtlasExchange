import { healthReadyResponseSchema, type HealthReadyResponse } from "@atlas/contracts";

export async function getReadiness(apiBaseUrl: string): Promise<HealthReadyResponse> {
  const response = await fetch(`${apiBaseUrl}/health/ready`, {
    headers: { accept: "application/json" },
  });

  if (response.status !== 200 && response.status !== 503) {
    throw new Error("Unexpected readiness response");
  }

  return healthReadyResponseSchema.parse(await response.json());
}
