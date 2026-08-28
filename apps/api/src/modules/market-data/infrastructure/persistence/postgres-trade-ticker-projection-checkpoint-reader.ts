import type { Kysely } from "kysely";

import type { MarketCode } from "../../../trading/index.js";
import {
  tradeTickerProjectionName,
  type TradeTickerProjectionCheckpoint,
  type TradeTickerProjectionCheckpointReader,
} from "../../application/trade-ticker-projection.js";
import type { MarketDataDatabaseSchema } from "./market-data-database-schema.js";

export class PostgresTradeTickerProjectionCheckpointReader implements TradeTickerProjectionCheckpointReader {
  public constructor(private readonly database: Kysely<MarketDataDatabaseSchema>) {}

  public async getCheckpoint(marketCode: MarketCode): Promise<TradeTickerProjectionCheckpoint> {
    const generation = await this.database
      .selectFrom("market_data.projection_generations")
      .select("id")
      .where("projection_name", "=", tradeTickerProjectionName)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    const checkpoint = await this.database
      .selectFrom("market_data.projection_checkpoints")
      .select(["last_sequence as lastSequence", "last_occurred_at as lastOccurredAt"])
      .where("generation_id", "=", generation.id)
      .where("market_code", "=", marketCode)
      .executeTakeFirst();
    return checkpoint === undefined
      ? { lastSequence: 0n, lastOccurredAt: null }
      : {
          lastSequence: BigInt(checkpoint.lastSequence),
          lastOccurredAt: checkpoint.lastOccurredAt,
        };
  }
}
