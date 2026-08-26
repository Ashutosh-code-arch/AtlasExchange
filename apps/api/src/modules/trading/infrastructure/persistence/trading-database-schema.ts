import type { ColumnType } from "kysely";

type GeneratedUuid = ColumnType<string, string | undefined, never>;
type GeneratedBigint = ColumnType<string, string | undefined, never>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

interface MarketsTable {
  code: string;
  base_asset_code: string;
  quote_asset_code: string;
  base_lot_atomic_units: string;
  quote_atomic_units_per_price_tick: string;
  minimum_order_lots: string;
  maximum_order_lots: string;
  status: "active" | "cancel_only" | "disabled";
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface OrdersTable {
  id: GeneratedUuid;
  owner_id: string;
  market_code: string;
  side: "buy" | "sell";
  order_type: "limit";
  time_in_force: "good_til_cancelled";
  original_lots: string;
  limit_price_ticks: string;
  filled_lots: ColumnType<string, string | undefined, string>;
  remaining_lots: string;
  status: "cancelled" | "filled" | "open" | "partially_filled";
  terminal_reason: "owner_cancelled" | "self_trade_prevention" | null;
  priority: GeneratedBigint;
  idempotency_key: string;
  intent_hash: string;
  version: ColumnType<string, string | undefined, string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface TradesTable {
  id: GeneratedUuid;
  market_code: string;
  maker_order_id: string;
  taker_order_id: string;
  buyer_order_id: string;
  seller_order_id: string;
  quantity_lots: string;
  price_ticks: string;
  execution_sequence: GeneratedBigint;
  executed_at: GeneratedTimestamp;
}

export interface TradingDatabaseSchema {
  "trading.markets": MarketsTable;
  "trading.orders": OrdersTable;
  "trading.trades": TradesTable;
}
