import { type Kysely } from "kysely";

import type { MarketCode } from "../../../trading/index.js";
import {
  candleProjectionName,
  getCandleBucket,
  type CandleInterval,
} from "../../application/candle-projection.js";
import type { CandleHistoryPage, CandleHistoryReader } from "../../application/get-candles.js";
import type { MarketDataDatabaseSchema } from "./market-data-database-schema.js";

function validateInput(input: {
  readonly interval: CandleInterval;
  readonly limit: number;
  readonly before: Date;
}): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new RangeError("Candle history reader limit is invalid.");
  }
  const bucket = getCandleBucket(input.before, input.interval);
  if (bucket.start.getTime() !== input.before.getTime()) {
    throw new RangeError("Candle history reader cursor must be interval aligned.");
  }
}

export class PostgresCandleHistoryReader implements CandleHistoryReader {
  public constructor(private readonly database: Kysely<MarketDataDatabaseSchema>) {}

  public async getPage(input: {
    readonly marketCode: MarketCode;
    readonly interval: CandleInterval;
    readonly limit: number;
    readonly before: Date;
  }): Promise<CandleHistoryPage> {
    validateInput(input);
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const generation = await transaction
          .selectFrom("market_data.projection_generations")
          .select("id")
          .where("projection_name", "=", candleProjectionName)
          .where("status", "=", "active")
          .executeTakeFirstOrThrow();
        const [checkpoint, rows] = await Promise.all([
          transaction
            .selectFrom("market_data.projection_checkpoints")
            .select(["last_sequence as lastSequence", "last_occurred_at as lastOccurredAt"])
            .where("generation_id", "=", generation.id)
            .where("market_code", "=", input.marketCode)
            .executeTakeFirst(),
          transaction
            .selectFrom("market_data.candles")
            .select([
              "bucket_start as start",
              "bucket_end as end",
              "open_price_ticks as openPriceTicks",
              "high_price_ticks as highPriceTicks",
              "low_price_ticks as lowPriceTicks",
              "close_price_ticks as closePriceTicks",
              "base_volume_lots as baseVolumeLots",
              "quote_volume_tick_lots as quoteVolumeTickLots",
              "trade_count as tradeCount",
            ])
            .where("generation_id", "=", generation.id)
            .where("market_code", "=", input.marketCode)
            .where("interval", "=", input.interval)
            .where("bucket_start", "<", input.before)
            .orderBy("bucket_start", "desc")
            .limit(input.limit + 1)
            .execute(),
        ]);
        const hasMore = rows.length > input.limit;
        const selected = rows.slice(0, input.limit).toReversed();
        return {
          marketCode: input.marketCode,
          interval: input.interval,
          sequence: checkpoint === undefined ? 0n : BigInt(checkpoint.lastSequence),
          asOf: checkpoint?.lastOccurredAt ?? null,
          candles: selected.map((row) => ({
            start: row.start,
            end: row.end,
            openPriceTicks: BigInt(row.openPriceTicks),
            highPriceTicks: BigInt(row.highPriceTicks),
            lowPriceTicks: BigInt(row.lowPriceTicks),
            closePriceTicks: BigInt(row.closePriceTicks),
            baseVolumeLots: BigInt(row.baseVolumeLots),
            quoteVolumeTickLots: BigInt(row.quoteVolumeTickLots),
            tradeCount: BigInt(row.tradeCount),
          })),
          nextBefore: hasMore && selected[0] !== undefined ? new Date(selected[0].start) : null,
        };
      });
  }
}
