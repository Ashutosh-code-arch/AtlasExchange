import { z } from "zod";

import { financialQuantitySchema, positiveFinancialQuantitySchema } from "./financial.js";
import { tradingMarketCodeSchema } from "./trading.js";

const depthPattern = /^(?:[1-9]|[1-9]\d|100)$/;
const candleLimitPattern = /^(?:[1-9]|[1-9]\d|[1-4]\d{2}|500)$/;
const nonNegativeIntegerTextSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
const positiveIntegerTextSchema = z.string().regex(/^[1-9]\d*$/);

export const marketDataCandleIntervals = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export const defaultMarketDataCandleLimit = 200;
export const maximumMarketDataCandleLimit = 500;

const candleIntervalMilliseconds = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
} as const;

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

export const marketDataCandleIntervalSchema = z.enum(marketDataCandleIntervals);

export const marketDataCandleParamsSchema = z.strictObject({
  marketCode: tradingMarketCodeSchema,
});

export const marketDataCandleQuerySchema = z
  .strictObject({
    interval: marketDataCandleIntervalSchema,
    limit: z
      .string()
      .regex(candleLimitPattern)
      .transform(Number)
      .default(defaultMarketDataCandleLimit),
    before: z.iso.datetime().optional(),
  })
  .superRefine((query, context) => {
    if (
      query.before !== undefined &&
      Date.parse(query.before) % candleIntervalMilliseconds[query.interval] !== 0
    ) {
      context.addIssue({ code: "custom", message: "Candle cursor must be interval aligned." });
    }
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

export const marketDataCandleSchema = z.strictObject({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  openPrice: positiveFinancialQuantitySchema,
  highPrice: positiveFinancialQuantitySchema,
  lowPrice: positiveFinancialQuantitySchema,
  closePrice: positiveFinancialQuantitySchema,
  baseVolume: positiveFinancialQuantitySchema,
  quoteVolume: positiveFinancialQuantitySchema,
  tradeCount: positiveIntegerTextSchema,
  closed: z.boolean(),
});

export const marketDataCandlesResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      marketCode: tradingMarketCodeSchema,
      interval: marketDataCandleIntervalSchema,
      limit: z.number().int().min(1).max(maximumMarketDataCandleLimit),
      sequence: nonNegativeIntegerTextSchema,
      publishedSequence: nonNegativeIntegerTextSchema,
      lag: nonNegativeIntegerTextSchema,
      freshness: marketDataOrderBookFreshnessSchema,
      asOf: z.iso.datetime().nullable(),
      generatedAt: z.iso.datetime(),
      candles: z.array(marketDataCandleSchema).max(maximumMarketDataCandleLimit),
      nextBefore: z.iso.datetime().nullable(),
    }),
  })
  .superRefine((response, context) => {
    const snapshot = response.data;
    if (BigInt(snapshot.publishedSequence) !== BigInt(snapshot.sequence) + BigInt(snapshot.lag)) {
      context.addIssue({ code: "custom", message: "Candle sequence metadata must reconcile." });
    }
    if ((snapshot.lag === "0") !== (snapshot.freshness === "current")) {
      context.addIssue({ code: "custom", message: "Candle freshness must agree with lag." });
    }
    if ((snapshot.sequence === "0") !== (snapshot.asOf === null)) {
      context.addIssue({ code: "custom", message: "Candle timestamp must agree with sequence." });
    }
    if (snapshot.candles.length > snapshot.limit) {
      context.addIssue({ code: "custom", message: "Candles cannot exceed the requested limit." });
    }

    const generatedAt = Date.parse(snapshot.generatedAt);
    const duration = candleIntervalMilliseconds[snapshot.interval];
    for (const [index, candle] of snapshot.candles.entries()) {
      const start = Date.parse(candle.start);
      const end = Date.parse(candle.end);
      if (start % duration !== 0 || end - start !== duration) {
        context.addIssue({ code: "custom", message: "Candle boundaries must be UTC aligned." });
      }
      const previous = snapshot.candles[index - 1];
      if (previous !== undefined && Date.parse(previous.start) >= start) {
        context.addIssue({ code: "custom", message: "Candles must use strict ascending order." });
      }
      if (candle.closed !== end <= generatedAt) {
        context.addIssue({
          code: "custom",
          message: "Candle closed state must match generation time.",
        });
      }
      if (generatedAt < start) {
        context.addIssue({ code: "custom", message: "Candle cannot begin after generation time." });
      }
      if (
        compareDecimals(candle.highPrice, candle.lowPrice) < 0 ||
        compareDecimals(candle.openPrice, candle.lowPrice) < 0 ||
        compareDecimals(candle.openPrice, candle.highPrice) > 0 ||
        compareDecimals(candle.closePrice, candle.lowPrice) < 0 ||
        compareDecimals(candle.closePrice, candle.highPrice) > 0
      ) {
        context.addIssue({ code: "custom", message: "Candle prices must reconcile." });
      }
    }
    const first = snapshot.candles[0];
    if (
      snapshot.nextBefore !== null &&
      (first === undefined || snapshot.nextBefore !== first.start)
    ) {
      context.addIssue({
        code: "custom",
        message: "Candle cursor must match the earliest candle.",
      });
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
export type MarketDataCandleInterval = z.infer<typeof marketDataCandleIntervalSchema>;
export type MarketDataCandleParams = z.infer<typeof marketDataCandleParamsSchema>;
export type MarketDataCandleQuery = z.infer<typeof marketDataCandleQuerySchema>;
export type MarketDataCandle = z.infer<typeof marketDataCandleSchema>;
export type MarketDataCandlesResponse = z.infer<typeof marketDataCandlesResponseSchema>;
export type MarketDataTickerParams = z.infer<typeof marketDataTickerParamsSchema>;
export type MarketDataTickerQuery = z.infer<typeof marketDataTickerQuerySchema>;
export type MarketDataTickerResponse = z.infer<typeof marketDataTickerResponseSchema>;
export type MarketDataApiErrorCode = z.infer<typeof marketDataApiErrorCodeSchema>;
export type MarketDataApiErrorResponse = z.infer<typeof marketDataApiErrorResponseSchema>;
