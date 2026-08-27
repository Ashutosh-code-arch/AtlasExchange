import { AssetQuantity } from "../../financial/index.js";
import type { Market, MarketStatus } from "../domain/market.js";
import type { OrderSide, OrderStatus, OrderTerminalReason } from "../domain/order.js";
import type { TradingOrderReadRecord, TradingTradeReadRecord } from "./trading-readers.js";

export interface TradingMarketView {
  readonly code: string;
  readonly baseAssetCode: string;
  readonly quoteAssetCode: string;
  readonly baseLotSize: string;
  readonly priceTickSize: string;
  readonly minimumQuantity: string;
  readonly maximumQuantity: string;
  readonly status: MarketStatus;
}

export interface TradingOrderView {
  readonly id: string;
  readonly marketCode: string;
  readonly side: OrderSide;
  readonly type: "limit";
  readonly timeInForce: "good_til_cancelled";
  readonly quantity: string;
  readonly limitPrice: string;
  readonly filledQuantity: string;
  readonly remainingQuantity: string;
  readonly status: OrderStatus;
  readonly terminalReason: OrderTerminalReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TradingTradeView {
  readonly id: string;
  readonly marketCode: string;
  readonly orderId: string;
  readonly side: OrderSide;
  readonly liquidityRole: "maker" | "taker";
  readonly quantity: string;
  readonly price: string;
  readonly quoteAmount: string;
  readonly executedAt: string;
}

function quantityForLots(market: Market, lots: bigint): string {
  return AssetQuantity.fromAtomicUnits(
    market.baseAssetCode,
    market.baseAssetScale,
    lots * market.baseLotAtomicUnits,
  ).toCanonicalDecimal();
}

export function toTradingMarketView(market: Market): TradingMarketView {
  if (market.maximumOrderLots === undefined) {
    throw new Error("Persisted Trading market maximum quantity is required");
  }
  return {
    code: market.code,
    baseAssetCode: market.baseAssetCode,
    quoteAssetCode: market.quoteAssetCode,
    baseLotSize: quantityForLots(market, 1n),
    priceTickSize: AssetQuantity.fromAtomicUnits(
      market.quoteAssetCode,
      market.quoteAssetScale,
      market.quoteAtomicUnitsPerPriceTick,
    ).toCanonicalDecimal(),
    minimumQuantity: quantityForLots(market, market.minimumOrderLots),
    maximumQuantity: quantityForLots(market, market.maximumOrderLots),
    status: market.status,
  };
}

export function toTradingOrderView(record: TradingOrderReadRecord): TradingOrderView {
  return {
    id: record.id,
    marketCode: record.market.code,
    side: record.side,
    type: "limit",
    timeInForce: "good_til_cancelled",
    quantity: quantityForLots(record.market, record.originalLots),
    limitPrice: record.market.limitPriceForTicks(record.limitPriceTicks).toCanonicalDecimal(),
    filledQuantity: quantityForLots(record.market, record.filledLots),
    remainingQuantity: quantityForLots(record.market, record.remainingLots),
    status: record.status,
    terminalReason: record.terminalReason ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toTradingTradeView(record: TradingTradeReadRecord): TradingTradeView {
  const price = record.market.limitPriceForTicks(record.priceTicks);
  return {
    id: record.id,
    marketCode: record.market.code,
    orderId: record.orderId,
    side: record.side,
    liquidityRole: record.liquidityRole,
    quantity: quantityForLots(record.market, record.quantityLots),
    price: price.toCanonicalDecimal(),
    quoteAmount: record.market
      .quoteNotionalForLots(record.quantityLots, price)
      .toCanonicalDecimal(),
    executedAt: record.executedAt.toISOString(),
  };
}
