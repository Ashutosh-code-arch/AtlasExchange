import { describe, expect, it } from "vitest";

import {
  AssetQuantity,
  maximumAtomicUnits,
} from "../src/modules/financial/domain/asset-quantity.js";
import { FinancialInputValidationError } from "../src/modules/financial/domain/financial-input-validation-error.js";
import { FinancialInvariantError } from "../src/modules/financial/domain/financial-invariant-error.js";
import { JournalPosting } from "../src/modules/financial/domain/journal-posting.js";
import { JournalTransaction } from "../src/modules/financial/domain/journal-transaction.js";
import {
  LedgerAccount,
  parseLedgerAccountId,
  type LedgerAccountKind,
} from "../src/modules/financial/domain/ledger-account.js";
import { evaluateLedgerAccountBalance } from "../src/modules/financial/domain/ledger-balance.js";
import { parseAssetCode } from "../src/modules/financial/index.js";
import { parseAssetScale } from "../src/modules/financial/index.js";

const ids = {
  custodyBtc: parseLedgerAccountId("00000000-0000-4000-8000-000000000001"),
  custodyUsd: parseLedgerAccountId("00000000-0000-4000-8000-000000000002"),
  feeBtc: parseLedgerAccountId("00000000-0000-4000-8000-000000000003"),
  userAvailableBtc: parseLedgerAccountId("00000000-0000-4000-8000-000000000004"),
  userAvailableUsd: parseLedgerAccountId("00000000-0000-4000-8000-000000000005"),
  userReservedBtc: parseLedgerAccountId("00000000-0000-4000-8000-000000000006"),
} as const;

const btc = parseAssetCode("BTC");
const usd = parseAssetCode("USD");
const btcScale = parseAssetScale(8);
const usdScale = parseAssetScale(2);

function account(
  id: (typeof ids)[keyof typeof ids],
  kind: LedgerAccountKind,
  assetCode = btc,
  scale = btcScale,
): LedgerAccount {
  return LedgerAccount.create({ id, assetCode, scale, kind });
}

const accounts = {
  custodyBtc: account(ids.custodyBtc, "external_custody"),
  custodyUsd: account(ids.custodyUsd, "external_custody", usd, usdScale),
  feeBtc: account(ids.feeBtc, "fee_revenue"),
  userAvailableBtc: account(ids.userAvailableBtc, "user_available"),
  userAvailableUsd: account(ids.userAvailableUsd, "user_available", usd, usdScale),
  userReservedBtc: account(ids.userReservedBtc, "user_reserved"),
} as const;

function quantity(value: string, assetCode = btc, scale = btcScale): AssetQuantity {
  return AssetQuantity.parse(assetCode, scale, value);
}

function posting(
  position: number,
  ledgerAccount: LedgerAccount,
  direction: "credit" | "debit",
  amount: AssetQuantity,
): JournalPosting {
  return JournalPosting.create({ position, account: ledgerAccount, direction, amount });
}

function expectInvariant(action: () => unknown, issue: string): void {
  try {
    action();
    throw new Error("Expected Financial invariant validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FinancialInvariantError);
    expect(error).toMatchObject({ issue });
  }
}

describe("ledger accounts", () => {
  it("derives accounting policy from the owned account kind", () => {
    expect(accounts.custodyBtc).toMatchObject({
      normalSide: "debit",
      requiresNonNegativeBalance: false,
    });
    expect(accounts.feeBtc).toMatchObject({
      normalSide: "credit",
      requiresNonNegativeBalance: false,
    });
    expect(accounts.userAvailableBtc).toMatchObject({
      normalSide: "credit",
      requiresNonNegativeBalance: true,
    });
    expect(accounts.userReservedBtc).toMatchObject({
      normalSide: "credit",
      requiresNonNegativeBalance: true,
    });
    expect(Object.isFrozen(accounts.userAvailableBtc)).toBe(true);
  });

  it.each(["", "not-a-uuid", "00000000-0000-4000-8000-000000000001\n"])(
    "rejects a malformed ledger account identifier: %s",
    (input) => {
      expect(() => parseLedgerAccountId(input)).toThrow(FinancialInputValidationError);
      expect(() => parseLedgerAccountId(input)).toThrow(
        expect.objectContaining({ issue: "LEDGER_ACCOUNT_ID_INVALID" }),
      );
    },
  );
});

describe("journal postings", () => {
  it("creates an immutable positive posting with an explicit position", () => {
    const value = posting(1, accounts.custodyBtc, "debit", quantity("1"));

    expect(value).toMatchObject({ position: 1, direction: "debit" });
    expect(value.amount.toCanonicalDecimal()).toBe("1");
    expect(Object.isFrozen(value)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid posting position: %s",
    (position) => {
      expectInvariant(
        () => posting(position, accounts.custodyBtc, "debit", quantity("1")),
        "POSTING_POSITION_INVALID",
      );
    },
  );

  it("rejects zero-value postings", () => {
    expectInvariant(
      () => posting(1, accounts.custodyBtc, "debit", quantity("0")),
      "POSTING_AMOUNT_NOT_POSITIVE",
    );
  });

  it("rejects a posting whose quantity differs from the account denomination", () => {
    expectInvariant(
      () => posting(1, accounts.custodyBtc, "debit", quantity("1", usd, usdScale)),
      "POSTING_DENOMINATION_MISMATCH",
    );
    expectInvariant(
      () => posting(1, accounts.custodyBtc, "debit", quantity("1", btc, usdScale)),
      "POSTING_DENOMINATION_MISMATCH",
    );
  });
});

describe("journal transactions", () => {
  it("accepts a balanced deposit journal and preserves deterministic posting order", () => {
    const journal = JournalTransaction.create([
      posting(1, accounts.custodyBtc, "debit", quantity("1.25")),
      posting(2, accounts.userAvailableBtc, "credit", quantity("1.25")),
    ]);

    expect(journal.postings.map(({ position }) => position)).toEqual([1, 2]);
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal.postings)).toBe(true);
  });

  it("accepts a journal that balances each represented asset independently", () => {
    const journal = JournalTransaction.create([
      posting(1, accounts.custodyBtc, "debit", quantity("1")),
      posting(2, accounts.userAvailableBtc, "credit", quantity("1")),
      posting(3, accounts.custodyUsd, "debit", quantity("10", usd, usdScale)),
      posting(4, accounts.userAvailableUsd, "credit", quantity("10", usd, usdScale)),
    ]);

    expect(journal.postings).toHaveLength(4);
  });

  it("rejects globally equal atomic totals that are unbalanced per asset", () => {
    expectInvariant(
      () =>
        JournalTransaction.create([
          posting(1, accounts.custodyBtc, "debit", quantity("0.000001")),
          posting(2, accounts.userAvailableUsd, "credit", quantity("1", usd, usdScale)),
        ]),
      "JOURNAL_UNBALANCED",
    );
  });

  it("rejects single-posting and unbalanced journals", () => {
    expectInvariant(
      () => JournalTransaction.create([posting(1, accounts.custodyBtc, "debit", quantity("1"))]),
      "JOURNAL_TOO_FEW_POSTINGS",
    );
    expectInvariant(
      () =>
        JournalTransaction.create([
          posting(1, accounts.custodyBtc, "debit", quantity("1")),
          posting(2, accounts.userAvailableBtc, "credit", quantity("0.5")),
        ]),
      "JOURNAL_UNBALANCED",
    );
  });

  it.each([
    [1, 1],
    [1, 3],
    [2, 1],
  ])("rejects a non-contiguous position sequence: %s, %s", (first, second) => {
    expectInvariant(
      () =>
        JournalTransaction.create([
          posting(first, accounts.custodyBtc, "debit", quantity("1")),
          posting(second, accounts.userAvailableBtc, "credit", quantity("1")),
        ]),
      "JOURNAL_POSITION_SEQUENCE_INVALID",
    );
  });

  it("rejects different scales for the same asset code", () => {
    const incompatibleScaleAccount = account(ids.custodyUsd, "external_custody", btc, usdScale);

    expectInvariant(
      () =>
        JournalTransaction.create([
          posting(1, accounts.custodyBtc, "debit", quantity("1")),
          posting(2, accounts.userAvailableBtc, "credit", quantity("1")),
          posting(3, incompatibleScaleAccount, "debit", quantity("1", btc, usdScale)),
          posting(4, incompatibleScaleAccount, "credit", quantity("1", btc, usdScale)),
        ]),
      "JOURNAL_ASSET_SCALE_MISMATCH",
    );
  });

  it("rejects conflicting definitions for one account identifier", () => {
    const conflictingAccount = account(ids.custodyBtc, "fee_revenue");

    expectInvariant(
      () =>
        JournalTransaction.create([
          posting(1, accounts.custodyBtc, "debit", quantity("1")),
          posting(2, conflictingAccount, "credit", quantity("1")),
        ]),
      "ACCOUNT_DEFINITION_MISMATCH",
    );
  });
});

describe("ledger balance evaluation", () => {
  it("applies postings according to each account's normal side", () => {
    const deposit = JournalTransaction.create([
      posting(1, accounts.custodyBtc, "debit", quantity("1.5")),
      posting(2, accounts.userAvailableBtc, "credit", quantity("1.5")),
    ]);
    const zero = quantity("0");

    expect(evaluateLedgerAccountBalance(accounts.custodyBtc, zero, deposit)).toBe(150_000_000n);
    expect(evaluateLedgerAccountBalance(accounts.userAvailableBtc, zero, deposit)).toBe(
      150_000_000n,
    );
  });

  it("moves reserved value without changing the wallet's combined value", () => {
    const reserve = JournalTransaction.create([
      posting(1, accounts.userAvailableBtc, "debit", quantity("0.4")),
      posting(2, accounts.userReservedBtc, "credit", quantity("0.4")),
    ]);
    const available = evaluateLedgerAccountBalance(
      accounts.userAvailableBtc,
      quantity("1"),
      reserve,
    );
    const reserved = evaluateLedgerAccountBalance(accounts.userReservedBtc, quantity("0"), reserve);

    expect(available).toBe(60_000_000n);
    expect(reserved).toBe(40_000_000n);
    expect(available + reserved).toBe(100_000_000n);
  });

  it("rejects a journal that would overdraw a constrained user account", () => {
    const reserve = JournalTransaction.create([
      posting(1, accounts.userAvailableBtc, "debit", quantity("1.1")),
      posting(2, accounts.userReservedBtc, "credit", quantity("1.1")),
    ]);

    expectInvariant(
      () => evaluateLedgerAccountBalance(accounts.userAvailableBtc, quantity("1"), reserve),
      "ACCOUNT_BALANCE_NEGATIVE",
    );
  });

  it("rejects an opening balance in a different denomination", () => {
    const deposit = JournalTransaction.create([
      posting(1, accounts.custodyBtc, "debit", quantity("1")),
      posting(2, accounts.userAvailableBtc, "credit", quantity("1")),
    ]);

    expectInvariant(
      () =>
        evaluateLedgerAccountBalance(
          accounts.userAvailableBtc,
          quantity("1", usd, usdScale),
          deposit,
        ),
      "ACCOUNT_OPENING_BALANCE_DENOMINATION_MISMATCH",
    );
  });

  it("rejects evaluating a reused identifier through a conflicting account definition", () => {
    const deposit = JournalTransaction.create([
      posting(1, accounts.custodyBtc, "debit", quantity("1")),
      posting(2, accounts.userAvailableBtc, "credit", quantity("1")),
    ]);
    const conflictingAccount = account(ids.userAvailableBtc, "fee_revenue");

    expectInvariant(
      () => evaluateLedgerAccountBalance(conflictingAccount, quantity("0"), deposit),
      "ACCOUNT_DEFINITION_MISMATCH",
    );
  });

  it("rejects a closing balance beyond the 38-digit atomic boundary", () => {
    const deposit = JournalTransaction.create([
      posting(1, accounts.custodyBtc, "debit", quantity("0.00000001")),
      posting(2, accounts.userAvailableBtc, "credit", quantity("0.00000001")),
    ]);
    const maximum = AssetQuantity.fromAtomicUnits(btc, btcScale, maximumAtomicUnits);

    expectInvariant(
      () => evaluateLedgerAccountBalance(accounts.userAvailableBtc, maximum, deposit),
      "ACCOUNT_BALANCE_OVERFLOW",
    );
  });
});
