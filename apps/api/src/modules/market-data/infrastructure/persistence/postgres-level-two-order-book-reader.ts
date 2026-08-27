import type { Kysely } from "kysely";

import type { MarketCode } from "../../../trading/index.js";
import {
  levelTwoOrderBookProjectionName,
  type LevelTwoOrderBookLevel,
  type LevelTwoOrderBookReader,
  type LevelTwoOrderBookSnapshot,
} from "../../application/level-two-order-book-projection.js";
import type { MarketDataDatabaseSchema } from "./market-data-database-schema.js";

interface LevelRow {
  readonly side: "buy" | "sell";
  readonly priceTicks: string;
  readonly aggregateRemainingLots: string;
  readonly orderCount: string;
  readonly lastSequence: string;
  readonly updatedAt: Date;
}

function mapLevel(row: LevelRow): LevelTwoOrderBookLevel {
  return {
    side: row.side,
    priceTicks: BigInt(row.priceTicks),
    aggregateRemainingLots: BigInt(row.aggregateRemainingLots),
    orderCount: BigInt(row.orderCount),
    lastSequence: BigInt(row.lastSequence),
    updatedAt: row.updatedAt,
  };
}

export class PostgresLevelTwoOrderBookReader implements LevelTwoOrderBookReader {
  public constructor(private readonly database: Kysely<MarketDataDatabaseSchema>) {}

  public async getSnapshot(
    marketCode: MarketCode,
    depth?: number,
  ): Promise<LevelTwoOrderBookSnapshot> {
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 100)) {
      throw new RangeError("Level-two order-book read depth is invalid.");
    }
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const generation = await transaction
          .selectFrom("market_data.projection_generations")
          .select("id")
          .where("projection_name", "=", levelTwoOrderBookProjectionName)
          .where("status", "=", "active")
          .executeTakeFirstOrThrow();
        const readSide = async (
          side: "buy" | "sell",
          direction: "asc" | "desc",
        ): Promise<readonly LevelRow[]> => {
          let query = transaction
            .selectFrom("market_data.level_two_order_book_levels")
            .select([
              "side",
              "price_ticks as priceTicks",
              "aggregate_remaining_lots as aggregateRemainingLots",
              "order_count as orderCount",
              "last_sequence as lastSequence",
              "updated_at as updatedAt",
            ])
            .where("generation_id", "=", generation.id)
            .where("market_code", "=", marketCode)
            .where("side", "=", side)
            .orderBy("price_ticks", direction);
          if (depth !== undefined) query = query.limit(depth);
          return query.execute();
        };
        const [checkpoint, bidRows, askRows] = await Promise.all([
          transaction
            .selectFrom("market_data.projection_checkpoints")
            .select(["last_sequence as lastSequence", "last_occurred_at as lastOccurredAt"])
            .where("generation_id", "=", generation.id)
            .where("market_code", "=", marketCode)
            .executeTakeFirst(),
          readSide("buy", "desc"),
          readSide("sell", "asc"),
        ]);
        return {
          marketCode,
          sequence: checkpoint === undefined ? 0n : BigInt(checkpoint.lastSequence),
          asOf: checkpoint?.lastOccurredAt ?? null,
          bids: bidRows.map(mapLevel),
          asks: askRows.map(mapLevel),
        };
      });
  }
}
