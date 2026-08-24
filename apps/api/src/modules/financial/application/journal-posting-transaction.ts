import type { AssetCode } from "../domain/asset-code.js";
import type { LedgerAccount, LedgerAccountId, LedgerDirection } from "../domain/ledger-account.js";

export type FinancialJsonPrimitive = boolean | number | string | null;
export type FinancialJsonValue =
  FinancialJsonPrimitive | FinancialJsonValue[] | FinancialJsonObject;
export type FinancialJsonObject = { readonly [key: string]: FinancialJsonValue };

export interface LockedJournalAccount {
  readonly account: LedgerAccount;
  readonly assetStatus: "active" | "disabled";
  readonly creditAtomicUnits: bigint;
  readonly debitAtomicUnits: bigint;
}

export interface PersistedJournalReference {
  readonly id: string;
  readonly intentHash: string;
}

export interface PersistJournalPosting {
  readonly position: number;
  readonly accountId: LedgerAccountId;
  readonly assetCode: AssetCode;
  readonly direction: LedgerDirection;
  readonly amountAtomicUnits: bigint;
}

export interface PersistJournalInput {
  readonly operationType: string;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly businessReferences: FinancialJsonObject;
  readonly postings: readonly PersistJournalPosting[];
}

export type PersistJournalResult =
  | { readonly status: "created"; readonly journalId: string }
  | { readonly status: "existing"; readonly journal: PersistedJournalReference };

export interface JournalPostingTransaction {
  lockAccounts(accountIds: readonly LedgerAccountId[]): Promise<readonly LockedJournalAccount[]>;
  findJournal(
    idempotencyScope: string,
    idempotencyKey: string,
  ): Promise<PersistedJournalReference | undefined>;
  persistJournal(input: PersistJournalInput): Promise<PersistJournalResult>;
}

export interface JournalPostingTransactionRunner {
  execute<Result>(
    operation: (transaction: JournalPostingTransaction) => Promise<Result>,
  ): Promise<Result>;
}
