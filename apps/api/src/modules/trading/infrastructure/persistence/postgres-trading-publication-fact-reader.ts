import type { Kysely } from "kysely";

import {
  maximumTradingPublicationFactPageSize,
  parseTradingPublicationFactPayload,
  type TradingPublicationFact,
  type TradingPublicationFactPageInput,
  type TradingPublicationFactReader,
} from "../../application/trading-publication-facts.js";
import { parseMarketCode } from "../../domain/market.js";
import type { TradingDatabaseSchema } from "./trading-database-schema.js";

interface PublicationFactRow {
  readonly id: string;
  readonly marketCode: string;
  readonly marketSequence: string;
  readonly kind: "order_state" | "trade_executed";
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

function mapFact(row: PublicationFactRow): TradingPublicationFact {
  const common = {
    id: row.id,
    marketCode: parseMarketCode(row.marketCode),
    marketSequence: BigInt(row.marketSequence),
    schemaVersion: 1 as const,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
  return row.kind === "order_state"
    ? {
        ...common,
        kind: row.kind,
        payload: parseTradingPublicationFactPayload(row.kind, row.schemaVersion, row.payload),
      }
    : {
        ...common,
        kind: row.kind,
        payload: parseTradingPublicationFactPayload(row.kind, row.schemaVersion, row.payload),
      };
}

export class PostgresTradingPublicationFactReader implements TradingPublicationFactReader {
  public constructor(private readonly database: Kysely<TradingDatabaseSchema>) {}

  public async listAfter(
    input: TradingPublicationFactPageInput,
  ): Promise<readonly TradingPublicationFact[]> {
    if (
      input.afterSequence < 0n ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > maximumTradingPublicationFactPageSize
    ) {
      throw new RangeError("Trading publication fact page boundary is invalid.");
    }
    const rows = await this.database
      .selectFrom("trading.market_data_facts")
      .select([
        "id",
        "market_code as marketCode",
        "market_sequence as marketSequence",
        "fact_kind as kind",
        "schema_version as schemaVersion",
        "payload",
        "occurred_at as occurredAt",
        "created_at as createdAt",
      ])
      .where("market_code", "=", input.marketCode)
      .where("market_sequence", ">", input.afterSequence.toString())
      .orderBy("market_sequence", "asc")
      .limit(input.limit)
      .execute();
    return (rows as readonly PublicationFactRow[]).map(mapFact);
  }
}
