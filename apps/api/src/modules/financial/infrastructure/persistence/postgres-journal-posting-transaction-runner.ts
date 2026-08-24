import { sql, type Kysely, type Transaction } from "kysely";

import type {
  JournalPostingTransaction,
  JournalPostingTransactionRunner,
  LockedJournalAccount,
  PersistedJournalReference,
  PersistJournalInput,
  PersistJournalResult,
} from "../../application/journal-posting-transaction.js";
import { parseAssetCode } from "../../domain/asset-code.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import {
  LedgerAccount,
  parseLedgerAccountId,
  type LedgerAccountId,
} from "../../domain/ledger-account.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

interface AccountTotalsRow {
  readonly accountId: string;
  readonly creditAtomicUnits: string;
  readonly debitAtomicUnits: string;
}

class PostgresJournalPostingTransaction implements JournalPostingTransaction {
  public constructor(private readonly database: Transaction<FinancialDatabaseSchema>) {}

  public async lockAccounts(
    accountIds: readonly LedgerAccountId[],
  ): Promise<readonly LockedJournalAccount[]> {
    if (accountIds.length === 0) {
      return [];
    }

    const rows = await this.database
      .selectFrom("financial.ledger_accounts as account")
      .innerJoin("financial.assets as asset", "asset.code", "account.asset_code")
      .select([
        "account.id as id",
        "account.asset_code as assetCode",
        "account.kind as kind",
        "asset.ledger_scale as scale",
        "asset.status as assetStatus",
      ])
      .where("account.id", "in", accountIds)
      .orderBy("account.id")
      .forUpdate("account")
      .forShare("asset")
      .execute();

    const totals = await this.database
      .selectFrom("financial.journal_postings")
      .select([
        "account_id as accountId",
        sql<string>`COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::TEXT`.as(
          "creditAtomicUnits",
        ),
        sql<string>`COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::TEXT`.as(
          "debitAtomicUnits",
        ),
      ])
      .where("account_id", "in", accountIds)
      .groupBy("account_id")
      .execute();
    const totalsByAccount = new Map(
      (totals as readonly AccountTotalsRow[]).map((row) => [row.accountId, row]),
    );

    return rows.map((row) => {
      const accountTotals = totalsByAccount.get(row.id);
      return {
        account: LedgerAccount.create({
          id: parseLedgerAccountId(row.id),
          assetCode: parseAssetCode(row.assetCode),
          scale: parseAssetScale(row.scale),
          kind: row.kind,
        }),
        assetStatus: row.assetStatus,
        creditAtomicUnits: BigInt(accountTotals?.creditAtomicUnits ?? "0"),
        debitAtomicUnits: BigInt(accountTotals?.debitAtomicUnits ?? "0"),
      };
    });
  }

  public async findJournal(
    idempotencyScope: string,
    idempotencyKey: string,
  ): Promise<PersistedJournalReference | undefined> {
    const row = await this.database
      .selectFrom("financial.journal_transactions")
      .select(["id", "intent_hash as intentHash"])
      .where("idempotency_scope", "=", idempotencyScope)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row;
  }

  public async persistJournal(input: PersistJournalInput): Promise<PersistJournalResult> {
    const inserted = await this.database
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: input.operationType,
        idempotency_scope: input.idempotencyScope,
        idempotency_key: input.idempotencyKey,
        intent_hash: input.intentHash,
        business_references: input.businessReferences,
      })
      .onConflict((conflict) =>
        conflict.columns(["idempotency_scope", "idempotency_key"]).doNothing(),
      )
      .returning("id")
      .executeTakeFirst();

    if (inserted === undefined) {
      const existing = await this.findJournal(input.idempotencyScope, input.idempotencyKey);
      if (existing === undefined) {
        throw new Error("Conflicting Financial journal could not be loaded");
      }
      return { status: "existing", journal: existing };
    }

    await this.database
      .insertInto("financial.journal_postings")
      .values(
        input.postings.map((posting) => ({
          journal_id: inserted.id,
          position: posting.position,
          account_id: posting.accountId,
          asset_code: posting.assetCode,
          direction: posting.direction,
          amount: posting.amountAtomicUnits.toString(),
        })),
      )
      .execute();

    return { status: "created", journalId: inserted.id };
  }
}

export class PostgresJournalPostingTransactionRunner implements JournalPostingTransactionRunner {
  public constructor(private readonly database: Kysely<FinancialDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: JournalPostingTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresJournalPostingTransaction(database)));
  }
}
