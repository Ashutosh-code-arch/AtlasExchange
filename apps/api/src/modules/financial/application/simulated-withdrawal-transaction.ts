import type { AssetCode } from "../domain/asset-code.js";
import type { AssetQuantity } from "../domain/asset-quantity.js";
import type { FinancialIdempotencyKey } from "../domain/idempotency-key.js";
import type { JournalTransaction } from "../domain/journal-transaction.js";
import type { LedgerAccount } from "../domain/ledger-account.js";
import type { SimulatedWithdrawalRecord } from "../domain/simulated-withdrawal.js";
import type { Wallet, WalletOwnerId } from "../domain/wallet.js";
import type { WalletCreationAsset } from "./wallet-creation-transaction.js";

export interface LockedSimulatedWithdrawalAccounts {
  readonly available: LedgerAccount;
  readonly custody: LedgerAccount;
  readonly availableBalanceAtomicUnits: bigint;
}

export interface PersistSimulatedWithdrawalInput {
  readonly ownerId: WalletOwnerId;
  readonly wallet: Wallet;
  readonly amount: AssetQuantity;
  readonly idempotencyKey: FinancialIdempotencyKey;
  readonly intentHash: string;
  readonly journal: JournalTransaction;
}

export interface PersistedSimulatedWithdrawal {
  readonly record: SimulatedWithdrawalRecord;
  readonly intentHash: string;
}

export interface SimulatedWithdrawalTransaction {
  lockIdempotencyKey(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<void>;
  findWithdrawal(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<PersistedSimulatedWithdrawal | undefined>;
  findAsset(assetCode: AssetCode): Promise<WalletCreationAsset | undefined>;
  findWallet(ownerId: WalletOwnerId, assetCode: AssetCode): Promise<Wallet | undefined>;
  lockAccounts(wallet: Wallet): Promise<LockedSimulatedWithdrawalAccounts>;
  persistWithdrawal(input: PersistSimulatedWithdrawalInput): Promise<PersistedSimulatedWithdrawal>;
}

export interface SimulatedWithdrawalTransactionRunner {
  execute<Result>(
    operation: (transaction: SimulatedWithdrawalTransaction) => Promise<Result>,
  ): Promise<Result>;
}
