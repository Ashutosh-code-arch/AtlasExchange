import { describe, expect, it } from "vitest";

import {
  maximumPortfolioValueDigits,
  portfolioSnapshotResponseSchema,
  portfolioValueSchema,
} from "../src/index.js";

const snapshot = {
  success: true,
  data: {
    valuationCurrency: "USD",
    generatedAt: "2026-08-28T15:30:00.000Z",
    positions: [
      {
        assetCode: "BTC",
        displayName: "Bitcoin",
        available: "0.4",
        reserved: "0.1",
        total: "0.5",
        valuation: {
          status: "valued",
          marketCode: "BTC-USD",
          referencePrice: "50000",
          referencePriceAsOf: "2026-08-28T15:29:00.000Z",
          freshness: "current",
          value: "25000",
        },
      },
      {
        assetCode: "ETH",
        displayName: "Ether",
        available: "0",
        reserved: "0",
        total: "0",
        valuation: {
          status: "zero",
          marketCode: null,
          referencePrice: null,
          referencePriceAsOf: null,
          freshness: null,
          value: "0",
        },
      },
      {
        assetCode: "USD",
        displayName: "US Dollar",
        available: "35000",
        reserved: "0",
        total: "35000",
        valuation: {
          status: "cash",
          marketCode: null,
          referencePrice: "1",
          referencePriceAsOf: null,
          freshness: "current",
          value: "35000",
        },
      },
    ],
    summary: { totalValue: "60000", unpricedAssetCodes: [], complete: true },
  },
} as const;

describe("Portfolio snapshot contract", () => {
  it("accepts exact sorted positions and a reconciled complete valuation", () => {
    expect(portfolioSnapshotResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("accepts an explicitly incomplete snapshot without inventing a value", () => {
    const incomplete = {
      ...snapshot,
      data: {
        ...snapshot.data,
        positions: snapshot.data.positions.map((position) =>
          position.assetCode === "BTC"
            ? {
                ...position,
                valuation: {
                  status: "unpriced" as const,
                  reason: "NO_REFERENCE_PRICE" as const,
                  marketCode: "BTC-USD",
                  referencePrice: null,
                  referencePriceAsOf: null,
                  freshness: null,
                  value: null,
                },
              }
            : position,
        ),
        summary: {
          totalValue: "35000",
          unpricedAssetCodes: ["BTC"],
          complete: false,
        },
      },
    };
    expect(portfolioSnapshotResponseSchema.parse(incomplete)).toEqual(incomplete);
  });

  it("rejects inconsistent balances, ordering, valuation markets, totals, and completeness", () => {
    for (const data of [
      { ...snapshot.data, positions: snapshot.data.positions.toReversed() },
      {
        ...snapshot.data,
        positions: snapshot.data.positions.map((position) =>
          position.assetCode === "BTC" ? { ...position, total: "0.6" } : position,
        ),
      },
      {
        ...snapshot.data,
        positions: snapshot.data.positions.map((position) =>
          position.assetCode === "BTC"
            ? {
                ...position,
                valuation: { ...position.valuation, marketCode: "ETH-USD" },
              }
            : position,
        ),
      },
      { ...snapshot.data, summary: { ...snapshot.data.summary, totalValue: "59999" } },
      { ...snapshot.data, summary: { ...snapshot.data.summary, complete: false } },
      {
        ...snapshot.data,
        positions: snapshot.data.positions.map((position) =>
          position.assetCode === "BTC"
            ? { ...position, valuation: { ...position.valuation, value: "24999" } }
            : position,
        ),
        summary: { ...snapshot.data.summary, totalValue: "59999" },
      },
      { ...snapshot.data, ownerId: "private" },
    ]) {
      expect(portfolioSnapshotResponseSchema.safeParse({ success: true, data }).success).toBe(
        false,
      );
    }
  });

  it("bounds derived valuation precision without forcing ledger-scale rounding", () => {
    expect(portfolioValueSchema.parse("0.0000000001")).toBe("0.0000000001");
    expect(portfolioValueSchema.safeParse("1.230").success).toBe(false);
    expect(portfolioValueSchema.safeParse("01").success).toBe(false);
    expect(
      portfolioValueSchema.safeParse("9".repeat(maximumPortfolioValueDigits + 1)).success,
    ).toBe(false);
  });
});
