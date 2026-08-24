import type { ColumnType } from "kysely";

import type { FinancialAssetStatus } from "../../application/wallet-creation-transaction.js";
import type { LedgerAccountKind } from "../../domain/ledger-account.js";

type GeneratedUuid = ColumnType<string, string | undefined, never>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

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

export interface FinancialDatabaseSchema {
  "financial.assets": AssetsTable;
  "financial.wallets": WalletsTable;
  "financial.ledger_accounts": LedgerAccountsTable;
}
