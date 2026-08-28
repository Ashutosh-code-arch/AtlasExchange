import { sql, type Kysely } from "kysely";

import type { MarketCode } from "../../../trading/index.js";
import type {
  TradeTickerSnapshot,
  TradeTickerWindowReader,
} from "../../application/get-trade-ticker.js";
import { tradeTickerProjectionName } from "../../application/trade-ticker-projection.js";
import type { MarketDataDatabaseSchema } from "./market-data-database-schema.js";

export class PostgresTradeTickerReader implements TradeTickerWindowReader {
  public constructor(private readonly database: Kysely<MarketDataDatabaseSchema>) {}

  public async getSnapshot(input: {
    readonly marketCode: MarketCode;
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<TradeTickerSnapshot> {
    if (
      Number.isNaN(input.windowStart.getTime()) ||
      Number.isNaN(input.windowEnd.getTime()) ||
      input.windowStart > input.windowEnd
    ) {
      throw new RangeError("Trade ticker window is invalid.");
    }
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const generation = await transaction
          .selectFrom("market_data.projection_generations")
          .select("id")
          .where("projection_name", "=", tradeTickerProjectionName)
          .where("status", "=", "active")
          .executeTakeFirstOrThrow();
        const windowQuery = transaction
          .selectFrom("market_data.ticker_trades")
          .where("generation_id", "=", generation.id)
          .where("market_code", "=", input.marketCode)
          .where("executed_at", ">=", input.windowStart)
          .where("executed_at", "<=", input.windowEnd);
        const [checkpoint, aggregate, lastTrade] = await Promise.all([
          transaction
            .selectFrom("market_data.projection_checkpoints")
            .select(["last_sequence as lastSequence", "last_occurred_at as lastOccurredAt"])
            .where("generation_id", "=", generation.id)
            .where("market_code", "=", input.marketCode)
            .executeTakeFirst(),
          windowQuery
            .select([
              sql<string | null>`MAX(price_ticks)::TEXT`.as("highPriceTicks"),
              sql<string | null>`MIN(price_ticks)::TEXT`.as("lowPriceTicks"),
              sql<string>`COALESCE(SUM(quantity_lots), 0)::TEXT`.as("baseVolumeLots"),
              sql<string>`COALESCE(SUM(price_ticks * quantity_lots), 0)::TEXT`.as(
                "quoteVolumeTickLots",
              ),
            ])
            .executeTakeFirstOrThrow(),
          windowQuery
            .select([
              "price_ticks as priceTicks",
              "quantity_lots as quantityLots",
              "execution_sequence as executionSequence",
              "executed_at as executedAt",
            ])
            .orderBy("executed_at", "desc")
            .orderBy("execution_sequence", "desc")
            .limit(1)
            .executeTakeFirst(),
        ]);
        return {
          marketCode: input.marketCode,
          sequence: checkpoint === undefined ? 0n : BigInt(checkpoint.lastSequence),
          asOf: checkpoint?.lastOccurredAt ?? null,
          windowStart: new Date(input.windowStart),
          windowEnd: new Date(input.windowEnd),
          lastTrade:
            lastTrade === undefined
              ? null
              : {
                  priceTicks: BigInt(lastTrade.priceTicks),
                  quantityLots: BigInt(lastTrade.quantityLots),
                  executionSequence: BigInt(lastTrade.executionSequence),
                  executedAt: lastTrade.executedAt,
                },
          highPriceTicks:
            aggregate.highPriceTicks === null ? null : BigInt(aggregate.highPriceTicks),
          lowPriceTicks: aggregate.lowPriceTicks === null ? null : BigInt(aggregate.lowPriceTicks),
          baseVolumeLots: BigInt(aggregate.baseVolumeLots),
          quoteVolumeTickLots: BigInt(aggregate.quoteVolumeTickLots),
        };
      });
  }
}
