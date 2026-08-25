import { sql, type Kysely, type Transaction } from "kysely";

import type {
  LockedSimulatedWithdrawalAccounts,
  PersistedSimulatedWithdrawal,
  PersistSimulatedWithdrawalInput,
  SimulatedWithdrawalTransaction,
  SimulatedWithdrawalTransactionRunner,
} from "../../application/simulated-withdrawal-transaction.js";
import type { WalletCreationAsset } from "../../application/wallet-creation-transaction.js";
import { parseAssetCode, type AssetCode } from "../../domain/asset-code.js";
import { AssetQuantity } from "../../domain/asset-quantity.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import type { FinancialIdempotencyKey } from "../../domain/idempotency-key.js";
import { LedgerAccount, parseLedgerAccountId } from "../../domain/ledger-account.js";
import {
  parseSimulatedWithdrawalId,
  SimulatedWithdrawalRecord,
} from "../../domain/simulated-withdrawal.js";
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
  readonly assetCode: string;
  readonly kind: "external_custody" | "user_available" | "user_reserved";
  readonly scale: number;
  readonly walletId: string | null;
}

function mapWallet(row: PersistedWalletRow, accounts: readonly PersistedAccountRow[]): Wallet {
  const availableAccountId = accounts.find(({ kind }) => kind === "user_available")?.id;
  const reservedAccountId = accounts.find(({ kind }) => kind === "user_reserved")?.id;
  if (
    accounts.length !== 2 ||
    availableAccountId === undefined ||
    reservedAccountId === undefined
  ) {
    throw new Error("Persisted simulated-withdrawal wallet account pair is invalid");
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

class PostgresSimulatedWithdrawalTransaction implements SimulatedWithdrawalTransaction {
  public constructor(private readonly database: Transaction<FinancialDatabaseSchema>) {}

  public async lockIdempotencyKey(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`simulated_withdrawal:${ownerId}:${idempotencyKey}`}, 0)
    )`.execute(this.database);
  }

  public async findWithdrawal(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<PersistedSimulatedWithdrawal | undefined> {
    const row = await this.database
      .selectFrom("financial.withdrawals as withdrawal")
      .innerJoin("financial.wallets as wallet", "wallet.id", "withdrawal.wallet_id")
      .innerJoin("financial.assets as asset", "asset.code", "withdrawal.asset_code")
      .select([
        "withdrawal.id as withdrawalId",
        "withdrawal.amount as amount",
        "withdrawal.journal_id as journalId",
        "withdrawal.intent_hash as intentHash",
        "withdrawal.completed_at as completedAt",
        "wallet.id as id",
        "wallet.owner_id as ownerId",
        "wallet.asset_code as assetCode",
        "asset.ledger_scale as scale",
      ])
      .where("withdrawal.owner_id", "=", ownerId)
      .where("withdrawal.idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }

    const wallet = await this.loadWallet(row);
    const assetCode = parseAssetCode(row.assetCode);
    const scale = parseAssetScale(row.scale);
    return {
      record: SimulatedWithdrawalRecord.create({
        id: parseSimulatedWithdrawalId(row.withdrawalId),
        wallet,
        amount: AssetQuantity.fromAtomicUnits(assetCode, scale, BigInt(row.amount)),
        journalId: row.journalId,
        completedAt: row.completedAt.toISOString(),
      }),
      intentHash: row.intentHash,
    };
  }

  public async findAsset(assetCode: AssetCode): Promise<WalletCreationAsset | undefined> {
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

  public async findWallet(
    ownerId: WalletOwnerId,
    assetCode: AssetCode,
  ): Promise<Wallet | undefined> {
    const row = await this.database
      .selectFrom("financial.wallets as wallet")
      .innerJoin("financial.assets as asset", "asset.code", "wallet.asset_code")
      .select([
        "wallet.id as id",
        "wallet.owner_id as ownerId",
        "wallet.asset_code as assetCode",
        "asset.ledger_scale as scale",
      ])
      .where("wallet.owner_id", "=", ownerId)
      .where("wallet.asset_code", "=", assetCode)
      .executeTakeFirst();
    return row === undefined ? undefined : this.loadWallet(row);
  }

  public async lockAccounts(wallet: Wallet): Promise<LockedSimulatedWithdrawalAccounts> {
    const rows = await this.database
      .selectFrom("financial.ledger_accounts as account")
      .innerJoin("financial.assets as asset", "asset.code", "account.asset_code")
      .select([
        "account.id as id",
        "account.asset_code as assetCode",
        "account.kind as kind",
        "account.wallet_id as walletId",
        "asset.ledger_scale as scale",
      ])
      .where("account.asset_code", "=", wallet.assetCode)
      .where((expression) =>
        expression.or([
          expression("account.id", "=", wallet.availableAccount.id),
          expression.and([
            expression("account.kind", "=", "external_custody"),
            expression("account.wallet_id", "is", null),
          ]),
        ]),
      )
      .orderBy("account.id")
      .forUpdate("account")
      .execute();
    const accounts = rows.map((row) => ({
      row,
      account: LedgerAccount.create({
        id: parseLedgerAccountId(row.id),
        assetCode: parseAssetCode(row.assetCode),
        scale: parseAssetScale(row.scale),
        kind: row.kind,
      }),
    }));
    const custody = accounts.find(({ row }) => row.kind === "external_custody")?.account;
    const available = accounts.find(
      ({ row }) => row.kind === "user_available" && row.walletId === wallet.id,
    )?.account;
    if (accounts.length !== 2 || custody === undefined || available === undefined) {
      throw new Error("Simulated-withdrawal ledger account pair is invalid");
    }

    const totals = await this.database
      .selectFrom("financial.journal_postings")
      .select([
        sql<string>`COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::TEXT`.as(
          "credits",
        ),
        sql<string>`COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::TEXT`.as("debits"),
      ])
      .where("account_id", "=", available.id)
      .executeTakeFirstOrThrow();

    return {
      available,
      custody,
      availableBalanceAtomicUnits: BigInt(totals.credits) - BigInt(totals.debits),
    };
  }

  public async persistWithdrawal(
    input: PersistSimulatedWithdrawalInput,
  ): Promise<PersistedSimulatedWithdrawal> {
    const identifiers = await sql<{ withdrawalId: string; journalId: string }>`
      SELECT uuidv7() AS "withdrawalId", uuidv7() AS "journalId"
    `.execute(this.database);
    const values = identifiers.rows[0];
    if (values === undefined) {
      throw new Error("Simulated-withdrawal identifiers were not generated");
    }

    await this.database
      .insertInto("financial.journal_transactions")
      .values({
        id: values.journalId,
        operation_type: "simulated_withdrawal",
        idempotency_scope: `simulated_withdrawal:${input.ownerId}`,
        idempotency_key: input.idempotencyKey,
        intent_hash: input.intentHash,
        business_references: {
          method: "simulated",
          walletId: input.wallet.id,
          withdrawalId: values.withdrawalId,
        },
      })
      .execute();
    await this.database
      .insertInto("financial.journal_postings")
      .values(
        input.journal.postings.map((posting) => ({
          journal_id: values.journalId,
          position: posting.position,
          account_id: posting.account.id,
          asset_code: posting.account.assetCode,
          direction: posting.direction,
          amount: posting.amount.atomicUnits.toString(),
        })),
      )
      .execute();
    const withdrawal = await this.database
      .insertInto("financial.withdrawals")
      .values({
        id: values.withdrawalId,
        owner_id: input.ownerId,
        wallet_id: input.wallet.id,
        asset_code: input.amount.assetCode,
        amount: input.amount.atomicUnits.toString(),
        method: "simulated",
        status: "completed",
        journal_id: values.journalId,
        idempotency_key: input.idempotencyKey,
        intent_hash: input.intentHash,
      })
      .returning("completed_at as completedAt")
      .executeTakeFirstOrThrow();

    return {
      record: SimulatedWithdrawalRecord.create({
        id: parseSimulatedWithdrawalId(values.withdrawalId),
        wallet: input.wallet,
        amount: input.amount,
        journalId: values.journalId,
        completedAt: withdrawal.completedAt.toISOString(),
      }),
      intentHash: input.intentHash,
    };
  }

  private async loadWallet(row: PersistedWalletRow): Promise<Wallet> {
    const accounts = await this.database
      .selectFrom("financial.ledger_accounts as account")
      .innerJoin("financial.assets as asset", "asset.code", "account.asset_code")
      .select([
        "account.id as id",
        "account.asset_code as assetCode",
        "account.kind as kind",
        "account.wallet_id as walletId",
        "asset.ledger_scale as scale",
      ])
      .where("account.wallet_id", "=", row.id)
      .where("account.kind", "in", ["user_available", "user_reserved"])
      .orderBy("account.kind")
      .execute();
    return mapWallet(row, accounts as PersistedAccountRow[]);
  }
}

export class PostgresSimulatedWithdrawalTransactionRunner implements SimulatedWithdrawalTransactionRunner {
  public constructor(private readonly database: Kysely<FinancialDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: SimulatedWithdrawalTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresSimulatedWithdrawalTransaction(database)));
  }
}
