import { createHash } from "node:crypto";

import type {
  ApplyTradingPlacementEffectsResult,
  AssetCatalogReader,
  AssetCatalogRecord,
} from "../../financial/index.js";
import { Market, parseMarketCode, type MarketStatus } from "../domain/market.js";
import { matchIncomingOrder } from "../domain/matcher.js";
import { Order, parseOrderOwnerId, type OrderId, type OrderSide } from "../domain/order.js";
import { parsePlacementIdempotencyKey } from "../domain/placement-idempotency-key.js";
import { TradingInputValidationError } from "../domain/trading-input-validation-error.js";
import { TradingInvariantError } from "../domain/trading-invariant-error.js";
import type {
  LockedTradingMarket,
  PersistedTradingOrder,
  PersistedTradingTrade,
  TradingPersistenceTransaction,
  TradingTransactionRunner,
} from "./trading-transaction.js";

export interface PlaceOrderCommand {
  readonly ownerId: string;
  readonly marketCode: string;
  readonly side: OrderSide;
  readonly quantity: string;
  readonly limitPrice: string;
  readonly idempotencyKey: string;
}

export type PlaceOrderExpectedFailure =
  | { readonly status: "market_not_found" }
  | { readonly status: "market_not_active"; readonly marketStatus: MarketStatus }
  | { readonly status: "idempotency_conflict"; readonly orderId: OrderId }
  | Extract<
      ApplyTradingPlacementEffectsResult,
      { status: "asset_disabled" | "insufficient_available" | "wallet_not_found" }
    >;

export type PlaceOrderResult =
  | {
      readonly status: "placed" | "existing";
      readonly order: PersistedTradingOrder;
      readonly trades: readonly PersistedTradingTrade[];
    }
  | PlaceOrderExpectedFailure;

class RollbackPlaceOrder extends Error {
  public constructor(public readonly result: PlaceOrderExpectedFailure) {
    super(`Place order rejected: ${result.status}.`);
    this.name = "RollbackPlaceOrder";
  }
}

function parseSide(input: unknown): OrderSide {
  if (input !== "buy" && input !== "sell") {
    throw new TradingInputValidationError("side", "ORDER_SIDE_INVALID");
  }
  return input;
}

function canonicalIntentHash(input: {
  readonly marketCode: string;
  readonly side: OrderSide;
  readonly quantityLots: bigint;
  readonly limitPriceTicks: bigint;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        limitPriceTicks: input.limitPriceTicks.toString(),
        marketCode: input.marketCode,
        orderType: "limit",
        quantityLots: input.quantityLots.toString(),
        side: input.side,
        timeInForce: "good_til_cancelled",
      }),
      "utf8",
    )
    .digest("hex");
}

function reconstructMarket(
  record: LockedTradingMarket,
  assets: readonly AssetCatalogRecord[],
): Market {
  const base = assets.find(({ code }) => code === record.baseAssetCode);
  const quote = assets.find(({ code }) => code === record.quoteAssetCode);
  if (base === undefined || quote === undefined) {
    throw new TradingInvariantError("PLACEMENT_MARKET_ASSET_MISSING");
  }
  return Market.create({
    code: record.code,
    baseAssetCode: record.baseAssetCode,
    baseAssetScale: base.ledgerScale,
    quoteAssetCode: record.quoteAssetCode,
    quoteAssetScale: quote.ledgerScale,
    baseLotAtomicUnits: record.baseLotAtomicUnits,
    quoteAtomicUnitsPerPriceTick: record.quoteAtomicUnitsPerPriceTick,
    minimumOrderLots: record.minimumOrderLots,
    maximumOrderLots: record.maximumOrderLots,
    status: record.status,
  });
}

function restoreOrder(record: PersistedTradingOrder, market: Market): Order {
  if (record.marketCode !== market.code) {
    throw new TradingInvariantError("ORDER_SNAPSHOT_INVALID");
  }
  return Order.restore({
    id: record.id,
    ownerId: record.ownerId,
    side: record.side,
    quantity: market.quantityForLots(record.originalLots),
    limitPrice: market.limitPriceForTicks(record.limitPriceTicks),
    priority: record.priority,
    filledLots: record.filledLots,
    remainingLots: record.remainingLots,
    status: record.status,
    ...(record.terminalReason === undefined ? {} : { terminalReason: record.terminalReason }),
    version: record.version,
  });
}

function lifecycleMatches(left: Order, right: Order): boolean {
  return (
    left.id === right.id &&
    left.filledLots === right.filledLots &&
    left.remainingLots === right.remainingLots &&
    left.status === right.status &&
    left.terminalReason === right.terminalReason &&
    left.version === right.version
  );
}

async function persistOrderState(
  transaction: TradingPersistenceTransaction,
  previous: Order,
  next: Order,
): Promise<void> {
  const persisted = await transaction.persistOrderState({
    orderId: next.id,
    expectedVersion: previous.version,
    filledLots: next.filledLots,
    remainingLots: next.remainingLots,
    status: next.status,
    terminalReason: next.terminalReason,
    version: next.version,
  });
  if (!persisted) {
    throw new TradingInvariantError("ORDER_VERSION_CONFLICT");
  }
}

function financialFailure(
  result: ApplyTradingPlacementEffectsResult,
): PlaceOrderExpectedFailure | undefined {
  return result.status === "asset_disabled" ||
    result.status === "insufficient_available" ||
    result.status === "wallet_not_found"
    ? result
    : undefined;
}

export class PlaceOrder {
  public constructor(
    private readonly transactionRunner: TradingTransactionRunner,
    private readonly assetCatalog: AssetCatalogReader,
  ) {}

  public async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    const ownerId = parseOrderOwnerId(command.ownerId.toLowerCase());
    const marketCode = parseMarketCode(command.marketCode);
    const side = parseSide(command.side);
    const idempotencyKey = parsePlacementIdempotencyKey(command.idempotencyKey);
    const assets = await this.assetCatalog.list();

    try {
      return await this.transactionRunner.execute(async ({ trading, financial }) => {
        const committed = await trading.findPlacement(ownerId, idempotencyKey);
        if (committed !== undefined && committed.marketCode !== marketCode) {
          return { status: "idempotency_conflict", orderId: committed.id };
        }

        const lockedMarket = await trading.lockMarket(marketCode);
        if (lockedMarket === undefined) {
          if (committed !== undefined) {
            throw new TradingInvariantError("PLACEMENT_MATCH_STATE_INVALID");
          }
          return { status: "market_not_found" };
        }
        const market = reconstructMarket(lockedMarket, assets);
        const quantity = market.parseQuantity(command.quantity);
        const limitPrice = market.parseLimitPrice(command.limitPrice);
        const intentHash = canonicalIntentHash({
          marketCode,
          side,
          quantityLots: quantity.lots,
          limitPriceTicks: limitPrice.ticks,
        });

        if (committed !== undefined) {
          return committed.intentHash === intentHash
            ? {
                status: "existing",
                order: committed,
                trades: await trading.listTradesForTaker(committed.id),
              }
            : { status: "idempotency_conflict", orderId: committed.id };
        }
        if (market.status !== "active") {
          return { status: "market_not_active", marketStatus: market.status };
        }

        const accepted = await trading.acceptOrder({
          ownerId,
          marketCode,
          side,
          originalLots: quantity.lots,
          limitPriceTicks: limitPrice.ticks,
          idempotencyKey,
          intentHash,
        });
        if (accepted.status === "existing") {
          return accepted.order.intentHash === intentHash
            ? {
                status: "existing",
                order: accepted.order,
                trades: await trading.listTradesForTaker(accepted.order.id),
              }
            : { status: "idempotency_conflict", orderId: accepted.order.id };
        }

        const incoming = restoreOrder(accepted.order, market);
        const makerRecords = await trading.lockMatchingOrders({
          marketCode,
          incomingSide: side,
          limitPriceTicks: limitPrice.ticks,
        });
        const makerOrders = makerRecords.map((record) => restoreOrder(record, market));
        const match = matchIncomingOrder(incoming, makerOrders);
        const ordersById = new Map<OrderId, Order>([
          [incoming.id, incoming],
          ...makerOrders.map((order) => [order.id, order] as const),
        ]);

        let currentIncoming = incoming;
        const persistedTrades: PersistedTradingTrade[] = [];
        for (const [index, execution] of match.executions.entries()) {
          const originalMaker = ordersById.get(execution.makerOrderId);
          const updatedMaker = match.updatedMakers[index];
          if (originalMaker === undefined || updatedMaker?.id !== originalMaker.id) {
            throw new TradingInvariantError("PLACEMENT_MATCH_STATE_INVALID");
          }
          await persistOrderState(trading, originalMaker, updatedMaker);
          ordersById.set(updatedMaker.id, updatedMaker);

          const updatedIncoming = currentIncoming.applyFill(execution.quantityLots);
          await persistOrderState(trading, currentIncoming, updatedIncoming);
          currentIncoming = updatedIncoming;
          ordersById.set(currentIncoming.id, currentIncoming);

          persistedTrades.push(
            await trading.persistTrade({
              marketCode,
              makerOrderId: execution.makerOrderId,
              takerOrderId: execution.takerOrderId,
              buyerOrderId: execution.buyerOrderId,
              sellerOrderId: execution.sellerOrderId,
              quantityLots: execution.quantityLots,
              priceTicks: execution.priceTicks,
            }),
          );
        }

        if (match.incomingOrder.status === "cancelled") {
          const cancelled = currentIncoming.cancel("self_trade_prevention");
          await persistOrderState(trading, currentIncoming, cancelled);
          currentIncoming = cancelled;
          ordersById.set(currentIncoming.id, currentIncoming);
        }
        if (!lifecycleMatches(currentIncoming, match.incomingOrder)) {
          throw new TradingInvariantError("PLACEMENT_MATCH_STATE_INVALID");
        }

        const financialResult = await financial.applyPlacementEffects({
          market: {
            code: market.code,
            baseAssetCode: market.baseAssetCode,
            quoteAssetCode: market.quoteAssetCode,
          },
          incoming: {
            orderId: incoming.id,
            ownerId: incoming.ownerId,
            side: incoming.side,
            amount:
              incoming.side === "buy"
                ? market.quoteNotional(incoming.quantity, incoming.limitPrice)
                : market.baseQuantityForLots(incoming.quantity.lots),
          },
          executions: match.executions.map((execution, index) => {
            const persistedTrade = persistedTrades[index];
            const buyer = ordersById.get(execution.buyerOrderId);
            const seller = ordersById.get(execution.sellerOrderId);
            if (persistedTrade === undefined || buyer === undefined || seller === undefined) {
              throw new TradingInvariantError("PLACEMENT_MATCH_STATE_INVALID");
            }
            return {
              tradeId: persistedTrade.id,
              makerOrderId: execution.makerOrderId,
              takerOrderId: execution.takerOrderId,
              buyerOrderId: execution.buyerOrderId,
              buyerOwnerId: buyer.ownerId,
              sellerOrderId: execution.sellerOrderId,
              sellerOwnerId: seller.ownerId,
              baseQuantity: market.baseQuantityForLots(execution.quantityLots),
              executionQuote: market.quoteNotionalForLots(
                execution.quantityLots,
                market.limitPriceForTicks(execution.priceTicks),
              ),
              buyerReservedQuoteReduction: market.quoteNotionalForLots(
                execution.quantityLots,
                buyer.limitPrice,
              ),
            };
          }),
          ...(currentIncoming.status === "cancelled"
            ? { terminalReleaseReason: "self_trade_prevention" as const }
            : {}),
        });
        const rejection = financialFailure(financialResult);
        if (rejection !== undefined) {
          throw new RollbackPlaceOrder(rejection);
        }
        if (financialResult.status !== "applied") {
          throw new TradingInvariantError("PLACEMENT_FINANCIAL_EFFECT_CONFLICT");
        }

        const persistedOrder = await trading.lockOrder(incoming.id);
        if (persistedOrder === undefined) {
          throw new TradingInvariantError("PLACEMENT_MATCH_STATE_INVALID");
        }
        await trading.publishMarketDataFacts({
          marketCode,
          orderIds: [...match.updatedMakers.map(({ id }) => id), persistedOrder.id],
          tradeIds: persistedTrades.map(({ id }) => id),
        });
        return { status: "placed", order: persistedOrder, trades: persistedTrades };
      });
    } catch (error) {
      if (error instanceof RollbackPlaceOrder) {
        return error.result;
      }
      throw error;
    }
  }
}
