import type { ColumnType, JSONColumnType } from "kysely";

import type { FinancialAssetStatus } from "../../application/wallet-creation-transaction.js";
import type { LedgerAccountKind } from "../../domain/ledger-account.js";

type GeneratedUuid = ColumnType<string, string | undefined, never>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

interface AssetsTable {
  code: string;
  display_name: string;
  ledger_scale: number;
  status: FinancialAssetStatus;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface WalletsTable {
  id: GeneratedUuid;
  owner_id: string;
  asset_code: string;
  created_at: GeneratedTimestamp;
}

interface LedgerAccountsTable {
  id: GeneratedUuid;
  asset_code: string;
  kind: LedgerAccountKind;
  wallet_id: string | null;
  created_at: GeneratedTimestamp;
}

interface JournalTransactionsTable {
  id: GeneratedUuid;
  operation_type: string;
  idempotency_scope: string;
  idempotency_key: string;
  intent_hash: string;
  business_references: JSONColumnType<JsonObject, JsonObject | undefined, never>;
  created_at: GeneratedTimestamp;
}

interface JournalPostingsTable {
  journal_id: string;
  position: number;
  account_id: string;
  asset_code: string;
  direction: "credit" | "debit";
  amount: string;
}

interface DepositsTable {
  id: GeneratedUuid;
  owner_id: string;
  wallet_id: string;
  asset_code: string;
  amount: string;
  method: "simulated";
  status: "credited";
  journal_id: string;
  idempotency_key: string;
  intent_hash: string;
  credited_at: GeneratedTimestamp;
}

interface WithdrawalsTable {
  id: GeneratedUuid;
  owner_id: string;
  wallet_id: string;
  asset_code: string;
  amount: string;
  method: "simulated";
  status: "completed";
  journal_id: string;
  idempotency_key: string;
  intent_hash: string;
  completed_at: GeneratedTimestamp;
}

interface TradingReservationsTable {
  order_id: string;
  owner_id: string;
  market_code: string;
  side: "buy" | "sell";
  asset_code: string;
  original_amount: string;
  remaining_amount: string;
  status: "active" | "consumed" | "released";
  reservation_journal_id: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface TradingReservationMovementsTable {
  reservation_order_id: string;
  journal_id: string;
  movement_kind: "release" | "trade_settlement";
  amount: string;
  trade_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface FinancialDatabaseSchema {
  "financial.assets": AssetsTable;
  "financial.deposits": DepositsTable;
  "financial.wallets": WalletsTable;
  "financial.ledger_accounts": LedgerAccountsTable;
  "financial.journal_transactions": JournalTransactionsTable;
  "financial.journal_postings": JournalPostingsTable;
  "financial.trading_reservations": TradingReservationsTable;
  "financial.trading_reservation_movements": TradingReservationMovementsTable;
  "financial.withdrawals": WithdrawalsTable;
}
