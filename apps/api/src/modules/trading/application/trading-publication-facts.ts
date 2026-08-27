import { z } from "zod";

import type { MarketCode } from "../domain/market.js";

export const tradingPublicationFactSchemaVersion = 1 as const;
export const maximumTradingPublicationFactPageSize = 1_000;

const positiveIntegerTextSchema = z.string().regex(/^[1-9]\d*$/);
const nonNegativeIntegerTextSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);

const orderStatePayloadSchema = z
  .object({
    orderId: z.uuid(),
    side: z.enum(["buy", "sell"]),
    limitPriceTicks: positiveIntegerTextSchema,
    remainingLots: nonNegativeIntegerTextSchema,
    status: z.enum(["open", "partially_filled", "filled", "cancelled"]),
    terminalReason: z.enum(["owner_cancelled", "self_trade_prevention"]).nullable(),
  })
  .strict()
  .superRefine((payload, context) => {
    const remainingLots = BigInt(payload.remainingLots);
    const active = payload.status === "open" || payload.status === "partially_filled";
    if (active && (remainingLots === 0n || payload.terminalReason !== null)) {
      context.addIssue({ code: "custom", message: "Active order publication state is invalid." });
    }
    if (payload.status === "filled" && (remainingLots !== 0n || payload.terminalReason !== null)) {
      context.addIssue({ code: "custom", message: "Filled order publication state is invalid." });
    }
    if (
      payload.status === "cancelled" &&
      (remainingLots === 0n || payload.terminalReason === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cancelled order publication state is invalid.",
      });
    }
  });

const tradeExecutedPayloadSchema = z
  .object({
    tradeId: z.uuid(),
    quantityLots: positiveIntegerTextSchema,
    priceTicks: positiveIntegerTextSchema,
    executionSequence: positiveIntegerTextSchema,
  })
  .strict();

export type TradingOrderStateFactPayload = z.infer<typeof orderStatePayloadSchema>;
export type TradingTradeExecutedFactPayload = z.infer<typeof tradeExecutedPayloadSchema>;
export type TradingPublicationFactKind = "order_state" | "trade_executed";

interface TradingPublicationFactBase {
  readonly id: string;
  readonly marketCode: MarketCode;
  readonly marketSequence: bigint;
  readonly schemaVersion: typeof tradingPublicationFactSchemaVersion;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface TradingOrderStateFact extends TradingPublicationFactBase {
  readonly kind: "order_state";
  readonly payload: TradingOrderStateFactPayload;
}

export interface TradingTradeExecutedFact extends TradingPublicationFactBase {
  readonly kind: "trade_executed";
  readonly payload: TradingTradeExecutedFactPayload;
}

export type TradingPublicationFact = TradingOrderStateFact | TradingTradeExecutedFact;

export interface TradingPublicationFactPageInput {
  readonly marketCode: MarketCode;
  readonly afterSequence: bigint;
  readonly limit: number;
}

export interface TradingPublicationFactReader {
  listAfter(input: TradingPublicationFactPageInput): Promise<readonly TradingPublicationFact[]>;
}

export function parseTradingPublicationFactPayload(
  kind: "order_state",
  schemaVersion: number,
  payload: unknown,
): TradingOrderStateFactPayload;
export function parseTradingPublicationFactPayload(
  kind: "trade_executed",
  schemaVersion: number,
  payload: unknown,
): TradingTradeExecutedFactPayload;
export function parseTradingPublicationFactPayload(
  kind: TradingPublicationFactKind,
  schemaVersion: number,
  payload: unknown,
): TradingOrderStateFactPayload | TradingTradeExecutedFactPayload {
  if (schemaVersion !== tradingPublicationFactSchemaVersion) {
    throw new Error(`Unsupported Trading publication fact schema version: ${schemaVersion}.`);
  }
  return kind === "order_state"
    ? orderStatePayloadSchema.parse(payload)
    : tradeExecutedPayloadSchema.parse(payload);
}
