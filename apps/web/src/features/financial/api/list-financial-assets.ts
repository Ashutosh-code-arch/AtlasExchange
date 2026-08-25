import { assetCatalogResponseSchema, type FinancialAsset } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export async function listFinancialAssets(
  client: Pick<AuthenticationHttpClient, "request">,
): Promise<readonly FinancialAsset[]> {
  const response = await client.request("/api/v1/assets", { method: "GET" });
  const payload = (await response.json()) as unknown;
  return assetCatalogResponseSchema.parse(payload).data.assets;
}
