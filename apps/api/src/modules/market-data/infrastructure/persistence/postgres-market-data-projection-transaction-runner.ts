import { sql, type Kysely, type Transaction } from "kysely";

import type { MarketCode } from "../../../trading/index.js";
import {
  levelTwoOrderBookProjectionName,
  MarketDataProjectionError,
  type LevelTwoOrderBookLevel,
  type LevelTwoOrderBookSide,
  type LevelTwoProjectedOrder,
  type LevelTwoProjectionCheckpoint,
  type LevelTwoProjectionTransaction,
  type LevelTwoProjectionTransactionRunner,
} from "../../application/level-two-order-book-projection.js";
import type { MarketDataDatabaseSchema } from "./market-data-database-schema.js";

interface CheckpointRow {
  readonly lastSequence: string;
  readonly lastOccurredAt: Date | null;
}

class PostgresLevelTwoProjectionTransaction implements LevelTwoProjectionTransaction {
  public constructor(
    private readonly database: Transaction<MarketDataDatabaseSchema>,
    private readonly generationId: string,
    private readonly marketCode: MarketCode,
    private readonly checkpoint: LevelTwoProjectionCheckpoint,
  ) {}

  public getCheckpoint(): Promise<LevelTwoProjectionCheckpoint> {
    return Promise.resolve(this.checkpoint);
  }

  public async getProjectedOrder(orderId: string): Promise<LevelTwoProjectedOrder | undefined> {
    const row = await this.database
      .selectFrom("market_data.level_two_projected_orders")
      .select([
        "order_id as orderId",
        "side",
        "limit_price_ticks as priceTicks",
        "remaining_lots as remainingLots",
        "last_sequence as lastSequence",
        "updated_at as updatedAt",
      ])
      .where("generation_id", "=", this.generationId)
      .where("market_code", "=", this.marketCode)
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          orderId: row.orderId,
          side: row.side,
          priceTicks: BigInt(row.priceTicks),
          remainingLots: BigInt(row.remainingLots),
          lastSequence: BigInt(row.lastSequence),
          updatedAt: row.updatedAt,
        };
  }

  public async getLevel(
    side: LevelTwoOrderBookSide,
    priceTicks: bigint,
  ): Promise<LevelTwoOrderBookLevel | undefined> {
    const row = await this.database
      .selectFrom("market_data.level_two_order_book_levels")
      .select([
        "side",
        "price_ticks as priceTicks",
        "aggregate_remaining_lots as aggregateRemainingLots",
        "order_count as orderCount",
        "last_sequence as lastSequence",
        "updated_at as updatedAt",
      ])
      .where("generation_id", "=", this.generationId)
      .where("market_code", "=", this.marketCode)
      .where("side", "=", side)
      .where("price_ticks", "=", priceTicks.toString())
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          side: row.side,
          priceTicks: BigInt(row.priceTicks),
          aggregateRemainingLots: BigInt(row.aggregateRemainingLots),
          orderCount: BigInt(row.orderCount),
          lastSequence: BigInt(row.lastSequence),
          updatedAt: row.updatedAt,
        };
  }

  public async saveProjectedOrder(order: LevelTwoProjectedOrder): Promise<void> {
    await this.database
      .insertInto("market_data.level_two_projected_orders")
      .values({
        generation_id: this.generationId,
        market_code: this.marketCode,
        order_id: order.orderId,
        side: order.side,
        limit_price_ticks: order.priceTicks.toString(),
        remaining_lots: order.remainingLots.toString(),
        last_sequence: order.lastSequence.toString(),
        updated_at: order.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["generation_id", "market_code", "order_id"]).doUpdateSet({
          side: order.side,
          limit_price_ticks: order.priceTicks.toString(),
          remaining_lots: order.remainingLots.toString(),
          last_sequence: order.lastSequence.toString(),
          updated_at: order.updatedAt,
        }),
      )
      .execute();
  }

  public async deleteProjectedOrder(orderId: string): Promise<void> {
    await this.database
      .deleteFrom("market_data.level_two_projected_orders")
      .where("generation_id", "=", this.generationId)
      .where("market_code", "=", this.marketCode)
      .where("order_id", "=", orderId)
      .execute();
  }

  public async saveLevel(level: LevelTwoOrderBookLevel): Promise<void> {
    await this.database
      .insertInto("market_data.level_two_order_book_levels")
      .values({
        generation_id: this.generationId,
        market_code: this.marketCode,
        side: level.side,
        price_ticks: level.priceTicks.toString(),
        aggregate_remaining_lots: level.aggregateRemainingLots.toString(),
        order_count: level.orderCount.toString(),
        last_sequence: level.lastSequence.toString(),
        updated_at: level.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["generation_id", "market_code", "side", "price_ticks"]).doUpdateSet({
          aggregate_remaining_lots: level.aggregateRemainingLots.toString(),
          order_count: level.orderCount.toString(),
          last_sequence: level.lastSequence.toString(),
          updated_at: level.updatedAt,
        }),
      )
      .execute();
  }

  public async deleteLevel(side: LevelTwoOrderBookSide, priceTicks: bigint): Promise<void> {
    await this.database
      .deleteFrom("market_data.level_two_order_book_levels")
      .where("generation_id", "=", this.generationId)
      .where("market_code", "=", this.marketCode)
      .where("side", "=", side)
      .where("price_ticks", "=", priceTicks.toString())
      .execute();
  }

  public async advanceCheckpoint(input: {
    readonly expectedPreviousSequence: bigint;
    readonly lastSequence: bigint;
    readonly lastOccurredAt: Date;
  }): Promise<void> {
    const result = await this.database
      .updateTable("market_data.projection_checkpoints")
      .set({
        last_sequence: input.lastSequence.toString(),
        last_occurred_at: input.lastOccurredAt,
        updated_at: sql<Date>`NOW()`,
      })
      .where("generation_id", "=", this.generationId)
      .where("market_code", "=", this.marketCode)
      .where("last_sequence", "=", input.expectedPreviousSequence.toString())
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new MarketDataProjectionError(
        "BOOK_INVARIANT_VIOLATION",
        "The Market Data checkpoint changed during projection.",
      );
    }
  }
}

export class PostgresMarketDataProjectionTransactionRunner implements LevelTwoProjectionTransactionRunner {
  public constructor(private readonly database: Kysely<MarketDataDatabaseSchema>) {}

  public async run<T>(
    marketCode: MarketCode,
    operation: (transaction: LevelTwoProjectionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`market-data:l2:${marketCode}`}, 0))`.execute(
        transaction,
      );
      const generation = await transaction
        .selectFrom("market_data.projection_generations")
        .select("id")
        .where("projection_name", "=", levelTwoOrderBookProjectionName)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("market_data.projection_checkpoints")
        .values({ generation_id: generation.id, market_code: marketCode })
        .onConflict((conflict) => conflict.columns(["generation_id", "market_code"]).doNothing())
        .execute();
      const row = (await transaction
        .selectFrom("market_data.projection_checkpoints")
        .select(["last_sequence as lastSequence", "last_occurred_at as lastOccurredAt"])
        .where("generation_id", "=", generation.id)
        .where("market_code", "=", marketCode)
        .forUpdate()
        .executeTakeFirstOrThrow()) as CheckpointRow;
      return operation(
        new PostgresLevelTwoProjectionTransaction(transaction, generation.id, marketCode, {
          lastSequence: BigInt(row.lastSequence),
          lastOccurredAt: row.lastOccurredAt,
        }),
      );
    });
  }
}
