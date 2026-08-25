import { walletResponseSchema, type FinancialWallet } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export async function createFinancialWallet(
  client: Pick<AuthenticationHttpClient, "request">,
  assetCode: string,
): Promise<FinancialWallet> {
  const response = await client.request(`/api/v1/wallets/${encodeURIComponent(assetCode)}`, {
    method: "PUT",
    csrf: true,
  });
  const payload = (await response.json()) as unknown;
  return walletResponseSchema.parse(payload).data.wallet;
}
