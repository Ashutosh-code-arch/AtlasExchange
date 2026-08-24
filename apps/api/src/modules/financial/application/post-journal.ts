import { createHash } from "node:crypto";

import { AssetQuantity } from "../domain/asset-quantity.js";
import { FinancialInputValidationError } from "../domain/financial-input-validation-error.js";
import { JournalPosting } from "../domain/journal-posting.js";
import { JournalTransaction } from "../domain/journal-transaction.js";
import {
  parseLedgerAccountId,
  type LedgerAccountId,
  type LedgerDirection,
} from "../domain/ledger-account.js";
import { evaluateLedgerAccountBalanceFromAtomicUnits } from "../domain/ledger-balance.js";
import type {
  FinancialJsonObject,
  FinancialJsonValue,
  JournalPostingTransactionRunner,
  PersistedJournalReference,
} from "./journal-posting-transaction.js";

const operationIdentifierPattern = /^[a-z][a-z0-9_.:-]{0,99}$/;
const maximumIdempotencyKeyLength = 200;

export interface PostJournalPostingCommand {
  readonly accountId: string;
  readonly direction: LedgerDirection;
  readonly amount: string;
}

export interface PostJournalCommand {
  readonly operationType: string;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly businessReferences?: FinancialJsonObject;
  readonly postings: readonly PostJournalPostingCommand[];
}

export type PostJournalResult =
  | { readonly status: "account_not_found" }
  | { readonly status: "asset_disabled" }
  | { readonly status: "created"; readonly journalId: string }
  | { readonly status: "existing"; readonly journalId: string }
  | { readonly status: "idempotency_conflict"; readonly journalId: string };

interface PreparedPostingCommand {
  readonly accountId: LedgerAccountId;
  readonly direction: LedgerDirection;
  readonly amount: string;
}

function validateOperationIdentifier(
  value: string,
  field: "idempotencyScope" | "journalOperationType",
): string {
  if (!operationIdentifierPattern.test(value)) {
    throw new FinancialInputValidationError(
      field,
      field === "idempotencyScope" ? "IDEMPOTENCY_SCOPE_INVALID" : "JOURNAL_OPERATION_TYPE_INVALID",
    );
  }
  return value;
}

function validateIdempotencyKey(value: string): string {
  if (value !== value.trim() || value.length < 1 || value.length > maximumIdempotencyKeyLength) {
    throw new FinancialInputValidationError("idempotencyKey", "IDEMPOTENCY_KEY_INVALID");
  }
  return value;
}

function canonicalizeJsonValue(value: unknown, ancestors: Set<object>): FinancialJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FinancialInputValidationError("businessReferences", "BUSINESS_REFERENCES_INVALID");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new FinancialInputValidationError("businessReferences", "BUSINESS_REFERENCES_INVALID");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeJsonValue(item, ancestors));
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new FinancialInputValidationError("businessReferences", "BUSINESS_REFERENCES_INVALID");
    }

    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalizeJsonValue((value as Record<string, unknown>)[key], ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeBusinessReferences(value: unknown): FinancialJsonObject {
  const canonical = canonicalizeJsonValue(value ?? {}, new Set());
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") {
    throw new FinancialInputValidationError("businessReferences", "BUSINESS_REFERENCES_INVALID");
  }
  return canonical;
}

function preparePostingCommands(
  postings: readonly PostJournalPostingCommand[],
): readonly PreparedPostingCommand[] {
  return postings.map((posting) => {
    const direction: unknown = posting.direction;
    if (direction !== "credit" && direction !== "debit") {
      throw new FinancialInputValidationError("postingDirection", "POSTING_DIRECTION_INVALID");
    }
    return {
      accountId: parseLedgerAccountId(posting.accountId.toLowerCase()),
      direction,
      amount: posting.amount,
    };
  });
}

function compareExistingJournal(
  existing: PersistedJournalReference,
  intentHash: string,
): PostJournalResult {
  return existing.intentHash === intentHash
    ? { status: "existing", journalId: existing.id }
    : { status: "idempotency_conflict", journalId: existing.id };
}

export class PostJournal {
  public constructor(private readonly transactionRunner: JournalPostingTransactionRunner) {}

  public execute(command: PostJournalCommand): Promise<PostJournalResult> {
    const operationType = validateOperationIdentifier(
      command.operationType,
      "journalOperationType",
    );
    const idempotencyScope = validateOperationIdentifier(
      command.idempotencyScope,
      "idempotencyScope",
    );
    const idempotencyKey = validateIdempotencyKey(command.idempotencyKey);
    const businessReferences = canonicalizeBusinessReferences(command.businessReferences);
    const preparedPostings = preparePostingCommands(command.postings);
    const accountIds = [...new Set(preparedPostings.map(({ accountId }) => accountId))].sort();

    return this.transactionRunner.execute(async (transaction) => {
      const lockedAccounts = await transaction.lockAccounts(accountIds);
      if (lockedAccounts.length !== accountIds.length) {
        return { status: "account_not_found" };
      }

      const accountsById = new Map(
        lockedAccounts.map((lockedAccount) => [lockedAccount.account.id, lockedAccount]),
      );
      const postings = preparedPostings.map((posting, index) => {
        const lockedAccount = accountsById.get(posting.accountId);
        if (lockedAccount === undefined) {
          throw new Error("Locked Financial account could not be resolved");
        }
        return JournalPosting.create({
          position: index + 1,
          account: lockedAccount.account,
          direction: posting.direction,
          amount: AssetQuantity.parse(
            lockedAccount.account.assetCode,
            lockedAccount.account.scale,
            posting.amount,
          ),
        });
      });
      const journal = JournalTransaction.create(postings);
      const intentHash = createHash("sha256")
        .update(
          JSON.stringify({
            businessReferences,
            operationType,
            postings: postings.map((posting) => ({
              accountId: posting.account.id,
              amount: posting.amount.toCanonicalDecimal(),
              direction: posting.direction,
              position: posting.position,
            })),
          }),
          "utf8",
        )
        .digest("hex");

      const existing = await transaction.findJournal(idempotencyScope, idempotencyKey);
      if (existing !== undefined) {
        return compareExistingJournal(existing, intentHash);
      }
      if (lockedAccounts.some(({ assetStatus }) => assetStatus === "disabled")) {
        return { status: "asset_disabled" };
      }

      for (const lockedAccount of lockedAccounts) {
        const openingBalance =
          lockedAccount.account.normalSide === "credit"
            ? lockedAccount.creditAtomicUnits - lockedAccount.debitAtomicUnits
            : lockedAccount.debitAtomicUnits - lockedAccount.creditAtomicUnits;
        evaluateLedgerAccountBalanceFromAtomicUnits(lockedAccount.account, openingBalance, journal);
      }

      const persisted = await transaction.persistJournal({
        operationType,
        idempotencyScope,
        idempotencyKey,
        intentHash,
        businessReferences,
        postings: postings.map((posting) => ({
          position: posting.position,
          accountId: posting.account.id,
          assetCode: posting.account.assetCode,
          direction: posting.direction,
          amountAtomicUnits: posting.amount.atomicUnits,
        })),
      });

      return persisted.status === "created"
        ? { status: "created", journalId: persisted.journalId }
        : compareExistingJournal(persisted.journal, intentHash);
    });
  }
}
