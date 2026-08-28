import { portfolioSnapshotResponseSchema, type PortfolioSnapshotResponse } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export type PortfolioSnapshot = PortfolioSnapshotResponse["data"];

export async function getPortfolioSnapshot(
  client: Pick<AuthenticationHttpClient, "request">,
): Promise<PortfolioSnapshot> {
  const response = await client.request("/api/v1/portfolio", { method: "GET" });
  const payload = (await response.json()) as unknown;
  return portfolioSnapshotResponseSchema.parse(payload).data;
}
