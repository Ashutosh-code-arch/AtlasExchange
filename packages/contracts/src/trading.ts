import { z } from "zod";

import {
  financialAssetCodeSchema,
  financialIdempotencyKeySchema,
  financialQuantitySchema,
  positiveFinancialQuantitySchema,
} from "./financial.js";

const marketCodePattern = /^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
const pageLimitPattern = /^(?:[1-9]|[1-9]\d|100)$/;

function decimalParts(value: string): readonly [string, string] {
  const [whole = "0", fraction = ""] = value.split(".");
  return [whole, fraction];
}

function scaledDecimal(value: string, scale: number): bigint {
  const [whole, fraction] = decimalParts(value);
  return BigInt(whole + fraction.padEnd(scale, "0"));
}

function decimalEqualsSum(total: string, left: string, right: string): boolean {
  const scale = Math.max(...[total, left, right].map((value) => decimalParts(value)[1].length));
  return scaledDecimal(total, scale) === scaledDecimal(left, scale) + scaledDecimal(right, scale);
}

function compareDecimals(left: string, right: string): number {
  const scale = Math.max(decimalParts(left)[1].length, decimalParts(right)[1].length);
  const leftValue = scaledDecimal(left, scale);
  const rightValue = scaledDecimal(right, scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function decimalSumDoesNotExceed(values: readonly string[], maximum: string): boolean {
  const scale = Math.max(
    decimalParts(maximum)[1].length,
    ...values.map((value) => decimalParts(value)[1].length),
  );
  const sum = values.reduce((total, value) => total + scaledDecimal(value, scale), 0n);
  return sum <= scaledDecimal(maximum, scale);
}

function isExactMultiple(value: string, increment: string): boolean {
  const scale = Math.max(decimalParts(value)[1].length, decimalParts(increment)[1].length);
  return scaledDecimal(value, scale) % scaledDecimal(increment, scale) === 0n;
}

function addCustomIssue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}

export const tradingMarketCodeSchema = z
  .string()
  .regex(marketCodePattern)
  .refine((value) => {
    const [base = "", quote = ""] = value.split("-");
    return base !== quote && /[A-Z]/.test(base) && /[A-Z]/.test(quote);
  });

export const tradingMarketStatusSchema = z.enum(["active", "cancel_only", "disabled"]);
export const tradingOrderSideSchema = z.enum(["buy", "sell"]);
export const tradingOrderStatusSchema = z.enum(["open", "partially_filled", "filled", "cancelled"]);
export const tradingOrderTerminalReasonSchema = z.enum([
  "owner_cancelled",
  "self_trade_prevention",
]);
export const tradingLiquidityRoleSchema = z.enum(["maker", "taker"]);
export const tradingIdempotencyKeySchema = financialIdempotencyKeySchema;
export const tradingCursorSchema = z.string().regex(cursorPattern);

export const tradingPageSchema = z.strictObject({
  nextCursor: tradingCursorSchema.nullable(),
});

export const tradingMarketSchema = z
  .strictObject({
    code: tradingMarketCodeSchema,
    baseAssetCode: financialAssetCodeSchema,
    quoteAssetCode: financialAssetCodeSchema,
    baseLotSize: positiveFinancialQuantitySchema,
    priceTickSize: positiveFinancialQuantitySchema,
    minimumQuantity: positiveFinancialQuantitySchema,
    maximumQuantity: positiveFinancialQuantitySchema,
    status: tradingMarketStatusSchema,
  })
  .superRefine((market, context) => {
    if (market.code !== `${market.baseAssetCode}-${market.quoteAssetCode}`) {
      addCustomIssue(context, "Market code must agree with its asset pair.");
    }
    if (
      compareDecimals(market.minimumQuantity, market.maximumQuantity) > 0 ||
      !isExactMultiple(market.minimumQuantity, market.baseLotSize) ||
      !isExactMultiple(market.maximumQuantity, market.baseLotSize)
    ) {
      addCustomIssue(context, "Market quantity bounds must align with the base lot size.");
    }
  });

export const tradingMarketListResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      markets: z.array(tradingMarketSchema),
    }),
  })
  .superRefine((response, context) => {
    const codes = response.data.markets.map(({ code }) => code);
    const sortedCodes = [...codes].sort((left, right) => left.localeCompare(right));
    if (
      new Set(codes).size !== codes.length ||
      codes.some((code, index) => code !== sortedCodes[index])
    ) {
      addCustomIssue(context, "Markets must be unique and ordered by code.");
    }
  });

export const tradingMarketParamsSchema = z.strictObject({
  marketCode: tradingMarketCodeSchema,
});

export const tradingMarketResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    market: tradingMarketSchema,
  }),
});

export const placeOrderRequestSchema = z.strictObject({
  marketCode: tradingMarketCodeSchema,
  side: tradingOrderSideSchema,
  quantity: positiveFinancialQuantitySchema,
  limitPrice: positiveFinancialQuantitySchema,
});

export const placeOrderHeadersSchema = z.strictObject({
  "idempotency-key": tradingIdempotencyKeySchema,
});

export const tradingOrderParamsSchema = z.strictObject({
  orderId: z.uuid(),
});

export const cancelOrderParamsSchema = tradingOrderParamsSchema;

export const tradingOrderSchema = z
  .strictObject({
    id: z.uuid(),
    marketCode: tradingMarketCodeSchema,
    side: tradingOrderSideSchema,
    type: z.literal("limit"),
    timeInForce: z.literal("good_til_cancelled"),
    quantity: positiveFinancialQuantitySchema,
    limitPrice: positiveFinancialQuantitySchema,
    filledQuantity: financialQuantitySchema,
    remainingQuantity: financialQuantitySchema,
    status: tradingOrderStatusSchema,
    terminalReason: tradingOrderTerminalReasonSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((order, context) => {
    if (!decimalEqualsSum(order.quantity, order.filledQuantity, order.remainingQuantity)) {
      addCustomIssue(context, "Order quantities must reconcile.");
    }
    const lifecycleIsValid =
      (order.status === "open" &&
        order.filledQuantity === "0" &&
        order.remainingQuantity !== "0" &&
        order.terminalReason === null) ||
      (order.status === "partially_filled" &&
        order.filledQuantity !== "0" &&
        order.remainingQuantity !== "0" &&
        order.terminalReason === null) ||
      (order.status === "filled" &&
        order.filledQuantity === order.quantity &&
        order.remainingQuantity === "0" &&
        order.terminalReason === null) ||
      (order.status === "cancelled" &&
        order.remainingQuantity !== "0" &&
        order.terminalReason !== null);
    if (!lifecycleIsValid) {
      addCustomIssue(context, "Order lifecycle fields are inconsistent.");
    }
    if (Date.parse(order.updatedAt) < Date.parse(order.createdAt)) {
      addCustomIssue(context, "Order update time cannot precede creation time.");
    }
  });

const pageLimitSchema = z.string().regex(pageLimitPattern).transform(Number).default(50);

export const tradingOrderListQuerySchema = z.strictObject({
  marketCode: tradingMarketCodeSchema.optional(),
  status: tradingOrderStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: tradingCursorSchema.optional(),
});

export const tradingOrderResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    order: tradingOrderSchema,
  }),
});

export const cancelOrderResponseSchema = tradingOrderResponseSchema;

export const tradingOrderListResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      orders: z.array(tradingOrderSchema),
      page: tradingPageSchema,
    }),
  })
  .superRefine((response, context) => {
    const { orders } = response.data;
    const ids = orders.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      addCustomIssue(context, "Order list cannot contain duplicate resources.");
    }
    if (
      orders.some((order, index) => {
        const previous = orders[index - 1];
        if (previous === undefined) return false;
        const timestampOrder = previous.createdAt.localeCompare(order.createdAt);
        return (
          timestampOrder < 0 || (timestampOrder === 0 && previous.id.localeCompare(order.id) < 0)
        );
      })
    ) {
      addCustomIssue(context, "Orders must use descending creation-time and ID order.");
    }
  });

export const tradingTradeSchema = z.strictObject({
  id: z.uuid(),
  marketCode: tradingMarketCodeSchema,
  orderId: z.uuid(),
  side: tradingOrderSideSchema,
  liquidityRole: tradingLiquidityRoleSchema,
  quantity: positiveFinancialQuantitySchema,
  price: positiveFinancialQuantitySchema,
  quoteAmount: positiveFinancialQuantitySchema,
  executedAt: z.iso.datetime(),
});

export const tradingTradeListQuerySchema = z.strictObject({
  marketCode: tradingMarketCodeSchema.optional(),
  limit: pageLimitSchema,
  cursor: tradingCursorSchema.optional(),
});

export const tradingTradeListResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      trades: z.array(tradingTradeSchema),
      page: tradingPageSchema,
    }),
  })
  .superRefine((response, context) => {
    const { trades } = response.data;
    const ids = trades.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      addCustomIssue(context, "Trade list cannot contain duplicate resources.");
    }
    if (
      trades.some((trade, index) => {
        const previous = trades[index - 1];
        return previous !== undefined && previous.executedAt.localeCompare(trade.executedAt) < 0;
      })
    ) {
      addCustomIssue(context, "Trades must use descending execution-time order.");
    }
  });

export const placeOrderResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      order: tradingOrderSchema,
      trades: z.array(tradingTradeSchema),
    }),
  })
  .superRefine((response, context) => {
    const tradeIds = response.data.trades.map(({ id }) => id);
    if (
      response.data.trades.some(
        (trade) =>
          trade.orderId !== response.data.order.id ||
          trade.marketCode !== response.data.order.marketCode ||
          trade.side !== response.data.order.side ||
          trade.liquidityRole !== "taker",
      )
    ) {
      addCustomIssue(context, "Placement trades must belong to the returned taker order.");
    }
    if (new Set(tradeIds).size !== tradeIds.length) {
      addCustomIssue(context, "Placement trades must be unique.");
    }
    if (
      !decimalSumDoesNotExceed(
        response.data.trades.map(({ quantity }) => quantity),
        response.data.order.filledQuantity,
      )
    ) {
      addCustomIssue(
        context,
        "Placement trade quantity cannot exceed the order's filled quantity.",
      );
    }
    if (
      response.data.trades.some((trade, index) => {
        const previous = response.data.trades[index - 1];
        return previous !== undefined && previous.executedAt.localeCompare(trade.executedAt) > 0;
      })
    ) {
      addCustomIssue(context, "Placement trades must use execution order.");
    }
  });

export const tradingApiErrorCodeSchema = z.enum([
  "ASSET_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "CSRF_FAILED",
  "FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "INSUFFICIENT_AVAILABLE_BALANCE",
  "INTERNAL_SERVER_ERROR",
  "MARKET_NOT_ACTIVE",
  "MARKET_NOT_FOUND",
  "ORDER_NOT_CANCELLABLE",
  "ORDER_NOT_FOUND",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "WALLET_NOT_FOUND",
]);

export const tradingApiErrorResponseSchema = z.strictObject({
  success: z.literal(false),
  error: z.strictObject({
    code: tradingApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

export type TradingMarketCode = z.infer<typeof tradingMarketCodeSchema>;
export type TradingMarketStatus = z.infer<typeof tradingMarketStatusSchema>;
export type TradingOrderSide = z.infer<typeof tradingOrderSideSchema>;
export type TradingOrderStatus = z.infer<typeof tradingOrderStatusSchema>;
export type TradingOrderTerminalReason = z.infer<typeof tradingOrderTerminalReasonSchema>;
export type TradingLiquidityRole = z.infer<typeof tradingLiquidityRoleSchema>;
export type TradingIdempotencyKey = z.infer<typeof tradingIdempotencyKeySchema>;
export type TradingCursor = z.infer<typeof tradingCursorSchema>;
export type TradingPage = z.infer<typeof tradingPageSchema>;
export type TradingMarket = z.infer<typeof tradingMarketSchema>;
export type TradingMarketListResponse = z.infer<typeof tradingMarketListResponseSchema>;
export type TradingMarketParams = z.infer<typeof tradingMarketParamsSchema>;
export type TradingMarketResponse = z.infer<typeof tradingMarketResponseSchema>;
export type PlaceOrderRequest = z.infer<typeof placeOrderRequestSchema>;
export type PlaceOrderHeaders = z.infer<typeof placeOrderHeadersSchema>;
export type TradingOrderParams = z.infer<typeof tradingOrderParamsSchema>;
export type CancelOrderParams = z.infer<typeof cancelOrderParamsSchema>;
export type TradingOrder = z.infer<typeof tradingOrderSchema>;
export type TradingOrderListQuery = z.infer<typeof tradingOrderListQuerySchema>;
export type TradingOrderResponse = z.infer<typeof tradingOrderResponseSchema>;
export type CancelOrderResponse = z.infer<typeof cancelOrderResponseSchema>;
export type TradingOrderListResponse = z.infer<typeof tradingOrderListResponseSchema>;
export type TradingTrade = z.infer<typeof tradingTradeSchema>;
export type TradingTradeListQuery = z.infer<typeof tradingTradeListQuerySchema>;
export type TradingTradeListResponse = z.infer<typeof tradingTradeListResponseSchema>;
export type PlaceOrderResponse = z.infer<typeof placeOrderResponseSchema>;
export type TradingApiErrorCode = z.infer<typeof tradingApiErrorCodeSchema>;
export type TradingApiErrorResponse = z.infer<typeof tradingApiErrorResponseSchema>;
