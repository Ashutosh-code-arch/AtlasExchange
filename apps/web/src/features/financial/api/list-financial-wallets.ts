import { walletListResponseSchema, type FinancialWallet } from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export async function listFinancialWallets(
  client: Pick<AuthenticationHttpClient, "request">,
): Promise<readonly FinancialWallet[]> {
  const response = await client.request("/api/v1/wallets", { method: "GET" });
  const payload = (await response.json()) as unknown;
  return walletListResponseSchema.parse(payload).data.wallets;
}
