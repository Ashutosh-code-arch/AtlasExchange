const canonicalDecimalPattern = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

export const maximumPortfolioValueDigits = 100;

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parse(value: string): DecimalParts {
  if (!canonicalDecimalPattern.test(value)) {
    throw new TypeError("Portfolio decimal must be canonical and non-negative.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function canonical(parts: DecimalParts): string {
  if (parts.coefficient === 0n) return "0";
  const digits = parts.coefficient.toString().padStart(parts.scale + 1, "0");
  const whole = parts.scale === 0 ? digits : digits.slice(0, -parts.scale);
  const fraction = parts.scale === 0 ? "" : digits.slice(-parts.scale).replace(/0+$/, "");
  const result = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  const significantDigits = `${whole === "0" ? "" : whole}${fraction}`.length;
  if (significantDigits > maximumPortfolioValueDigits) {
    throw new RangeError("Portfolio decimal exceeds the supported precision.");
  }
  return result;
}

export function addExactDecimals(values: readonly string[]): string {
  const parts = values.map(parse);
  const scale = parts.reduce((maximum, value) => Math.max(maximum, value.scale), 0);
  const coefficient = parts.reduce(
    (total, value) => total + value.coefficient * 10n ** BigInt(scale - value.scale),
    0n,
  );
  return canonical({ coefficient, scale });
}

export function multiplyExactDecimals(left: string, right: string): string {
  const leftParts = parse(left);
  const rightParts = parse(right);
  return canonical({
    coefficient: leftParts.coefficient * rightParts.coefficient,
    scale: leftParts.scale + rightParts.scale,
  });
}
