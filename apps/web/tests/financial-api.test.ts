import { describe, expect, it, vi } from "vitest";

import {
  createFinancialWallet,
  createSimulatedDeposit,
  createSimulatedWithdrawal,
  listFinancialAssets,
  listFinancialWallets,
} from "../src/features/financial";

const wallet = {
  id: "11111111-1111-4111-8111-111111111111",
  assetCode: "BTC",
  available: "1.25",
  reserved: "0",
  total: "1.25",
};

describe("Financial API functions", () => {
  it("loads contract-validated assets and owner wallets", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            assets: [
              {
                code: "BTC",
                displayName: "Bitcoin",
                ledgerScale: 8,
                status: "active",
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, data: { wallets: [wallet] } }));

    await expect(listFinancialAssets({ request })).resolves.toMatchObject([{ code: "BTC" }]);
    await expect(listFinancialWallets({ request })).resolves.toEqual([wallet]);
    expect(request).toHaveBeenNthCalledWith(1, "/api/v1/assets", { method: "GET" });
    expect(request).toHaveBeenNthCalledWith(2, "/api/v1/wallets", { method: "GET" });
  });

  it("opens an asset-derived wallet through the CSRF-protected command", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ success: true, data: { wallet } }));

    await expect(createFinancialWallet({ request }, "BTC")).resolves.toEqual(wallet);
    expect(request).toHaveBeenCalledWith("/api/v1/wallets/BTC", {
      method: "PUT",
      csrf: true,
    });
  });

  it("sends strict simulated funding and withdrawal commands with explicit idempotency", async () => {
    const deposit = {
      id: "22222222-2222-4222-8222-222222222222",
      walletId: wallet.id,
      assetCode: "BTC",
      amount: "1.25",
      method: "simulated",
      status: "credited",
      creditedAt: "2026-08-26T00:00:00.000Z",
    };
    const withdrawal = {
      id: "33333333-3333-4333-8333-333333333333",
      walletId: wallet.id,
      assetCode: "BTC",
      amount: "0.5",
      method: "simulated",
      status: "completed",
      completedAt: "2026-08-26T00:01:00.000Z",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { deposit } }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { withdrawal } }));

    await expect(
      createSimulatedDeposit(
        { request },
        { assetCode: "BTC", amount: "1.25", idempotencyKey: "deposit-intent" },
      ),
    ).resolves.toEqual(deposit);
    await expect(
      createSimulatedWithdrawal(
        { request },
        { assetCode: "BTC", amount: "0.5", idempotencyKey: "withdrawal-intent" },
      ),
    ).resolves.toEqual(withdrawal);
    expect(request).toHaveBeenNthCalledWith(1, "/api/v1/deposits/simulated", {
      method: "POST",
      csrf: true,
      headers: { "idempotency-key": "deposit-intent" },
      body: { assetCode: "BTC", amount: "1.25" },
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/v1/withdrawals/simulated", {
      method: "POST",
      csrf: true,
      headers: { "idempotency-key": "withdrawal-intent" },
      body: { assetCode: "BTC", amount: "0.5" },
    });
  });

  it("rejects internal Financial fields at the response boundary", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { wallets: [{ ...wallet, availableAccountId: "must-not-cross-the-boundary" }] },
      }),
    );

    await expect(listFinancialWallets({ request })).rejects.toMatchObject({ name: "ZodError" });
  });
});
