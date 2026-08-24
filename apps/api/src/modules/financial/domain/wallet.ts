import type { AssetCode } from "./asset-code.js";
import type { AssetScale } from "./asset-scale.js";
import { FinancialInputValidationError } from "./financial-input-validation-error.js";
import { FinancialInvariantError } from "./financial-invariant-error.js";
import { LedgerAccount, type LedgerAccountId } from "./ledger-account.js";
import { isUuid } from "./uuid.js";

declare const walletIdBrand: unique symbol;
declare const walletOwnerIdBrand: unique symbol;

export type WalletId = string & {
  readonly [walletIdBrand]: "WalletId";
};

export type WalletOwnerId = string & {
  readonly [walletOwnerIdBrand]: "WalletOwnerId";
};

export function parseWalletId(input: string): WalletId {
  if (!isUuid(input)) {
    throw new FinancialInputValidationError("walletId", "WALLET_ID_INVALID");
  }

  return input as WalletId;
}

export function parseWalletOwnerId(input: string): WalletOwnerId {
  if (!isUuid(input)) {
    throw new FinancialInputValidationError("walletOwnerId", "WALLET_OWNER_ID_INVALID");
  }

  return input as WalletOwnerId;
}

export interface CreateWalletInput {
  readonly id: WalletId;
  readonly ownerId: WalletOwnerId;
  readonly assetCode: AssetCode;
  readonly scale: AssetScale;
  readonly availableAccountId: LedgerAccountId;
  readonly reservedAccountId: LedgerAccountId;
}

export class Wallet {
  public readonly availableAccount: LedgerAccount;
  public readonly reservedAccount: LedgerAccount;

  private constructor(
    public readonly id: WalletId,
    public readonly ownerId: WalletOwnerId,
    public readonly assetCode: AssetCode,
    public readonly scale: AssetScale,
    availableAccountId: LedgerAccountId,
    reservedAccountId: LedgerAccountId,
  ) {
    this.availableAccount = LedgerAccount.create({
      id: availableAccountId,
      assetCode,
      scale,
      kind: "user_available",
    });
    this.reservedAccount = LedgerAccount.create({
      id: reservedAccountId,
      assetCode,
      scale,
      kind: "user_reserved",
    });
    Object.freeze(this);
  }

  public static create(input: CreateWalletInput): Wallet {
    if (input.availableAccountId === input.reservedAccountId) {
      throw new FinancialInvariantError("WALLET_ACCOUNT_IDS_NOT_DISTINCT");
    }

    return new Wallet(
      input.id,
      input.ownerId,
      input.assetCode,
      input.scale,
      input.availableAccountId,
      input.reservedAccountId,
    );
  }
}
