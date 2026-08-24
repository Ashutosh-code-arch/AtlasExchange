import { sql, type Kysely } from "kysely";

import type {
  WalletBalanceReader,
  WalletBalanceRecord,
} from "../../application/wallet-balance-reader.js";
import { parseAssetCode, type AssetCode } from "../../domain/asset-code.js";
import { AssetQuantity } from "../../domain/asset-quantity.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import { parseLedgerAccountId } from "../../domain/ledger-account.js";
import { WalletBalanceSnapshot } from "../../domain/wallet-balance-snapshot.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
  type WalletOwnerId,
} from "../../domain/wallet.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

interface WalletBalanceRow {
  readonly walletId: string;
  readonly ownerId: string;
  readonly assetCode: string;
  readonly scale: number;
  readonly accountId: string;
  readonly accountKind: "user_available" | "user_reserved";
  readonly balanceAtomicUnits: string;
}

function mapWalletBalance(rows: readonly WalletBalanceRow[]): WalletBalanceRecord {
  const available = rows.find(({ accountKind }) => accountKind === "user_available");
  const reserved = rows.find(({ accountKind }) => accountKind === "user_reserved");
  if (rows.length !== 2 || available === undefined || reserved === undefined) {
    throw new Error("Persisted Financial wallet balance account pair is invalid");
  }

  const assetCode = parseAssetCode(available.assetCode);
  const scale = parseAssetScale(available.scale);
  const wallet = Wallet.create({
    id: parseWalletId(available.walletId),
    ownerId: parseWalletOwnerId(available.ownerId),
    assetCode,
    scale,
    availableAccountId: parseLedgerAccountId(available.accountId),
    reservedAccountId: parseLedgerAccountId(reserved.accountId),
  });
  const snapshot = WalletBalanceSnapshot.create(
    wallet,
    AssetQuantity.fromAtomicUnits(assetCode, scale, BigInt(available.balanceAtomicUnits)),
    AssetQuantity.fromAtomicUnits(assetCode, scale, BigInt(reserved.balanceAtomicUnits)),
  );

  return { wallet, snapshot };
}

export class PostgresWalletBalanceReader implements WalletBalanceReader {
  public constructor(private readonly database: Kysely<FinancialDatabaseSchema>) {}

  public async findByOwnerAndAsset(
    ownerId: WalletOwnerId,
    assetCode: AssetCode,
  ): Promise<WalletBalanceRecord | undefined> {
    const rows = await this.database
      .selectFrom("financial.wallets as wallet")
      .innerJoin("financial.assets as asset", "asset.code", "wallet.asset_code")
      .innerJoin("financial.ledger_accounts as account", "account.wallet_id", "wallet.id")
      .leftJoin("financial.journal_postings as posting", "posting.account_id", "account.id")
      .select([
        "wallet.id as walletId",
        "wallet.owner_id as ownerId",
        "wallet.asset_code as assetCode",
        "asset.ledger_scale as scale",
        "account.id as accountId",
        "account.kind as accountKind",
        sql<string>`COALESCE(SUM(
          CASE posting.direction
            WHEN 'credit' THEN posting.amount
            WHEN 'debit' THEN -posting.amount
          END
        ), 0)::TEXT`.as("balanceAtomicUnits"),
      ])
      .where("wallet.owner_id", "=", ownerId)
      .where("wallet.asset_code", "=", assetCode)
      .where("account.kind", "in", ["user_available", "user_reserved"])
      .groupBy([
        "wallet.id",
        "wallet.owner_id",
        "wallet.asset_code",
        "asset.ledger_scale",
        "account.id",
        "account.kind",
      ])
      .orderBy("account.kind")
      .execute();

    return rows.length === 0 ? undefined : mapWalletBalance(rows as readonly WalletBalanceRow[]);
  }
}
