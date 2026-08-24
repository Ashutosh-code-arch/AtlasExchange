import type { AssetCode } from "./asset-code.js";
import type { AssetScale } from "./asset-scale.js";
import { FinancialInputValidationError } from "./financial-input-validation-error.js";
import { isUuid } from "./uuid.js";

declare const ledgerAccountIdBrand: unique symbol;

export type LedgerAccountId = string & {
  readonly [ledgerAccountIdBrand]: "LedgerAccountId";
};

export type LedgerDirection = "credit" | "debit";

export type LedgerAccountKind =
  "external_custody" | "fee_revenue" | "user_available" | "user_reserved";

interface LedgerAccountPolicy {
  readonly normalSide: LedgerDirection;
  readonly requiresNonNegativeBalance: boolean;
}

const ledgerAccountPolicies: Readonly<Record<LedgerAccountKind, LedgerAccountPolicy>> = {
  external_custody: { normalSide: "debit", requiresNonNegativeBalance: false },
  fee_revenue: { normalSide: "credit", requiresNonNegativeBalance: false },
  user_available: { normalSide: "credit", requiresNonNegativeBalance: true },
  user_reserved: { normalSide: "credit", requiresNonNegativeBalance: true },
};

export function parseLedgerAccountId(input: string): LedgerAccountId {
  if (!isUuid(input)) {
    throw new FinancialInputValidationError("ledgerAccountId", "LEDGER_ACCOUNT_ID_INVALID");
  }

  return input as LedgerAccountId;
}

export interface CreateLedgerAccountInput {
  readonly id: LedgerAccountId;
  readonly assetCode: AssetCode;
  readonly scale: AssetScale;
  readonly kind: LedgerAccountKind;
}

export class LedgerAccount {
  public readonly normalSide: LedgerDirection;
  public readonly requiresNonNegativeBalance: boolean;

  private constructor(
    public readonly id: LedgerAccountId,
    public readonly assetCode: AssetCode,
    public readonly scale: AssetScale,
    public readonly kind: LedgerAccountKind,
  ) {
    const policy = ledgerAccountPolicies[kind];
    this.normalSide = policy.normalSide;
    this.requiresNonNegativeBalance = policy.requiresNonNegativeBalance;
    Object.freeze(this);
  }

  public static create(input: CreateLedgerAccountInput): LedgerAccount {
    return new LedgerAccount(input.id, input.assetCode, input.scale, input.kind);
  }
}

export function ledgerAccountDefinitionsMatch(left: LedgerAccount, right: LedgerAccount): boolean {
  return (
    left.id === right.id &&
    left.assetCode === right.assetCode &&
    left.scale === right.scale &&
    left.kind === right.kind &&
    left.normalSide === right.normalSide &&
    left.requiresNonNegativeBalance === right.requiresNonNegativeBalance
  );
}
