import { maximumAtomicUnits } from "./asset-quantity.js";
import type { AssetQuantity } from "./asset-quantity.js";
import { FinancialInvariantError } from "./financial-invariant-error.js";
import type { JournalTransaction } from "./journal-transaction.js";
import { ledgerAccountDefinitionsMatch, type LedgerAccount } from "./ledger-account.js";

export function evaluateLedgerAccountBalance(
  account: LedgerAccount,
  openingBalance: AssetQuantity,
  journal: JournalTransaction,
): bigint {
  if (openingBalance.assetCode !== account.assetCode || openingBalance.scale !== account.scale) {
    throw new FinancialInvariantError("ACCOUNT_OPENING_BALANCE_DENOMINATION_MISMATCH");
  }

  return evaluateLedgerAccountBalanceFromAtomicUnits(account, openingBalance.atomicUnits, journal);
}

export function evaluateLedgerAccountBalanceFromAtomicUnits(
  account: LedgerAccount,
  openingAtomicUnits: bigint,
  journal: JournalTransaction,
): bigint {
  let closingAtomicUnits = openingAtomicUnits;
  for (const posting of journal.postings) {
    if (posting.account.id !== account.id) {
      continue;
    }
    if (!ledgerAccountDefinitionsMatch(account, posting.account)) {
      throw new FinancialInvariantError("ACCOUNT_DEFINITION_MISMATCH");
    }

    closingAtomicUnits +=
      posting.direction === account.normalSide
        ? posting.amount.atomicUnits
        : -posting.amount.atomicUnits;
  }

  if (account.requiresNonNegativeBalance && closingAtomicUnits < 0n) {
    throw new FinancialInvariantError("ACCOUNT_BALANCE_NEGATIVE");
  }
  if (closingAtomicUnits > maximumAtomicUnits || closingAtomicUnits < -maximumAtomicUnits) {
    throw new FinancialInvariantError("ACCOUNT_BALANCE_OVERFLOW");
  }

  return closingAtomicUnits;
}
