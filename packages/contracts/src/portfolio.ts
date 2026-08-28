import { z } from "zod";

import {
  financialAssetCodeSchema,
  financialQuantitySchema,
  positiveFinancialQuantitySchema,
} from "./financial.js";
import { marketDataOrderBookFreshnessSchema } from "./market-data.js";
import { tradingMarketCodeSchema } from "./trading.js";

export const maximumPortfolioValueDigits = 100;

const canonicalPortfolioValuePattern = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

function significantDigits(value: string): number {
  const [whole = "", fraction = ""] = value.split(".");
  return `${whole === "0" ? "" : whole}${fraction}`.length;
}

function decimalParts(value: string): { readonly coefficient: bigint; readonly scale: number } {
  const [whole = "0", fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function addDecimals(values: readonly string[]): string {
  const parts = values.map(decimalParts);
  const scale = parts.reduce((maximum, part) => Math.max(maximum, part.scale), 0);
  const coefficient = parts.reduce(
    (total, part) => total + part.coefficient * 10n ** BigInt(scale - part.scale),
    0n,
  );
  if (coefficient === 0n) return "0";
  const padded = coefficient.toString().padStart(scale + 1, "0");
  if (scale === 0) return padded;
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function multiplyDecimals(left: string, right: string): string {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = leftParts.scale + rightParts.scale;
  const coefficient = leftParts.coefficient * rightParts.coefficient;
  if (coefficient === 0n) return "0";
  const padded = coefficient.toString().padStart(scale + 1, "0");
  if (scale === 0) return padded;
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

export const portfolioValueSchema = z
  .string()
  .regex(canonicalPortfolioValuePattern)
  .refine((value) => significantDigits(value) <= maximumPortfolioValueDigits);

export const portfolioUnpricedReasonSchema = z.enum(["NO_VALUATION_MARKET", "NO_REFERENCE_PRICE"]);

export const portfolioValuationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("cash"),
    marketCode: z.null(),
    referencePrice: z.literal("1"),
    referencePriceAsOf: z.null(),
    freshness: z.literal("current"),
    value: portfolioValueSchema,
  }),
  z.strictObject({
    status: z.literal("valued"),
    marketCode: tradingMarketCodeSchema,
    referencePrice: positiveFinancialQuantitySchema,
    referencePriceAsOf: z.iso.datetime(),
    freshness: marketDataOrderBookFreshnessSchema,
    value: portfolioValueSchema,
  }),
  z.strictObject({
    status: z.literal("zero"),
    marketCode: z.null(),
    referencePrice: z.null(),
    referencePriceAsOf: z.null(),
    freshness: z.null(),
    value: z.literal("0"),
  }),
  z.strictObject({
    status: z.literal("unpriced"),
    reason: portfolioUnpricedReasonSchema,
    marketCode: tradingMarketCodeSchema.nullable(),
    referencePrice: z.null(),
    referencePriceAsOf: z.null(),
    freshness: z.null(),
    value: z.null(),
  }),
]);

export const portfolioPositionSchema = z.strictObject({
  assetCode: financialAssetCodeSchema,
  displayName: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => value === value.trim()),
  available: financialQuantitySchema,
  reserved: financialQuantitySchema,
  total: financialQuantitySchema,
  valuation: portfolioValuationSchema,
});

export const portfolioSnapshotResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      valuationCurrency: financialAssetCodeSchema,
      generatedAt: z.iso.datetime(),
      positions: z.array(portfolioPositionSchema),
      summary: z.strictObject({
        totalValue: portfolioValueSchema,
        unpricedAssetCodes: z.array(financialAssetCodeSchema),
        complete: z.boolean(),
      }),
    }),
  })
  .superRefine((response, context) => {
    const { valuationCurrency, positions, summary } = response.data;
    const positionCodes = positions.map((position) => position.assetCode);
    const sortedCodes = [...positionCodes].sort();
    if (
      new Set(positionCodes).size !== positionCodes.length ||
      positionCodes.some((code, index) => code !== sortedCodes[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Portfolio positions must be unique and sorted.",
      });
    }
    for (const position of positions) {
      if (addDecimals([position.available, position.reserved]) !== position.total) {
        context.addIssue({
          code: "custom",
          message: `Portfolio position ${position.assetCode} does not reconcile.`,
        });
      }
      if (position.valuation.status === "cash" && position.assetCode !== valuationCurrency) {
        context.addIssue({ code: "custom", message: "Only the valuation currency can be cash." });
      }
      if (
        position.valuation.status === "cash" &&
        (position.total === "0" || position.valuation.value !== position.total)
      ) {
        context.addIssue({
          code: "custom",
          message: "Cash valuation must equal its positive total.",
        });
      }
      if (
        position.valuation.status === "valued" &&
        position.valuation.marketCode !== `${position.assetCode}-${valuationCurrency}`
      ) {
        context.addIssue({
          code: "custom",
          message: "Portfolio valuation market must be the direct valuation pair.",
        });
      }
      if (
        position.valuation.status === "valued" &&
        (position.total === "0" ||
          position.valuation.value !==
            multiplyDecimals(position.total, position.valuation.referencePrice))
      ) {
        context.addIssue({
          code: "custom",
          message: "Portfolio position value must equal total multiplied by reference price.",
        });
      }
      if (position.valuation.status === "zero" && position.total !== "0") {
        context.addIssue({ code: "custom", message: "Only zero positions can omit valuation." });
      }
      if (position.valuation.status === "unpriced" && position.total === "0") {
        context.addIssue({ code: "custom", message: "Zero positions must not be unpriced." });
      }
      if (
        position.valuation.status === "unpriced" &&
        ((position.valuation.reason === "NO_VALUATION_MARKET" &&
          position.valuation.marketCode !== null) ||
          (position.valuation.reason === "NO_REFERENCE_PRICE" &&
            position.valuation.marketCode !== `${position.assetCode}-${valuationCurrency}`))
      ) {
        context.addIssue({
          code: "custom",
          message: "Portfolio unpriced reason must agree with its valuation market.",
        });
      }
    }
    const unpricedAssetCodes = positions
      .filter((position) => position.valuation.status === "unpriced")
      .map((position) => position.assetCode);
    if (
      summary.unpricedAssetCodes.length !== unpricedAssetCodes.length ||
      summary.unpricedAssetCodes.some((code, index) => code !== unpricedAssetCodes[index])
    ) {
      context.addIssue({ code: "custom", message: "Portfolio unpriced assets must reconcile." });
    }
    if (summary.complete !== (unpricedAssetCodes.length === 0)) {
      context.addIssue({ code: "custom", message: "Portfolio completeness must reconcile." });
    }
    const valuedAmounts = positions.flatMap((position) => {
      const value = position.valuation.value;
      return value === null ? [] : [value];
    });
    if (addDecimals(valuedAmounts) !== summary.totalValue) {
      context.addIssue({ code: "custom", message: "Portfolio total value must reconcile." });
    }
  });

export type PortfolioValue = z.infer<typeof portfolioValueSchema>;
export type PortfolioUnpricedReason = z.infer<typeof portfolioUnpricedReasonSchema>;
export type PortfolioValuation = z.infer<typeof portfolioValuationSchema>;
export type PortfolioPosition = z.infer<typeof portfolioPositionSchema>;
export type PortfolioSnapshotResponse = z.infer<typeof portfolioSnapshotResponseSchema>;
