import type { Kysely, Transaction } from "kysely";

import {
  bindPostgresTradingFundsTransaction,
  FinancialTradingFunds,
  parseAssetCode,
  type FinancialDatabaseSchema,
} from "../../../financial/index.js";
import type {
  AcceptTradingOrderInput,
  AcceptTradingOrderResult,
  LockedTradingMarket,
  LockMatchingOrdersInput,
  PersistedTradingOrder,
  PersistedTradingTrade,
  PersistTradingOrderStateInput,
  PersistTradingTradeInput,
  TradingPersistenceTransaction,
  TradingTransactionContext,
  TradingTransactionRunner,
} from "../../application/trading-transaction.js";
import { parseMarketCode } from "../../domain/market.js";
import {
  parseOrderId,
  parseOrderOwnerId,
  type OrderId,
  type OrderOwnerId,
} from "../../domain/order.js";
import type { TradingDatabaseSchema } from "./trading-database-schema.js";

export type TradingCompositeDatabaseSchema = TradingDatabaseSchema & FinancialDatabaseSchema;

const orderSelections = [
  "id",
  "owner_id as ownerId",
  "market_code as marketCode",
  "side",
  "original_lots as originalLots",
  "limit_price_ticks as limitPriceTicks",
  "filled_lots as filledLots",
  "remaining_lots as remainingLots",
  "status",
  "terminal_reason as terminalReason",
  "priority",
  "idempotency_key as idempotencyKey",
  "intent_hash as intentHash",
  "version",
  "created_at as createdAt",
  "updated_at as updatedAt",
] as const;

const tradeSelections = [
  "id",
  "market_code as marketCode",
  "maker_order_id as makerOrderId",
  "taker_order_id as takerOrderId",
  "buyer_order_id as buyerOrderId",
  "seller_order_id as sellerOrderId",
  "quantity_lots as quantityLots",
  "price_ticks as priceTicks",
  "execution_sequence as executionSequence",
  "executed_at as executedAt",
] as const;

interface OrderRow {
  readonly id: string;
  readonly ownerId: string;
  readonly marketCode: string;
  readonly side: "buy" | "sell";
  readonly originalLots: string;
  readonly limitPriceTicks: string;
  readonly filledLots: string;
  readonly remainingLots: string;
  readonly status: "cancelled" | "filled" | "open" | "partially_filled";
  readonly terminalReason: "owner_cancelled" | "self_trade_prevention" | null;
  readonly priority: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly version: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface TradeRow {
  readonly id: string;
  readonly marketCode: string;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly buyerOrderId: string;
  readonly sellerOrderId: string;
  readonly quantityLots: string;
  readonly priceTicks: string;
  readonly executionSequence: string;
  readonly executedAt: Date;
}

function mapOrder(row: OrderRow): PersistedTradingOrder {
  return {
    id: parseOrderId(row.id),
    ownerId: parseOrderOwnerId(row.ownerId),
    marketCode: parseMarketCode(row.marketCode),
    side: row.side,
    originalLots: BigInt(row.originalLots),
    limitPriceTicks: BigInt(row.limitPriceTicks),
    filledLots: BigInt(row.filledLots),
    remainingLots: BigInt(row.remainingLots),
    status: row.status,
    terminalReason: row.terminalReason ?? undefined,
    priority: BigInt(row.priority),
    idempotencyKey: row.idempotencyKey,
    intentHash: row.intentHash,
    version: BigInt(row.version),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTrade(row: TradeRow): PersistedTradingTrade {
  return {
    id: row.id,
    marketCode: parseMarketCode(row.marketCode),
    makerOrderId: parseOrderId(row.makerOrderId),
    takerOrderId: parseOrderId(row.takerOrderId),
    buyerOrderId: parseOrderId(row.buyerOrderId),
    sellerOrderId: parseOrderId(row.sellerOrderId),
    quantityLots: BigInt(row.quantityLots),
    priceTicks: BigInt(row.priceTicks),
    executionSequence: BigInt(row.executionSequence),
    executedAt: row.executedAt,
  };
}

class PostgresTradingPersistenceTransaction implements TradingPersistenceTransaction {
  public constructor(private readonly database: Transaction<TradingCompositeDatabaseSchema>) {}

  public async findPlacement(
    ownerId: OrderOwnerId,
    idempotencyKey: string,
  ): Promise<PersistedTradingOrder | undefined> {
    const row = await this.database
      .selectFrom("trading.orders")
      .select(orderSelections)
      .where("owner_id", "=", ownerId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row === undefined ? undefined : mapOrder(row);
  }

  public async lockMarket(
    marketCode: LockedTradingMarket["code"],
  ): Promise<LockedTradingMarket | undefined> {
    const row = await this.database
      .selectFrom("trading.markets")
      .select([
        "code",
        "base_asset_code as baseAssetCode",
        "quote_asset_code as quoteAssetCode",
        "base_lot_atomic_units as baseLotAtomicUnits",
        "quote_atomic_units_per_price_tick as quoteAtomicUnitsPerPriceTick",
        "minimum_order_lots as minimumOrderLots",
        "maximum_order_lots as maximumOrderLots",
        "status",
      ])
      .where("code", "=", marketCode)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          code: parseMarketCode(row.code),
          baseAssetCode: parseAssetCode(row.baseAssetCode),
          quoteAssetCode: parseAssetCode(row.quoteAssetCode),
          baseLotAtomicUnits: BigInt(row.baseLotAtomicUnits),
          quoteAtomicUnitsPerPriceTick: BigInt(row.quoteAtomicUnitsPerPriceTick),
          minimumOrderLots: BigInt(row.minimumOrderLots),
          maximumOrderLots: BigInt(row.maximumOrderLots),
          status: row.status,
        };
  }

  public async acceptOrder(input: AcceptTradingOrderInput): Promise<AcceptTradingOrderResult> {
    const row = await this.database
      .insertInto("trading.orders")
      .values({
        owner_id: input.ownerId,
        market_code: input.marketCode,
        side: input.side,
        order_type: "limit",
        time_in_force: "good_til_cancelled",
        original_lots: input.originalLots.toString(),
        limit_price_ticks: input.limitPriceTicks.toString(),
        remaining_lots: input.originalLots.toString(),
        status: "open",
        terminal_reason: null,
        idempotency_key: input.idempotencyKey,
        intent_hash: input.intentHash,
      })
      .onConflict((conflict) => conflict.columns(["owner_id", "idempotency_key"]).doNothing())
      .returning(orderSelections)
      .executeTakeFirst();
    if (row !== undefined) {
      return { status: "created", order: mapOrder(row) };
    }
    const existing = await this.findPlacement(input.ownerId, input.idempotencyKey);
    if (existing === undefined) {
      throw new Error("Conflicting Trading placement could not be loaded");
    }
    return { status: "existing", order: existing };
  }

  public async findOrder(orderId: OrderId): Promise<PersistedTradingOrder | undefined> {
    const row = await this.database
      .selectFrom("trading.orders")
      .select(orderSelections)
      .where("id", "=", orderId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapOrder(row);
  }

  public async lockOrder(orderId: OrderId): Promise<PersistedTradingOrder | undefined> {
    const row = await this.database
      .selectFrom("trading.orders")
      .select(orderSelections)
      .where("id", "=", orderId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : mapOrder(row);
  }

  public async lockMatchingOrders(
    input: LockMatchingOrdersInput,
  ): Promise<readonly PersistedTradingOrder[]> {
    let query = this.database
      .selectFrom("trading.orders")
      .select(orderSelections)
      .where("market_code", "=", input.marketCode)
      .where("side", "=", input.incomingSide === "buy" ? "sell" : "buy")
      .where("status", "in", ["open", "partially_filled"]);
    query =
      input.incomingSide === "buy"
        ? query.where("limit_price_ticks", "<=", input.limitPriceTicks.toString())
        : query.where("limit_price_ticks", ">=", input.limitPriceTicks.toString());
    const rows = await query
      .orderBy("limit_price_ticks", input.incomingSide === "buy" ? "asc" : "desc")
      .orderBy("priority", "asc")
      .orderBy("id", "asc")
      .forUpdate()
      .execute();
    return (rows as readonly OrderRow[]).map(mapOrder);
  }

  public async persistOrderState(input: PersistTradingOrderStateInput): Promise<boolean> {
    const updated = await this.database
      .updateTable("trading.orders")
      .set({
        filled_lots: input.filledLots.toString(),
        remaining_lots: input.remainingLots.toString(),
        status: input.status,
        terminal_reason: input.terminalReason ?? null,
        version: input.version.toString(),
      })
      .where("id", "=", input.orderId)
      .where("version", "=", input.expectedVersion.toString())
      .returning("id")
      .executeTakeFirst();
    return updated !== undefined;
  }

  public async persistTrade(input: PersistTradingTradeInput): Promise<PersistedTradingTrade> {
    const row = await this.database
      .insertInto("trading.trades")
      .values({
        market_code: input.marketCode,
        maker_order_id: input.makerOrderId,
        taker_order_id: input.takerOrderId,
        buyer_order_id: input.buyerOrderId,
        seller_order_id: input.sellerOrderId,
        quantity_lots: input.quantityLots.toString(),
        price_ticks: input.priceTicks.toString(),
      })
      .returning(tradeSelections)
      .executeTakeFirstOrThrow();
    return mapTrade(row);
  }

  public async listTradesForTaker(
    takerOrderId: OrderId,
  ): Promise<readonly PersistedTradingTrade[]> {
    const rows = await this.database
      .selectFrom("trading.trades")
      .select(tradeSelections)
      .where("taker_order_id", "=", takerOrderId)
      .orderBy("execution_sequence", "asc")
      .execute();
    return (rows as readonly TradeRow[]).map(mapTrade);
  }
}

export class PostgresTradingTransactionRunner implements TradingTransactionRunner {
  public constructor(private readonly database: Kysely<TradingCompositeDatabaseSchema>) {}

  public execute<Result>(
    operation: (context: TradingTransactionContext) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction().execute((database) =>
      operation({
        trading: new PostgresTradingPersistenceTransaction(database),
        financial: new FinancialTradingFunds(bindPostgresTradingFundsTransaction(database)),
      }),
    );
  }
}
