import type { Kysely } from "kysely";

import type {
  AssetCatalogReader,
  AssetCatalogRecord,
} from "../../application/asset-catalog-reader.js";
import { parseAssetCode } from "../../domain/asset-code.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

export class PostgresAssetCatalogReader implements AssetCatalogReader {
  public constructor(private readonly database: Kysely<FinancialDatabaseSchema>) {}

  public async list(): Promise<readonly AssetCatalogRecord[]> {
    const rows = await this.database
      .selectFrom("financial.assets")
      .select(["code", "display_name", "ledger_scale", "status"])
      .orderBy("code")
      .execute();

    return rows.map((row) => ({
      code: parseAssetCode(row.code),
      displayName: row.display_name,
      ledgerScale: parseAssetScale(row.ledger_scale),
      status: row.status,
    }));
  }
}
