import { describe, expect, it } from "vitest";

import {
  AssetQuantity,
  FinancialInputValidationError,
  maximumAssetCodeLength,
  maximumAtomicUnits,
  maximumAssetScale,
  minimumAssetCodeLength,
  minimumAssetScale,
  parseAssetCode,
  parseAssetScale,
} from "../src/modules/financial/index.js";

function expectValidationIssue(action: () => unknown, issue: string, field?: string): void {
  try {
    action();
    throw new Error("Expected Financial validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FinancialInputValidationError);
    expect(error).toMatchObject({ issue, ...(field === undefined ? {} : { field }) });
  }
}

describe("Financial asset primitives", () => {
  it("accepts canonical asset codes, including alphanumeric codes", () => {
    expect(parseAssetCode("USD")).toBe("USD");
    expect(parseAssetCode("BTC")).toBe("BTC");
    expect(parseAssetCode("1INCH")).toBe("1INCH");
    expect(parseAssetCode(`A${"1".repeat(maximumAssetCodeLength - 1)}`)).toHaveLength(
      maximumAssetCodeLength,
    );
  });

  it.each([
    "",
    "A".repeat(minimumAssetCodeLength - 1),
    "A".repeat(maximumAssetCodeLength + 1),
    "btc",
    " BTC",
    "BTC ",
    "BTC\n",
    "BTC-USD",
    "1234",
    "ÉUR",
  ])("rejects a non-canonical asset code: %s", (input) => {
    expectValidationIssue(() => parseAssetCode(input), "ASSET_CODE_INVALID", "assetCode");
  });

  it("accepts only integer ledger scales from zero through eighteen", () => {
    expect(parseAssetScale(minimumAssetScale)).toBe(0);
    expect(parseAssetScale(maximumAssetScale)).toBe(18);

    for (const input of [-1, 19, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectValidationIssue(() => parseAssetScale(input), "ASSET_SCALE_INVALID", "assetScale");
    }
  });
});

describe("AssetQuantity", () => {
  const btc = parseAssetCode("BTC");
  const usd = parseAssetCode("USD");
  const bitcoinScale = parseAssetScale(8);
  const fiatScale = parseAssetScale(2);

  it.each([
    ["0", 0n],
    ["1", 100_000_000n],
    ["0.00000001", 1n],
    ["1.2345", 123_450_000n],
    ["999999999999999999999999999999.99999999", maximumAtomicUnits],
  ])("parses %s into exact atomic units", (input, expectedAtomicUnits) => {
    expect(AssetQuantity.parse(btc, bitcoinScale, input).atomicUnits).toBe(expectedAtomicUnits);
  });

  it.each([
    [0n, "0"],
    [1n, "0.00000001"],
    [100_000_000n, "1"],
    [123_450_000n, "1.2345"],
    [maximumAtomicUnits, "999999999999999999999999999999.99999999"],
  ])("formats %s atomic units as %s", (atomicUnits, expected) => {
    const quantity = AssetQuantity.fromAtomicUnits(btc, bitcoinScale, atomicUnits);

    expect(quantity.toCanonicalDecimal()).toBe(expected);
  });

  it("formats zero-scale assets without a decimal separator", () => {
    const unitScale = parseAssetScale(0);

    expect(AssetQuantity.parse(btc, unitScale, "123").toCanonicalDecimal()).toBe("123");
  });

  it.each(["", "-1", "+1", "01", "1.", ".1", "1.0", "0.0", "1e3", " 1", "1 ", "1\n"])(
    "rejects a non-canonical decimal quantity: %s",
    (input) => {
      expectValidationIssue(
        () => AssetQuantity.parse(btc, bitcoinScale, input),
        "QUANTITY_INVALID",
        "quantity",
      );
    },
  );

  it("rejects precision beyond the asset scale", () => {
    expectValidationIssue(
      () => AssetQuantity.parse(btc, bitcoinScale, "0.000000001"),
      "QUANTITY_SCALE_EXCEEDED",
      "quantity",
    );
    expectValidationIssue(
      () => AssetQuantity.parse(btc, parseAssetScale(0), "0.1"),
      "QUANTITY_SCALE_EXCEEDED",
      "quantity",
    );
  });

  it("preserves the smallest unit at the maximum supported scale", () => {
    const maximumScale = parseAssetScale(maximumAssetScale);
    const quantity = AssetQuantity.parse(btc, maximumScale, "0.000000000000000001");

    expect(quantity.atomicUnits).toBe(1n);
    expect(quantity.toCanonicalDecimal()).toBe("0.000000000000000001");
  });

  it("accepts the 38-digit atomic boundary and rejects overflow", () => {
    expect(AssetQuantity.fromAtomicUnits(btc, bitcoinScale, maximumAtomicUnits).atomicUnits).toBe(
      maximumAtomicUnits,
    );
    expectValidationIssue(
      () => AssetQuantity.fromAtomicUnits(btc, bitcoinScale, maximumAtomicUnits + 1n),
      "QUANTITY_OVERFLOW",
      "quantity",
    );
    expectValidationIssue(
      () => AssetQuantity.parse(btc, bitcoinScale, "1000000000000000000000000000000"),
      "QUANTITY_OVERFLOW",
      "quantity",
    );
  });

  it("rejects negative atomic units", () => {
    expectValidationIssue(
      () => AssetQuantity.fromAtomicUnits(btc, bitcoinScale, -1n),
      "QUANTITY_INVALID",
      "quantity",
    );
  });

  it("adds and subtracts exact quantities without mutating either operand", () => {
    const left = AssetQuantity.parse(btc, bitcoinScale, "1.25");
    const right = AssetQuantity.parse(btc, bitcoinScale, "0.75");

    expect(left.add(right).toCanonicalDecimal()).toBe("2");
    expect(left.subtract(right).toCanonicalDecimal()).toBe("0.5");
    expect(left.toCanonicalDecimal()).toBe("1.25");
    expect(right.toCanonicalDecimal()).toBe("0.75");
    expect(Object.isFrozen(left)).toBe(true);
  });

  it("rejects arithmetic across asset codes or scales", () => {
    const btcQuantity = AssetQuantity.parse(btc, bitcoinScale, "1");
    const usdQuantity = AssetQuantity.parse(usd, fiatScale, "1");
    const incompatibleBtcQuantity = AssetQuantity.parse(btc, fiatScale, "1");

    for (const other of [usdQuantity, incompatibleBtcQuantity]) {
      expectValidationIssue(
        () => btcQuantity.add(other),
        "QUANTITY_DENOMINATION_MISMATCH",
        "quantity",
      );
      expectValidationIssue(
        () => btcQuantity.subtract(other),
        "QUANTITY_DENOMINATION_MISMATCH",
        "quantity",
      );
    }
  });

  it("rejects overflow and underflow arithmetic", () => {
    const maximum = AssetQuantity.fromAtomicUnits(btc, bitcoinScale, maximumAtomicUnits);
    const oneAtomicUnit = AssetQuantity.fromAtomicUnits(btc, bitcoinScale, 1n);

    expectValidationIssue(() => maximum.add(oneAtomicUnit), "QUANTITY_OVERFLOW", "quantity");
    expectValidationIssue(() => oneAtomicUnit.subtract(maximum), "QUANTITY_UNDERFLOW", "quantity");
  });
});
