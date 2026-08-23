import type { AssetCode } from "./asset-code.js";
import type { AssetScale } from "./asset-scale.js";
import { FinancialInputValidationError } from "./financial-input-validation-error.js";

export const maximumAtomicDigits = 38;
export const maximumAtomicUnits = 10n ** BigInt(maximumAtomicDigits) - 1n;

const canonicalQuantityPattern = /^(?:0|[1-9]\d*)(?:\.(\d*[1-9]))?(?![\s\S])/;

function assertAtomicUnitsInRange(atomicUnits: bigint): void {
  if (atomicUnits < 0n) {
    throw new FinancialInputValidationError("quantity", "QUANTITY_INVALID");
  }
  if (atomicUnits > maximumAtomicUnits) {
    throw new FinancialInputValidationError("quantity", "QUANTITY_OVERFLOW");
  }
}

function parseAtomicUnits(input: string, scale: AssetScale): bigint {
  const match = canonicalQuantityPattern.exec(input);
  if (match === null) {
    throw new FinancialInputValidationError("quantity", "QUANTITY_INVALID");
  }

  const fraction = match[1] ?? "";
  if (fraction.length > scale) {
    throw new FinancialInputValidationError("quantity", "QUANTITY_SCALE_EXCEEDED");
  }

  const separatorIndex = input.indexOf(".");
  const whole = separatorIndex === -1 ? input : input.slice(0, separatorIndex);
  const atomicUnits = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  assertAtomicUnitsInRange(atomicUnits);
  return atomicUnits;
}

function requireSameDenomination(left: AssetQuantity, right: AssetQuantity): void {
  if (left.assetCode !== right.assetCode || left.scale !== right.scale) {
    throw new FinancialInputValidationError("quantity", "QUANTITY_DENOMINATION_MISMATCH");
  }
}

export class AssetQuantity {
  private constructor(
    public readonly assetCode: AssetCode,
    public readonly scale: AssetScale,
    public readonly atomicUnits: bigint,
  ) {
    Object.freeze(this);
  }

  public static parse(assetCode: AssetCode, scale: AssetScale, input: string): AssetQuantity {
    return new AssetQuantity(assetCode, scale, parseAtomicUnits(input, scale));
  }

  public static fromAtomicUnits(
    assetCode: AssetCode,
    scale: AssetScale,
    atomicUnits: bigint,
  ): AssetQuantity {
    assertAtomicUnitsInRange(atomicUnits);
    return new AssetQuantity(assetCode, scale, atomicUnits);
  }

  public add(other: AssetQuantity): AssetQuantity {
    requireSameDenomination(this, other);
    return AssetQuantity.fromAtomicUnits(
      this.assetCode,
      this.scale,
      this.atomicUnits + other.atomicUnits,
    );
  }

  public subtract(other: AssetQuantity): AssetQuantity {
    requireSameDenomination(this, other);
    if (other.atomicUnits > this.atomicUnits) {
      throw new FinancialInputValidationError("quantity", "QUANTITY_UNDERFLOW");
    }

    return AssetQuantity.fromAtomicUnits(
      this.assetCode,
      this.scale,
      this.atomicUnits - other.atomicUnits,
    );
  }

  public toCanonicalDecimal(): string {
    if (this.scale === 0) {
      return this.atomicUnits.toString();
    }

    const digits = this.atomicUnits.toString().padStart(this.scale + 1, "0");
    const decimalIndex = digits.length - this.scale;
    const whole = digits.slice(0, decimalIndex);
    const fraction = digits.slice(decimalIndex).replace(/0+$/, "");

    return fraction.length === 0 ? whole : `${whole}.${fraction}`;
  }
}
