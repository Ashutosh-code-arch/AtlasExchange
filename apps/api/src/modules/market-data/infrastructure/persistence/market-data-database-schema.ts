import type { ColumnType } from "kysely";

type GeneratedUuid = ColumnType<string, string | undefined, never>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DatabaseTimestamp = ColumnType<Date, Date | string, Date | string>;
type NullableDatabaseTimestamp = ColumnType<
  Date | null,
  Date | string | null,
  Date | string | null
>;

interface ProjectionGenerationsTable {
  id: GeneratedUuid;
  projection_name: "candles" | "level_two_order_book" | "trade_ticker";
  status: "active" | "building" | "retired";
  created_at: GeneratedTimestamp;
  activated_at: NullableDatabaseTimestamp;
}

interface CandlesTable {
  generation_id: string;
  market_code: string;
  interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
  bucket_start: DatabaseTimestamp;
  bucket_end: DatabaseTimestamp;
  open_execution_sequence: string;
  close_execution_sequence: string;
  open_price_ticks: string;
  high_price_ticks: string;
  low_price_ticks: string;
  close_price_ticks: string;
  base_volume_lots: string;
  quote_volume_tick_lots: string;
  trade_count: string;
  last_sequence: string;
  updated_at: DatabaseTimestamp;
}

interface TickerTradesTable {
  generation_id: string;
  market_code: string;
  trade_id: string;
  market_sequence: string;
  execution_sequence: string;
  price_ticks: string;
  quantity_lots: string;
  executed_at: DatabaseTimestamp;
  projected_at: GeneratedTimestamp;
}

interface ProjectionCheckpointsTable {
  generation_id: string;
  market_code: string;
  last_sequence: ColumnType<string, string | undefined, string>;
  last_occurred_at: NullableDatabaseTimestamp;
  updated_at: GeneratedTimestamp;
}

interface LevelTwoProjectedOrdersTable {
  generation_id: string;
  market_code: string;
  order_id: string;
  side: "buy" | "sell";
  limit_price_ticks: string;
  remaining_lots: string;
  last_sequence: string;
  updated_at: DatabaseTimestamp;
}

interface LevelTwoOrderBookLevelsTable {
  generation_id: string;
  market_code: string;
  side: "buy" | "sell";
  price_ticks: string;
  aggregate_remaining_lots: string;
  order_count: string;
  last_sequence: string;
  updated_at: DatabaseTimestamp;
}

export interface MarketDataDatabaseSchema {
  "market_data.candles": CandlesTable;
  "market_data.level_two_order_book_levels": LevelTwoOrderBookLevelsTable;
  "market_data.level_two_projected_orders": LevelTwoProjectedOrdersTable;
  "market_data.projection_checkpoints": ProjectionCheckpointsTable;
  "market_data.projection_generations": ProjectionGenerationsTable;
  "market_data.ticker_trades": TickerTradesTable;
}
