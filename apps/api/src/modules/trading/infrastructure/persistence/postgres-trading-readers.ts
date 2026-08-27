import type { Kysely } from "kysely";

import {
  parseAssetCode,
  parseAssetScale,
  type FinancialDatabaseSchema,
} from "../../../financial/index.js";
import type {
  TradingMarketReader,
  TradingOrderPageInput,
  TradingOrderReadRecord,
  TradingOrderReader,
  TradingTradePageInput,
  TradingTradeReadRecord,
  TradingTradeReader,
} from "../../application/trading-readers.js";
import { Market, type MarketCode } from "../../domain/market.js";
import { parseOrderId } from "../../domain/order.js";
import type { TradingDatabaseSchema } from "./trading-database-schema.js";

export type TradingReadDatabaseSchema = TradingDatabaseSchema & FinancialDatabaseSchema;

const marketSelections = [
  "market.code",
  "market.base_asset_code as baseAssetCode",
  "market.quote_asset_code as quoteAssetCode",
  "market.base_lot_atomic_units as baseLotAtomicUnits",
  "market.quote_atomic_units_per_price_tick as quoteAtomicUnitsPerPriceTick",
  "market.minimum_order_lots as minimumOrderLots",
  "market.maximum_order_lots as maximumOrderLots",
  "market.status",
  "baseAsset.ledger_scale as baseAssetScale",
  "quoteAsset.ledger_scale as quoteAssetScale",
] as const;

const orderSelections = [
  "order.id",
  "order.side",
  "order.original_lots as originalLots",
  "order.limit_price_ticks as limitPriceTicks",
  "order.filled_lots as filledLots",
  "order.remaining_lots as remainingLots",
  "order.status as orderStatus",
  "order.terminal_reason as terminalReason",
  "order.created_at as createdAt",
  "order.updated_at as updatedAt",
  ...marketSelections,
] as const;

const tradeSelections = [
  "trade.id",
  "ownerOrder.id as orderId",
  "ownerOrder.side",
  "trade.maker_order_id as makerOrderId",
  "trade.quantity_lots as quantityLots",
  "trade.price_ticks as priceTicks",
  "trade.execution_sequence as executionSequence",
  "trade.executed_at as executedAt",
  ...marketSelections,
] as const;

interface MarketRow {
  readonly code: string;
  readonly baseAssetCode: string;
  readonly quoteAssetCode: string;
  readonly baseLotAtomicUnits: string;
  readonly quoteAtomicUnitsPerPriceTick: string;
  readonly minimumOrderLots: string;
  readonly maximumOrderLots: string;
  readonly status: "active" | "cancel_only" | "disabled";
  readonly baseAssetScale: number;
  readonly quoteAssetScale: number;
}

interface OrderReadRow extends MarketRow {
  readonly id: string;
  readonly side: "buy" | "sell";
  readonly originalLots: string;
  readonly limitPriceTicks: string;
  readonly filledLots: string;
  readonly remainingLots: string;
  readonly orderStatus: "cancelled" | "filled" | "open" | "partially_filled";
  readonly terminalReason: "owner_cancelled" | "self_trade_prevention" | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface TradeReadRow extends MarketRow {
  readonly id: string;
  readonly orderId: string;
  readonly side: "buy" | "sell";
  readonly makerOrderId: string;
  readonly quantityLots: string;
  readonly priceTicks: string;
  readonly executionSequence: string;
  readonly executedAt: Date;
}

function mapMarket(row: MarketRow): Market {
  return Market.create({
    code: row.code,
    baseAssetCode: parseAssetCode(row.baseAssetCode),
    baseAssetScale: parseAssetScale(row.baseAssetScale),
    quoteAssetCode: parseAssetCode(row.quoteAssetCode),
    quoteAssetScale: parseAssetScale(row.quoteAssetScale),
    baseLotAtomicUnits: BigInt(row.baseLotAtomicUnits),
    quoteAtomicUnitsPerPriceTick: BigInt(row.quoteAtomicUnitsPerPriceTick),
    minimumOrderLots: BigInt(row.minimumOrderLots),
    maximumOrderLots: BigInt(row.maximumOrderLots),
    status: row.status,
  });
}

function mapOrder(row: OrderReadRow): TradingOrderReadRecord {
  return {
    id: parseOrderId(row.id),
    market: mapMarket(row),
    side: row.side,
    originalLots: BigInt(row.originalLots),
    limitPriceTicks: BigInt(row.limitPriceTicks),
    filledLots: BigInt(row.filledLots),
    remainingLots: BigInt(row.remainingLots),
    status: row.orderStatus,
    terminalReason: row.terminalReason ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTrade(row: TradeReadRow): TradingTradeReadRecord {
  return {
    id: row.id,
    market: mapMarket(row),
    orderId: parseOrderId(row.orderId),
    side: row.side,
    liquidityRole: row.orderId === row.makerOrderId ? "maker" : "taker",
    quantityLots: BigInt(row.quantityLots),
    priceTicks: BigInt(row.priceTicks),
    executionSequence: BigInt(row.executionSequence),
    executedAt: row.executedAt,
  };
}

export class PostgresTradingMarketReader implements TradingMarketReader {
  public constructor(private readonly database: Kysely<TradingReadDatabaseSchema>) {}

  public async findByCode(marketCode: MarketCode): Promise<Market | undefined> {
    const row = await this.database
      .selectFrom("trading.markets as market")
      .innerJoin("financial.assets as baseAsset", "baseAsset.code", "market.base_asset_code")
      .innerJoin("financial.assets as quoteAsset", "quoteAsset.code", "market.quote_asset_code")
      .select(marketSelections)
      .where("market.code", "=", marketCode)
      .executeTakeFirst();
    return row === undefined ? undefined : mapMarket(row);
  }

  public async list(): Promise<readonly Market[]> {
    const rows = await this.database
      .selectFrom("trading.markets as market")
      .innerJoin("financial.assets as baseAsset", "baseAsset.code", "market.base_asset_code")
      .innerJoin("financial.assets as quoteAsset", "quoteAsset.code", "market.quote_asset_code")
      .select(marketSelections)
      .orderBy("market.code", "asc")
      .execute();
    return rows.map(mapMarket);
  }
}

export class PostgresTradingOrderReader implements TradingOrderReader {
  public constructor(private readonly database: Kysely<TradingReadDatabaseSchema>) {}

  public async findByOwnerAndId(
    ownerId: TradingOrderPageInput["ownerId"],
    orderId: TradingOrderReadRecord["id"],
  ): Promise<TradingOrderReadRecord | undefined> {
    const row = await this.database
      .selectFrom("trading.orders as order")
      .innerJoin("trading.markets as market", "market.code", "order.market_code")
      .innerJoin("financial.assets as baseAsset", "baseAsset.code", "market.base_asset_code")
      .innerJoin("financial.assets as quoteAsset", "quoteAsset.code", "market.quote_asset_code")
      .select(orderSelections)
      .where("order.owner_id", "=", ownerId)
      .where("order.id", "=", orderId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapOrder(row);
  }

  public async listByOwner(
    input: TradingOrderPageInput,
  ): Promise<readonly TradingOrderReadRecord[]> {
    let query = this.database
      .selectFrom("trading.orders as order")
      .innerJoin("trading.markets as market", "market.code", "order.market_code")
      .innerJoin("financial.assets as baseAsset", "baseAsset.code", "market.base_asset_code")
      .innerJoin("financial.assets as quoteAsset", "quoteAsset.code", "market.quote_asset_code")
      .select(orderSelections)
      .where("order.owner_id", "=", input.ownerId);
    if (input.marketCode !== undefined) {
      query = query.where("order.market_code", "=", input.marketCode);
    }
    if (input.status !== undefined) {
      query = query.where("order.status", "=", input.status);
    }
    const before = input.before;
    if (before !== undefined) {
      query = query.where((expression) =>
        expression.or([
          expression("order.created_at", "<", before.createdAt),
          expression.and([
            expression("order.created_at", "=", before.createdAt),
            expression("order.id", "<", before.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy("order.created_at", "desc")
      .orderBy("order.id", "desc")
      .limit(input.limit)
      .execute();
    return rows.map(mapOrder);
  }
}

export class PostgresTradingTradeReader implements TradingTradeReader {
  public constructor(private readonly database: Kysely<TradingReadDatabaseSchema>) {}

  public async findByOwnerAndId(
    ownerId: TradingTradePageInput["ownerId"],
    tradeId: string,
  ): Promise<TradingTradeReadRecord | undefined> {
    const row = await this.database
      .selectFrom("trading.trades as trade")
      .innerJoin("trading.orders as ownerOrder", (join) =>
        join.on((expression) =>
          expression.or([
            expression("ownerOrder.id", "=", expression.ref("trade.maker_order_id")),
            expression("ownerOrder.id", "=", expression.ref("trade.taker_order_id")),
          ]),
        ),
      )
      .innerJoin("trading.markets as market", "market.code", "trade.market_code")
      .innerJoin("financial.assets as baseAsset", "baseAsset.code", "market.base_asset_code")
      .innerJoin("financial.assets as quoteAsset", "quoteAsset.code", "market.quote_asset_code")
      .select(tradeSelections)
      .where("ownerOrder.owner_id", "=", ownerId)
      .where("trade.id", "=", tradeId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapTrade(row);
  }

  public async listByOwner(
    input: TradingTradePageInput,
  ): Promise<readonly TradingTradeReadRecord[]> {
    let query = this.database
      .selectFrom("trading.trades as trade")
      .innerJoin("trading.orders as ownerOrder", (join) =>
        join.on((expression) =>
          expression.or([
            expression("ownerOrder.id", "=", expression.ref("trade.maker_order_id")),
            expression("ownerOrder.id", "=", expression.ref("trade.taker_order_id")),
          ]),
        ),
      )
      .innerJoin("trading.markets as market", "market.code", "trade.market_code")
      .innerJoin("financial.assets as baseAsset", "baseAsset.code", "market.base_asset_code")
      .innerJoin("financial.assets as quoteAsset", "quoteAsset.code", "market.quote_asset_code")
      .select(tradeSelections)
      .where("ownerOrder.owner_id", "=", input.ownerId);
    if (input.marketCode !== undefined) {
      query = query.where("trade.market_code", "=", input.marketCode);
    }
    const before = input.before;
    if (before !== undefined) {
      query = query.where((expression) =>
        expression.or([
          expression("trade.executed_at", "<", before.executedAt),
          expression.and([
            expression("trade.executed_at", "=", before.executedAt),
            expression("trade.execution_sequence", "<", before.executionSequence.toString()),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy("trade.executed_at", "desc")
      .orderBy("trade.execution_sequence", "desc")
      .limit(input.limit)
      .execute();
    return rows.map(mapTrade);
  }
}
