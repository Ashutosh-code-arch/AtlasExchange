import { describe, expect, it, vi } from "vitest";

import { getPortfolioSnapshot } from "../src/features/portfolio";

const completeResponse = {
  success: true as const,
  data: {
    valuationCurrency: "USD",
    generatedAt: "2026-08-29T10:00:00.000Z",
    positions: [
      {
        assetCode: "BTC",
        displayName: "Bitcoin",
        available: "0.5",
        reserved: "0",
        total: "0.5",
        valuation: {
          status: "valued" as const,
          marketCode: "BTC-USD",
          referencePrice: "50000",
          referencePriceAsOf: "2026-08-29T09:59:00.000Z",
          freshness: "current" as const,
          value: "25000",
        },
      },
      {
        assetCode: "USD",
        displayName: "US Dollar",
        available: "35000",
        reserved: "0",
        total: "35000",
        valuation: {
          status: "cash" as const,
          marketCode: null,
          referencePrice: "1" as const,
          referencePriceAsOf: null,
          freshness: "current" as const,
          value: "35000",
        },
      },
    ],
    summary: { totalValue: "60000", unpricedAssetCodes: [], complete: true },
  },
};

describe("getPortfolioSnapshot", () => {
  it("loads the authenticated endpoint and returns the strict exact snapshot", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(completeResponse));

    await expect(getPortfolioSnapshot({ request })).resolves.toEqual(completeResponse.data);
    expect(request).toHaveBeenCalledWith("/api/v1/portfolio", { method: "GET" });
  });

  it("rejects a response whose server-owned summary does not reconcile", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        ...completeResponse,
        data: {
          ...completeResponse.data,
          summary: { ...completeResponse.data.summary, totalValue: "59999" },
        },
      }),
    );

    await expect(getPortfolioSnapshot({ request })).rejects.toThrow();
  });
});
