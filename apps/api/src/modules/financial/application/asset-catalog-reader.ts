import type { AssetCode } from "../domain/asset-code.js";
import type { AssetScale } from "../domain/asset-scale.js";
import type { FinancialAssetStatus } from "./wallet-creation-transaction.js";

export interface AssetCatalogRecord {
  readonly code: AssetCode;
  readonly displayName: string;
  readonly ledgerScale: AssetScale;
  readonly status: FinancialAssetStatus;
}

export interface AssetCatalogReader {
  list(): Promise<readonly AssetCatalogRecord[]>;
}
