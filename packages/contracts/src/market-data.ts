import { z } from "zod";

import { financialQuantitySchema, positiveFinancialQuantitySchema } from "./financial.js";
import { tradingMarketCodeSchema } from "./trading.js";

const depthPattern = /^(?:[1-9]|[1-9]\d|100)$/;
const nonNegativeIntegerTextSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
const positiveIntegerTextSchema = z.string().regex(/^[1-9]\d*$/);

function compareDecimals(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(leftWhole + leftFraction.padEnd(scale, "0"));
  const rightValue = BigInt(rightWhole + rightFraction.padEnd(scale, "0"));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export const defaultMarketDataOrderBookDepth = 20;
export const maximumMarketDataOrderBookDepth = 100;

export const marketDataOrderBookParamsSchema = z.strictObject({
  marketCode: tradingMarketCodeSchema,
});

export const marketDataTickerParamsSchema = z.strictObject({
  marketCode: tradingMarketCodeSchema,
});

export const marketDataTickerQuerySchema = z.strictObject({});

export const marketDataOrderBookQuerySchema = z.strictObject({
  depth: z.string().regex(depthPattern).transform(Number).default(defaultMarketDataOrderBookDepth),
});

export const marketDataOrderBookFreshnessSchema = z.enum(["current", "behind"]);

export const marketDataOrderBookLevelSchema = z.strictObject({
  price: positiveFinancialQuantitySchema,
  quantity: positiveFinancialQuantitySchema,
  orderCount: positiveIntegerTextSchema,
});

export const marketDataOrderBookResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      marketCode: tradingMarketCodeSchema,
      depth: z.number().int().min(1).max(maximumMarketDataOrderBookDepth),
      sequence: nonNegativeIntegerTextSchema,
      publishedSequence: nonNegativeIntegerTextSchema,
      lag: nonNegativeIntegerTextSchema,
      freshness: marketDataOrderBookFreshnessSchema,
      asOf: z.iso.datetime().nullable(),
      generatedAt: z.iso.datetime(),
      bids: z.array(marketDataOrderBookLevelSchema),
      asks: z.array(marketDataOrderBookLevelSchema),
    }),
  })
  .superRefine((response, context) => {
    const snapshot = response.data;
    if (BigInt(snapshot.publishedSequence) !== BigInt(snapshot.sequence) + BigInt(snapshot.lag)) {
      context.addIssue({ code: "custom", message: "Order-book sequence metadata must reconcile." });
    }
    if ((snapshot.lag === "0") !== (snapshot.freshness === "current")) {
      context.addIssue({ code: "custom", message: "Order-book freshness must agree with lag." });
    }
    if ((snapshot.sequence === "0") !== (snapshot.asOf === null)) {
      context.addIssue({
        code: "custom",
        message: "Order-book timestamp must agree with sequence.",
      });
    }
    for (const [side, levels, direction] of [
      ["Bids", snapshot.bids, 1],
      ["Asks", snapshot.asks, -1],
    ] as const) {
      if (levels.length > snapshot.depth) {
        context.addIssue({ code: "custom", message: `${side} cannot exceed requested depth.` });
      }
      if (
        levels.some((level, index) => {
          const previous = levels[index - 1];
          return (
            previous !== undefined && compareDecimals(previous.price, level.price) !== direction
          );
        })
      ) {
        context.addIssue({ code: "custom", message: `${side} must use strict price order.` });
      }
    }
  });

export const marketDataTickerResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      marketCode: tradingMarketCodeSchema,
      sequence: nonNegativeIntegerTextSchema,
      publishedSequence: nonNegativeIntegerTextSchema,
      lag: nonNegativeIntegerTextSchema,
      freshness: marketDataOrderBookFreshnessSchema,
      asOf: z.iso.datetime().nullable(),
      generatedAt: z.iso.datetime(),
      windowStart: z.iso.datetime(),
      windowEnd: z.iso.datetime(),
      lastPrice: positiveFinancialQuantitySchema.nullable(),
      lastQuantity: positiveFinancialQuantitySchema.nullable(),
      lastExecutedAt: z.iso.datetime().nullable(),
      highPrice: positiveFinancialQuantitySchema.nullable(),
      lowPrice: positiveFinancialQuantitySchema.nullable(),
      baseVolume: financialQuantitySchema,
      quoteVolume: financialQuantitySchema,
    }),
  })
  .superRefine((response, context) => {
    const ticker = response.data;
    if (BigInt(ticker.publishedSequence) !== BigInt(ticker.sequence) + BigInt(ticker.lag)) {
      context.addIssue({ code: "custom", message: "Ticker sequence metadata must reconcile." });
    }
    if ((ticker.lag === "0") !== (ticker.freshness === "current")) {
      context.addIssue({ code: "custom", message: "Ticker freshness must agree with lag." });
    }
    if ((ticker.sequence === "0") !== (ticker.asOf === null)) {
      context.addIssue({ code: "custom", message: "Ticker timestamp must agree with sequence." });
    }
    const windowStart = Date.parse(ticker.windowStart);
    const windowEnd = Date.parse(ticker.windowEnd);
    if (windowEnd - windowStart !== 24 * 60 * 60 * 1_000) {
      context.addIssue({ code: "custom", message: "Ticker window must span exactly 24 hours." });
    }
    if (ticker.generatedAt !== ticker.windowEnd) {
      context.addIssue({
        code: "custom",
        message: "Ticker generation time must close its window.",
      });
    }
    const nullableTradeValues = [
      ticker.lastPrice,
      ticker.lastQuantity,
      ticker.lastExecutedAt,
      ticker.highPrice,
      ticker.lowPrice,
    ];
    const hasTrades = ticker.lastPrice !== null;
    if (nullableTradeValues.some((value) => (value !== null) !== hasTrades)) {
      context.addIssue({
        code: "custom",
        message: "Ticker trade values must be present together.",
      });
      return;
    }
    if (!hasTrades) {
      if (ticker.baseVolume !== "0" || ticker.quoteVolume !== "0") {
        context.addIssue({
          code: "custom",
          message: "An empty ticker window must have zero volume.",
        });
      }
      return;
    }
    if (ticker.baseVolume === "0" || ticker.quoteVolume === "0") {
      context.addIssue({ code: "custom", message: "A populated ticker window must have volume." });
    }
    if (
      ticker.lastExecutedAt !== null &&
      (Date.parse(ticker.lastExecutedAt) < windowStart ||
        Date.parse(ticker.lastExecutedAt) > windowEnd)
    ) {
      context.addIssue({
        code: "custom",
        message: "Last trade must fall inside the ticker window.",
      });
    }
    if (
      ticker.highPrice !== null &&
      ticker.lowPrice !== null &&
      ticker.lastPrice !== null &&
      (compareDecimals(ticker.highPrice, ticker.lowPrice) < 0 ||
        compareDecimals(ticker.lastPrice, ticker.lowPrice) < 0 ||
        compareDecimals(ticker.lastPrice, ticker.highPrice) > 0)
    ) {
      context.addIssue({ code: "custom", message: "Ticker prices must reconcile." });
    }
  });

export const marketDataApiErrorCodeSchema = z.enum([
  "INTERNAL_SERVER_ERROR",
  "MARKET_NOT_FOUND",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
]);

export const marketDataApiErrorResponseSchema = z.strictObject({
  success: z.literal(false),
  error: z.strictObject({
    code: marketDataApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

export type MarketDataOrderBookParams = z.infer<typeof marketDataOrderBookParamsSchema>;
export type MarketDataOrderBookQuery = z.infer<typeof marketDataOrderBookQuerySchema>;
export type MarketDataOrderBookFreshness = z.infer<typeof marketDataOrderBookFreshnessSchema>;
export type MarketDataOrderBookLevel = z.infer<typeof marketDataOrderBookLevelSchema>;
export type MarketDataOrderBookResponse = z.infer<typeof marketDataOrderBookResponseSchema>;
export type MarketDataTickerParams = z.infer<typeof marketDataTickerParamsSchema>;
export type MarketDataTickerQuery = z.infer<typeof marketDataTickerQuerySchema>;
export type MarketDataTickerResponse = z.infer<typeof marketDataTickerResponseSchema>;
export type MarketDataApiErrorCode = z.infer<typeof marketDataApiErrorCodeSchema>;
export type MarketDataApiErrorResponse = z.infer<typeof marketDataApiErrorResponseSchema>;
