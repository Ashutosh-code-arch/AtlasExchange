import { sql, type Kysely, type Transaction } from "kysely";

import type { MarketCode } from "../../../trading/index.js";
import {
  candleProjectionName,
  CandleProjectionError,
  type CandleProjectionCheckpoint,
  type CandleProjectionTransaction,
  type CandleProjectionTransactionRunner,
  type CandleTradeContribution,
} from "../../application/candle-projection.js";
import type { MarketDataDatabaseSchema } from "./market-data-database-schema.js";

class PostgresCandleProjectionTransaction implements CandleProjectionTransaction {
  public constructor(
    private readonly database: Transaction<MarketDataDatabaseSchema>,
    private readonly generationId: string,
    private readonly marketCode: MarketCode,
    private readonly checkpoint: CandleProjectionCheckpoint,
  ) {}

  public getCheckpoint(): Promise<CandleProjectionCheckpoint> {
    return Promise.resolve(this.checkpoint);
  }

  public async applyTrade(contributions: readonly CandleTradeContribution[]): Promise<void> {
    for (const contribution of contributions) {
      await this.database
        .insertInto("market_data.candles")
        .values({
          generation_id: this.generationId,
          market_code: this.marketCode,
          interval: contribution.interval,
          bucket_start: contribution.bucketStart,
          bucket_end: contribution.bucketEnd,
          open_execution_sequence: contribution.executionSequence.toString(),
          close_execution_sequence: contribution.executionSequence.toString(),
          open_price_ticks: contribution.priceTicks.toString(),
          high_price_ticks: contribution.priceTicks.toString(),
          low_price_ticks: contribution.priceTicks.toString(),
          close_price_ticks: contribution.priceTicks.toString(),
          base_volume_lots: contribution.quantityLots.toString(),
          quote_volume_tick_lots: contribution.quoteVolumeTickLots.toString(),
          trade_count: "1",
          last_sequence: contribution.marketSequence.toString(),
          updated_at: contribution.executedAt,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["generation_id", "market_code", "interval", "bucket_start"])
            .doUpdateSet({
              open_execution_sequence: sql<string>`LEAST(candles.open_execution_sequence, EXCLUDED.open_execution_sequence)`,
              close_execution_sequence: sql<string>`GREATEST(candles.close_execution_sequence, EXCLUDED.close_execution_sequence)`,
              open_price_ticks: sql<string>`CASE
                WHEN EXCLUDED.open_execution_sequence < candles.open_execution_sequence
                  THEN EXCLUDED.open_price_ticks
                ELSE candles.open_price_ticks
              END`,
              high_price_ticks: sql<string>`GREATEST(candles.high_price_ticks, EXCLUDED.high_price_ticks)`,
              low_price_ticks: sql<string>`LEAST(candles.low_price_ticks, EXCLUDED.low_price_ticks)`,
              close_price_ticks: sql<string>`CASE
                WHEN EXCLUDED.close_execution_sequence > candles.close_execution_sequence
                  THEN EXCLUDED.close_price_ticks
                ELSE candles.close_price_ticks
              END`,
              base_volume_lots: sql<string>`candles.base_volume_lots + EXCLUDED.base_volume_lots`,
              quote_volume_tick_lots: sql<string>`candles.quote_volume_tick_lots + EXCLUDED.quote_volume_tick_lots`,
              trade_count: sql<string>`candles.trade_count + 1`,
              last_sequence: sql<string>`GREATEST(candles.last_sequence, EXCLUDED.last_sequence)`,
              updated_at: sql<Date>`GREATEST(candles.updated_at, EXCLUDED.updated_at)`,
            }),
        )
        .execute();
    }
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
      throw new CandleProjectionError(
        "CHECKPOINT_CONFLICT",
        "The candle checkpoint changed during projection.",
      );
    }
  }
}

export class PostgresCandleProjectionTransactionRunner implements CandleProjectionTransactionRunner {
  public constructor(private readonly database: Kysely<MarketDataDatabaseSchema>) {}

  public async run<T>(
    marketCode: MarketCode,
    operation: (transaction: CandleProjectionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`market-data:candles:${marketCode}`}, 0))`.execute(
        transaction,
      );
      const generation = await transaction
        .selectFrom("market_data.projection_generations")
        .select("id")
        .where("projection_name", "=", candleProjectionName)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("market_data.projection_checkpoints")
        .values({ generation_id: generation.id, market_code: marketCode })
        .onConflict((conflict) => conflict.columns(["generation_id", "market_code"]).doNothing())
        .execute();
      const row = await transaction
        .selectFrom("market_data.projection_checkpoints")
        .select(["last_sequence as lastSequence", "last_occurred_at as lastOccurredAt"])
        .where("generation_id", "=", generation.id)
        .where("market_code", "=", marketCode)
        .forUpdate()
        .executeTakeFirstOrThrow();
      return operation(
        new PostgresCandleProjectionTransaction(transaction, generation.id, marketCode, {
          lastSequence: BigInt(row.lastSequence),
          lastOccurredAt: row.lastOccurredAt,
        }),
      );
    });
  }
}
