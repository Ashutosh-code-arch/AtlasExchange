import { FinancialInvariantError } from "./financial-invariant-error.js";
import type { JournalPosting } from "./journal-posting.js";
import { ledgerAccountDefinitionsMatch, type LedgerAccount } from "./ledger-account.js";

interface AssetTotals {
  readonly scale: number;
  credit: bigint;
  debit: bigint;
}

function validatePostingSequence(postings: readonly JournalPosting[]): void {
  if (postings.some((posting, index) => posting.position !== index + 1)) {
    throw new FinancialInvariantError("JOURNAL_POSITION_SEQUENCE_INVALID");
  }
}

function validateAccountDefinitions(postings: readonly JournalPosting[]): void {
  const accounts = new Map<string, LedgerAccount>();

  for (const posting of postings) {
    const existing = accounts.get(posting.account.id);
    if (existing !== undefined && !ledgerAccountDefinitionsMatch(existing, posting.account)) {
      throw new FinancialInvariantError("ACCOUNT_DEFINITION_MISMATCH");
    }
    accounts.set(posting.account.id, posting.account);
  }
}

function validateBalancedByAsset(postings: readonly JournalPosting[]): void {
  const totalsByAsset = new Map<string, AssetTotals>();

  for (const posting of postings) {
    const existing = totalsByAsset.get(posting.account.assetCode);
    if (existing !== undefined && existing.scale !== posting.account.scale) {
      throw new FinancialInvariantError("JOURNAL_ASSET_SCALE_MISMATCH");
    }

    const totals = existing ?? { scale: posting.account.scale, credit: 0n, debit: 0n };
    totals[posting.direction] += posting.amount.atomicUnits;
    totalsByAsset.set(posting.account.assetCode, totals);
  }

  if ([...totalsByAsset.values()].some(({ credit, debit }) => credit !== debit)) {
    throw new FinancialInvariantError("JOURNAL_UNBALANCED");
  }
}

export class JournalTransaction {
  private constructor(public readonly postings: readonly JournalPosting[]) {
    Object.freeze(this);
  }

  public static create(postings: readonly JournalPosting[]): JournalTransaction {
    if (postings.length < 2) {
      throw new FinancialInvariantError("JOURNAL_TOO_FEW_POSTINGS");
    }

    const immutablePostings = Object.freeze([...postings]);
    validatePostingSequence(immutablePostings);
    validateAccountDefinitions(immutablePostings);
    validateBalancedByAsset(immutablePostings);

    return new JournalTransaction(immutablePostings);
  }
}
