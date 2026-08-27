import { describe, expect, it, vi } from "vitest";

import { getLevelTwoOrderBook } from "../src/features/market-data";

const response = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    depth: 15,
    sequence: "12",
    publishedSequence: "12",
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:00:12.000Z",
    generatedAt: "2026-08-28T12:00:12.250Z",
    bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
    asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
  },
} as const;

describe("Market Data API", () => {
  it("builds a validated bounded public request and validates the response", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(response));

    await expect(
      getLevelTwoOrderBook({ request }, { marketCode: "BTC-USD", depth: 15 }),
    ).resolves.toEqual(response.data);
    expect(request).toHaveBeenCalledWith(
      "/api/v1/market-data/markets/BTC-USD/order-book?depth=15",
      { method: "GET", recoverAuthentication: false },
    );
  });

  it("applies the shared default and rejects invalid input before browser traffic", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(response));
    await getLevelTwoOrderBook({ request }, { marketCode: "BTC-USD" });
    expect(request).toHaveBeenCalledWith(expect.stringContaining("depth=20"), expect.any(Object));

    request.mockClear();
    await expect(
      getLevelTwoOrderBook({ request }, { marketCode: "btc-usd", depth: 101 }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects inconsistent or private fields at the browser boundary", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        ...response,
        data: { ...response.data, generationId: "private" },
      }),
    );
    await expect(
      getLevelTwoOrderBook({ request }, { marketCode: "BTC-USD", depth: 15 }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
