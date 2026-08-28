import { sql, type Kysely, type Transaction } from "kysely";

import type { MarketCode } from "../../../trading/index.js";
import {
  tradeTickerProjectionName,
  TradeTickerProjectionError,
  type TradeTickerObservation,
  type TradeTickerProjectionCheckpoint,
  type TradeTickerProjectionTransaction,
  type TradeTickerProjectionTransactionRunner,
} from "../../application/trade-ticker-projection.js";
import type { MarketDataDatabaseSchema } from "./market-data-database-schema.js";

class PostgresTradeTickerProjectionTransaction implements TradeTickerProjectionTransaction {
  public constructor(
    private readonly database: Transaction<MarketDataDatabaseSchema>,
    private readonly generationId: string,
    private readonly marketCode: MarketCode,
    private readonly checkpoint: TradeTickerProjectionCheckpoint,
  ) {}

  public getCheckpoint(): Promise<TradeTickerProjectionCheckpoint> {
    return Promise.resolve(this.checkpoint);
  }

  public async saveTrade(trade: TradeTickerObservation): Promise<void> {
    await this.database
      .insertInto("market_data.ticker_trades")
      .values({
        generation_id: this.generationId,
        market_code: this.marketCode,
        trade_id: trade.tradeId,
        market_sequence: trade.marketSequence.toString(),
        execution_sequence: trade.executionSequence.toString(),
        price_ticks: trade.priceTicks.toString(),
        quantity_lots: trade.quantityLots.toString(),
        executed_at: trade.executedAt,
      })
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
      throw new TradeTickerProjectionError(
        "CHECKPOINT_CONFLICT",
        "The trade ticker checkpoint changed during projection.",
      );
    }
  }
}

export class PostgresTradeTickerProjectionTransactionRunner implements TradeTickerProjectionTransactionRunner {
  public constructor(private readonly database: Kysely<MarketDataDatabaseSchema>) {}

  public async run<T>(
    marketCode: MarketCode,
    operation: (transaction: TradeTickerProjectionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`market-data:ticker:${marketCode}`}, 0))`.execute(
        transaction,
      );
      const generation = await transaction
        .selectFrom("market_data.projection_generations")
        .select("id")
        .where("projection_name", "=", tradeTickerProjectionName)
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
        new PostgresTradeTickerProjectionTransaction(transaction, generation.id, marketCode, {
          lastSequence: BigInt(row.lastSequence),
          lastOccurredAt: row.lastOccurredAt,
        }),
      );
    });
  }
}
