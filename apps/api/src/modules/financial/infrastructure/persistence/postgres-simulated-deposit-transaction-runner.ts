import { sql, type Kysely, type Transaction } from "kysely";

import type {
  LockedSimulatedDepositAccounts,
  PersistedSimulatedDeposit,
  PersistSimulatedDepositInput,
  SimulatedDepositTransaction,
  SimulatedDepositTransactionRunner,
} from "../../application/simulated-deposit-transaction.js";
import type { FinancialNotificationPublisher } from "../../application/financial-notification-publisher.js";
import type {
  CreateOrGetWalletInput,
  PersistWalletResult,
  WalletCreationAsset,
} from "../../application/wallet-creation-transaction.js";
import { parseAssetCode, type AssetCode } from "../../domain/asset-code.js";
import { AssetQuantity } from "../../domain/asset-quantity.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import type { FinancialIdempotencyKey } from "../../domain/idempotency-key.js";
import { LedgerAccount, parseLedgerAccountId } from "../../domain/ledger-account.js";
import { parseSimulatedDepositId, SimulatedDepositRecord } from "../../domain/simulated-deposit.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
  type WalletOwnerId,
} from "../../domain/wallet.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";
import type { FinancialNotificationPublisherFactory } from "./financial-notification-publisher-factory.js";

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
    throw new Error("Persisted simulated-deposit wallet account pair is invalid");
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

class PostgresSimulatedDepositTransaction implements SimulatedDepositTransaction {
  public constructor(
    private readonly database: Transaction<FinancialDatabaseSchema>,
    public readonly notifications: Pick<FinancialNotificationPublisher, "depositCredited">,
  ) {}

  public async lockIdempotencyKey(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`${ownerId}:${idempotencyKey}`}, 0)
    )`.execute(this.database);
  }

  public async findDeposit(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<PersistedSimulatedDeposit | undefined> {
    const row = await this.database
      .selectFrom("financial.deposits as deposit")
      .innerJoin("financial.wallets as wallet", "wallet.id", "deposit.wallet_id")
      .innerJoin("financial.assets as asset", "asset.code", "deposit.asset_code")
      .select([
        "deposit.id as depositId",
        "deposit.amount as amount",
        "deposit.journal_id as journalId",
        "deposit.intent_hash as intentHash",
        "deposit.credited_at as creditedAt",
        "wallet.id as id",
        "wallet.owner_id as ownerId",
        "wallet.asset_code as assetCode",
        "asset.ledger_scale as scale",
      ])
      .where("deposit.owner_id", "=", ownerId)
      .where("deposit.idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }

    const wallet = await this.loadWallet(row);
    const assetCode = parseAssetCode(row.assetCode);
    const scale = parseAssetScale(row.scale);
    return {
      record: SimulatedDepositRecord.create({
        id: parseSimulatedDepositId(row.depositId),
        wallet,
        amount: AssetQuantity.fromAtomicUnits(assetCode, scale, BigInt(row.amount)),
        journalId: row.journalId,
        creditedAt: row.creditedAt.toISOString(),
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
        throw new Error("Conflicting simulated-deposit wallet could not be loaded");
      }
      return { status: "existing", wallet: existing };
    }

    const accounts = await this.database
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
      .returning(["id", "asset_code as assetCode", "kind", "wallet_id as walletId"])
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
        accounts.map((account) => ({ ...account, scale: input.scale })) as PersistedAccountRow[],
      ),
    };
  }

  public async lockAccounts(wallet: Wallet): Promise<LockedSimulatedDepositAccounts> {
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
      throw new Error("Simulated-deposit ledger account pair is invalid");
    }
    return { available, custody };
  }

  public async persistDeposit(
    input: PersistSimulatedDepositInput,
  ): Promise<PersistedSimulatedDeposit> {
    const identifiers = await sql<{ depositId: string; journalId: string }>`
      SELECT uuidv7() AS "depositId", uuidv7() AS "journalId"
    `.execute(this.database);
    const values = identifiers.rows[0];
    if (values === undefined) {
      throw new Error("Simulated-deposit identifiers were not generated");
    }

    await this.database
      .insertInto("financial.journal_transactions")
      .values({
        id: values.journalId,
        operation_type: "simulated_deposit",
        idempotency_scope: `simulated_deposit:${input.ownerId}`,
        idempotency_key: input.idempotencyKey,
        intent_hash: input.intentHash,
        business_references: {
          depositId: values.depositId,
          method: "simulated",
          walletId: input.wallet.id,
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
    const deposit = await this.database
      .insertInto("financial.deposits")
      .values({
        id: values.depositId,
        owner_id: input.ownerId,
        wallet_id: input.wallet.id,
        asset_code: input.amount.assetCode,
        amount: input.amount.atomicUnits.toString(),
        method: "simulated",
        status: "credited",
        journal_id: values.journalId,
        idempotency_key: input.idempotencyKey,
        intent_hash: input.intentHash,
      })
      .returning("credited_at as creditedAt")
      .executeTakeFirstOrThrow();

    return {
      record: SimulatedDepositRecord.create({
        id: parseSimulatedDepositId(values.depositId),
        wallet: input.wallet,
        amount: input.amount,
        journalId: values.journalId,
        creditedAt: deposit.creditedAt.toISOString(),
      }),
      intentHash: input.intentHash,
    };
  }

  private async findWallet(
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

export class PostgresSimulatedDepositTransactionRunner implements SimulatedDepositTransactionRunner {
  public constructor(
    private readonly database: Kysely<FinancialDatabaseSchema>,
    private readonly notificationPublisherFactory: FinancialNotificationPublisherFactory,
  ) {}

  public execute<Result>(
    operation: (transaction: SimulatedDepositTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) =>
        operation(
          new PostgresSimulatedDepositTransaction(
            database,
            this.notificationPublisherFactory(database),
          ),
        ),
      );
  }
}
