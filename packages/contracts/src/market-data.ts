import { z } from "zod";

import { positiveFinancialQuantitySchema } from "./financial.js";
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
export type MarketDataApiErrorCode = z.infer<typeof marketDataApiErrorCodeSchema>;
export type MarketDataApiErrorResponse = z.infer<typeof marketDataApiErrorResponseSchema>;
