import { z } from "zod";

import { financialQuantitySchema, positiveFinancialQuantitySchema } from "./financial.js";

const candleLimitPattern = /^(?:[1-9]|[1-9]\d|[12]\d{2}|300)$/;
const signedFinancialQuantityPattern = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

export const referenceMarketCodes = ["BTC-USD", "ETH-USD"] as const;
export const referenceMarketCodeSchema = z.enum(referenceMarketCodes);
export const referenceMarketDataSourceSchema = z.literal("coinbase");
export const referenceMarketDataFreshnessSchema = z.enum(["live", "stale"]);
export const referenceMarketDataCandleIntervalSchema = z.literal("5m");
export const defaultReferenceMarketDataCandleLimit = 100;
export const maximumReferenceMarketDataCandleLimit = 300;

export const signedFinancialQuantitySchema = z
  .string()
  .regex(signedFinancialQuantityPattern)
  .refine((value) => value !== "-0")
  .refine((value) => value.replaceAll(/[.-]/g, "").length <= 38);

export const referenceMarketDataParamsSchema = z.strictObject({
  marketCode: referenceMarketCodeSchema,
});

export const referenceMarketDataTickerQuerySchema = z.strictObject({});

export const referenceMarketDataCandlesQuerySchema = z.strictObject({
  interval: referenceMarketDataCandleIntervalSchema.default("5m"),
  limit: z
    .string()
    .regex(candleLimitPattern)
    .transform(Number)
    .default(defaultReferenceMarketDataCandleLimit),
});

const referenceMetadataSchema = z.strictObject({
  source: referenceMarketDataSourceSchema,
  freshness: referenceMarketDataFreshnessSchema,
  observedAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});

export const referenceMarketDataTickerResponseSchema = z.strictObject({
  success: z.literal(true),
  data: referenceMetadataSchema.extend({
    marketCode: referenceMarketCodeSchema,
    price: positiveFinancialQuantitySchema,
    priceChange24hPercent: signedFinancialQuantitySchema,
    highPrice24h: positiveFinancialQuantitySchema,
    lowPrice24h: positiveFinancialQuantitySchema,
    baseVolume24h: financialQuantitySchema,
  }),
});

export const referenceMarketDataCandleSchema = z
  .strictObject({
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    openPrice: positiveFinancialQuantitySchema,
    highPrice: positiveFinancialQuantitySchema,
    lowPrice: positiveFinancialQuantitySchema,
    closePrice: positiveFinancialQuantitySchema,
    baseVolume: financialQuantitySchema,
  })
  .superRefine((candle, context) => {
    const start = Date.parse(candle.start);
    const end = Date.parse(candle.end);
    if (start % (5 * 60_000) !== 0 || end - start !== 5 * 60_000) {
      context.addIssue({
        code: "custom",
        message: "Reference candle must be five-minute aligned.",
      });
    }
    const prices = [candle.openPrice, candle.closePrice];
    if (
      compareDecimals(candle.highPrice, candle.lowPrice) < 0 ||
      prices.some(
        (price) =>
          compareDecimals(price, candle.lowPrice) < 0 ||
          compareDecimals(price, candle.highPrice) > 0,
      )
    ) {
      context.addIssue({ code: "custom", message: "Reference candle prices must reconcile." });
    }
  });

export const referenceMarketDataCandlesResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: referenceMetadataSchema.extend({
      marketCode: referenceMarketCodeSchema,
      interval: referenceMarketDataCandleIntervalSchema,
      candles: z.array(referenceMarketDataCandleSchema).max(maximumReferenceMarketDataCandleLimit),
    }),
  })
  .superRefine((response, context) => {
    if (
      response.data.candles.some((candle, index, candles) => {
        const previous = candles[index - 1];
        return previous !== undefined && Date.parse(previous.start) >= Date.parse(candle.start);
      })
    ) {
      context.addIssue({ code: "custom", message: "Reference candles must use ascending order." });
    }
  });

export const referenceMarketDataApiErrorCodeSchema = z.enum([
  "INTERNAL_SERVER_ERROR",
  "RATE_LIMITED",
  "REFERENCE_DATA_UNAVAILABLE",
  "VALIDATION_FAILED",
]);

export const referenceMarketDataApiErrorResponseSchema = z.strictObject({
  success: z.literal(false),
  error: z.strictObject({
    code: referenceMarketDataApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

function compareDecimals(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(leftWhole + leftFraction.padEnd(scale, "0"));
  const rightValue = BigInt(rightWhole + rightFraction.padEnd(scale, "0"));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export type ReferenceMarketCode = z.infer<typeof referenceMarketCodeSchema>;
export type ReferenceMarketDataFreshness = z.infer<typeof referenceMarketDataFreshnessSchema>;
export type ReferenceMarketDataTickerResponse = z.infer<
  typeof referenceMarketDataTickerResponseSchema
>;
export type ReferenceMarketDataCandle = z.infer<typeof referenceMarketDataCandleSchema>;
export type ReferenceMarketDataCandlesResponse = z.infer<
  typeof referenceMarketDataCandlesResponseSchema
>;
export type ReferenceMarketDataApiErrorCode = z.infer<typeof referenceMarketDataApiErrorCodeSchema>;
export type ReferenceMarketDataApiErrorResponse = z.infer<
  typeof referenceMarketDataApiErrorResponseSchema
>;
