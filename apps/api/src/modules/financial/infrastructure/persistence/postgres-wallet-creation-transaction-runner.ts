import type { Kysely, Transaction } from "kysely";

import type {
  CreateOrGetWalletInput,
  PersistWalletResult,
  WalletCreationAsset,
  WalletCreationTransaction,
  WalletCreationTransactionRunner,
} from "../../application/wallet-creation-transaction.js";
import type { AssetCode } from "../../domain/asset-code.js";
import { parseAssetCode } from "../../domain/asset-code.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import { parseLedgerAccountId } from "../../domain/ledger-account.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
  type WalletOwnerId,
} from "../../domain/wallet.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

interface PersistedWalletRow {
  readonly id: string;
  readonly ownerId: string;
  readonly assetCode: string;
  readonly scale: number;
}

interface PersistedAccountRow {
  readonly id: string;
  readonly kind: "user_available" | "user_reserved";
}

function mapWallet(row: PersistedWalletRow, accounts: readonly PersistedAccountRow[]): Wallet {
  const availableAccountId = accounts.find(({ kind }) => kind === "user_available")?.id;
  const reservedAccountId = accounts.find(({ kind }) => kind === "user_reserved")?.id;
  if (
    accounts.length !== 2 ||
    availableAccountId === undefined ||
    reservedAccountId === undefined
  ) {
    throw new Error("Persisted Financial wallet account pair is invalid");
  }

  return Wallet.create({
    id: parseWalletId(row.id),
    ownerId: parseWalletOwnerId(row.ownerId),
    assetCode: parseAssetCode(row.assetCode),
    scale: parseAssetScale(row.scale),
    availableAccountId: parseLedgerAccountId(availableAccountId),
    reservedAccountId: parseLedgerAccountId(reservedAccountId),
  });
}

class PostgresWalletCreationTransaction implements WalletCreationTransaction {
  public constructor(private readonly database: Transaction<FinancialDatabaseSchema>) {}

  public async findWallet(
    ownerId: WalletOwnerId,
    assetCode: AssetCode,
  ): Promise<Wallet | undefined> {
    const row = await this.database
      .selectFrom("financial.wallets")
      .innerJoin("financial.assets", "financial.assets.code", "financial.wallets.asset_code")
      .select([
        "financial.wallets.id as id",
        "financial.wallets.owner_id as ownerId",
        "financial.wallets.asset_code as assetCode",
        "financial.assets.ledger_scale as scale",
      ])
      .where("financial.wallets.owner_id", "=", ownerId)
      .where("financial.wallets.asset_code", "=", assetCode)
      .executeTakeFirst();

    return row === undefined ? undefined : this.loadWalletAccounts(row);
  }

  public async findAssetForWalletCreation(
    assetCode: AssetCode,
  ): Promise<WalletCreationAsset | undefined> {
    const row = await this.database
      .selectFrom("financial.assets")
      .select(["code", "ledger_scale", "status"])
      .where("code", "=", assetCode)
      .forShare()
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          code: parseAssetCode(row.code),
          scale: parseAssetScale(row.ledger_scale),
          status: row.status,
        };
  }

  public async createOrGetWallet(input: CreateOrGetWalletInput): Promise<PersistWalletResult> {
    const inserted = await this.database
      .insertInto("financial.wallets")
      .values({ owner_id: input.ownerId, asset_code: input.assetCode })
      .onConflict((conflict) => conflict.columns(["owner_id", "asset_code"]).doNothing())
      .returning("id")
      .executeTakeFirst();

    if (inserted === undefined) {
      const existing = await this.findWallet(input.ownerId, input.assetCode);
      if (existing === undefined) {
        throw new Error("Conflicting Financial wallet could not be loaded");
      }
      return { status: "existing", wallet: existing };
    }

    const accountRows = await this.database
      .insertInto("financial.ledger_accounts")
      .values([
        {
          asset_code: input.assetCode,
          kind: "user_available",
          wallet_id: inserted.id,
        },
        {
          asset_code: input.assetCode,
          kind: "user_reserved",
          wallet_id: inserted.id,
        },
      ])
      .returning(["id", "kind"])
      .execute();

    return {
      status: "created",
      wallet: mapWallet(
        {
          id: inserted.id,
          ownerId: input.ownerId,
          assetCode: input.assetCode,
          scale: input.scale,
        },
        accountRows as readonly PersistedAccountRow[],
      ),
    };
  }

  private async loadWalletAccounts(row: PersistedWalletRow): Promise<Wallet> {
    const accounts = await this.database
      .selectFrom("financial.ledger_accounts")
      .select(["id", "kind"])
      .where("wallet_id", "=", row.id)
      .where("kind", "in", ["user_available", "user_reserved"])
      .orderBy("kind")
      .execute();

    return mapWallet(row, accounts as readonly PersistedAccountRow[]);
  }
}

export class PostgresWalletCreationTransactionRunner implements WalletCreationTransactionRunner {
  public constructor(private readonly database: Kysely<FinancialDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: WalletCreationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresWalletCreationTransaction(database)));
  }
}
