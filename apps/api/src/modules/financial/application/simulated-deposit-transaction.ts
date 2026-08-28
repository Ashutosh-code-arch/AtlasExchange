import type { AssetQuantity } from "../domain/asset-quantity.js";
import type { AssetCode } from "../domain/asset-code.js";
import type { FinancialIdempotencyKey } from "../domain/idempotency-key.js";
import type { JournalTransaction } from "../domain/journal-transaction.js";
import type { LedgerAccount } from "../domain/ledger-account.js";
import type { SimulatedDepositRecord } from "../domain/simulated-deposit.js";
import type { Wallet, WalletOwnerId } from "../domain/wallet.js";
import type {
  CreateOrGetWalletInput,
  PersistWalletResult,
  WalletCreationAsset,
} from "./wallet-creation-transaction.js";
import type { FinancialNotificationPublisher } from "./financial-notification-publisher.js";

export interface LockedSimulatedDepositAccounts {
  readonly available: LedgerAccount;
  readonly custody: LedgerAccount;
}

export interface PersistSimulatedDepositInput {
  readonly ownerId: WalletOwnerId;
  readonly wallet: Wallet;
  readonly amount: AssetQuantity;
  readonly idempotencyKey: FinancialIdempotencyKey;
  readonly intentHash: string;
  readonly journal: JournalTransaction;
}

export interface PersistedSimulatedDeposit {
  readonly record: SimulatedDepositRecord;
  readonly intentHash: string;
}

export interface SimulatedDepositTransaction {
  readonly notifications: Pick<FinancialNotificationPublisher, "depositCredited">;
  lockIdempotencyKey(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<void>;
  findDeposit(
    ownerId: WalletOwnerId,
    idempotencyKey: FinancialIdempotencyKey,
  ): Promise<PersistedSimulatedDeposit | undefined>;
  findAsset(assetCode: AssetCode): Promise<WalletCreationAsset | undefined>;
  createOrGetWallet(input: CreateOrGetWalletInput): Promise<PersistWalletResult>;
  lockAccounts(wallet: Wallet): Promise<LockedSimulatedDepositAccounts>;
  persistDeposit(input: PersistSimulatedDepositInput): Promise<PersistedSimulatedDeposit>;
}

export interface SimulatedDepositTransactionRunner {
  execute<Result>(
    operation: (transaction: SimulatedDepositTransaction) => Promise<Result>,
  ): Promise<Result>;
}
