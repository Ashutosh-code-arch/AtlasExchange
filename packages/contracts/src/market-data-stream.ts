import { z } from "zod";

import {
  marketDataCandleIntervalSchema,
  marketDataCandlesResponseSchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerResponseSchema,
  maximumMarketDataCandleLimit,
  maximumMarketDataOrderBookDepth,
} from "./market-data.js";
import { tradingMarketCodeSchema } from "./trading.js";

export const marketDataStreamProtocol = "atlas.market-data.v1" as const;
export const marketDataStreamEndpoint = "/api/v1/market-data/stream" as const;

export const marketDataStreamRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const marketDataStreamSubscriptionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const marketDataStreamOrderBookSubscriptionSchema = z.strictObject({
  id: marketDataStreamSubscriptionIdSchema,
  topic: z.literal("order_book"),
  marketCode: tradingMarketCodeSchema,
  depth: z.number().int().min(1).max(maximumMarketDataOrderBookDepth),
});

export const marketDataStreamTickerSubscriptionSchema = z.strictObject({
  id: marketDataStreamSubscriptionIdSchema,
  topic: z.literal("ticker"),
  marketCode: tradingMarketCodeSchema,
});

export const marketDataStreamCandlesSubscriptionSchema = z.strictObject({
  id: marketDataStreamSubscriptionIdSchema,
  topic: z.literal("candles"),
  marketCode: tradingMarketCodeSchema,
  interval: marketDataCandleIntervalSchema,
  limit: z.number().int().min(1).max(maximumMarketDataCandleLimit),
});

export const marketDataStreamSubscriptionSchema = z.discriminatedUnion("topic", [
  marketDataStreamOrderBookSubscriptionSchema,
  marketDataStreamTickerSubscriptionSchema,
  marketDataStreamCandlesSubscriptionSchema,
]);

export const marketDataStreamSubscribeMessageSchema = z.strictObject({
  type: z.literal("subscribe"),
  requestId: marketDataStreamRequestIdSchema,
  subscription: marketDataStreamSubscriptionSchema,
});

export const marketDataStreamUnsubscribeMessageSchema = z.strictObject({
  type: z.literal("unsubscribe"),
  requestId: marketDataStreamRequestIdSchema,
  subscriptionId: marketDataStreamSubscriptionIdSchema,
});

export const marketDataStreamClientMessageSchema = z.discriminatedUnion("type", [
  marketDataStreamSubscribeMessageSchema,
  marketDataStreamUnsubscribeMessageSchema,
]);

export const marketDataStreamWelcomeMessageSchema = z.strictObject({
  type: z.literal("welcome"),
  protocol: z.literal(marketDataStreamProtocol),
  serverTime: z.iso.datetime(),
  heartbeatIntervalMs: z.number().int().positive(),
  maximumSubscriptions: z.number().int().positive(),
});

export const marketDataStreamSubscribedMessageSchema = z.strictObject({
  type: z.literal("subscribed"),
  requestId: marketDataStreamRequestIdSchema,
  subscription: marketDataStreamSubscriptionSchema,
});

export const marketDataStreamUnsubscribedMessageSchema = z.strictObject({
  type: z.literal("unsubscribed"),
  requestId: marketDataStreamRequestIdSchema,
  subscriptionId: marketDataStreamSubscriptionIdSchema,
});

export const marketDataStreamOrderBookSnapshotMessageSchema = z.strictObject({
  type: z.literal("snapshot"),
  subscriptionId: marketDataStreamSubscriptionIdSchema,
  topic: z.literal("order_book"),
  data: marketDataOrderBookResponseSchema.shape.data,
});

export const marketDataStreamTickerSnapshotMessageSchema = z.strictObject({
  type: z.literal("snapshot"),
  subscriptionId: marketDataStreamSubscriptionIdSchema,
  topic: z.literal("ticker"),
  data: marketDataTickerResponseSchema.shape.data,
});

export const marketDataStreamCandlesSnapshotMessageSchema = z.strictObject({
  type: z.literal("snapshot"),
  subscriptionId: marketDataStreamSubscriptionIdSchema,
  topic: z.literal("candles"),
  data: marketDataCandlesResponseSchema.shape.data,
});

export const marketDataStreamSnapshotMessageSchema = z.discriminatedUnion("topic", [
  marketDataStreamOrderBookSnapshotMessageSchema,
  marketDataStreamTickerSnapshotMessageSchema,
  marketDataStreamCandlesSnapshotMessageSchema,
]);

export const marketDataStreamHeartbeatMessageSchema = z.strictObject({
  type: z.literal("heartbeat"),
  serverTime: z.iso.datetime(),
});

export const marketDataStreamErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "MARKET_NOT_FOUND",
  "SUBSCRIPTION_CONFLICT",
  "SUBSCRIPTION_LIMIT",
  "STREAM_UNAVAILABLE",
]);

export const marketDataStreamErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  requestId: marketDataStreamRequestIdSchema.nullable(),
  subscriptionId: marketDataStreamSubscriptionIdSchema.nullable(),
  code: marketDataStreamErrorCodeSchema,
  message: z.string().min(1).max(160),
});

export const marketDataStreamServerMessageSchema = z.union([
  marketDataStreamWelcomeMessageSchema,
  marketDataStreamSubscribedMessageSchema,
  marketDataStreamUnsubscribedMessageSchema,
  marketDataStreamSnapshotMessageSchema,
  marketDataStreamHeartbeatMessageSchema,
  marketDataStreamErrorMessageSchema,
]);

export type MarketDataStreamRequestId = z.infer<typeof marketDataStreamRequestIdSchema>;
export type MarketDataStreamSubscriptionId = z.infer<typeof marketDataStreamSubscriptionIdSchema>;
export type MarketDataStreamOrderBookSubscription = z.infer<
  typeof marketDataStreamOrderBookSubscriptionSchema
>;
export type MarketDataStreamTickerSubscription = z.infer<
  typeof marketDataStreamTickerSubscriptionSchema
>;
export type MarketDataStreamCandlesSubscription = z.infer<
  typeof marketDataStreamCandlesSubscriptionSchema
>;
export type MarketDataStreamSubscription = z.infer<typeof marketDataStreamSubscriptionSchema>;
export type MarketDataStreamSubscribeMessage = z.infer<
  typeof marketDataStreamSubscribeMessageSchema
>;
export type MarketDataStreamUnsubscribeMessage = z.infer<
  typeof marketDataStreamUnsubscribeMessageSchema
>;
export type MarketDataStreamClientMessage = z.infer<typeof marketDataStreamClientMessageSchema>;
export type MarketDataStreamWelcomeMessage = z.infer<typeof marketDataStreamWelcomeMessageSchema>;
export type MarketDataStreamSubscribedMessage = z.infer<
  typeof marketDataStreamSubscribedMessageSchema
>;
export type MarketDataStreamUnsubscribedMessage = z.infer<
  typeof marketDataStreamUnsubscribedMessageSchema
>;
export type MarketDataStreamSnapshotMessage = z.infer<typeof marketDataStreamSnapshotMessageSchema>;
export type MarketDataStreamHeartbeatMessage = z.infer<
  typeof marketDataStreamHeartbeatMessageSchema
>;
export type MarketDataStreamErrorCode = z.infer<typeof marketDataStreamErrorCodeSchema>;
export type MarketDataStreamErrorMessage = z.infer<typeof marketDataStreamErrorMessageSchema>;
export type MarketDataStreamServerMessage = z.infer<typeof marketDataStreamServerMessageSchema>;
