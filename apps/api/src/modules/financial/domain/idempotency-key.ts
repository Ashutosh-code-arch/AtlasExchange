import { FinancialInputValidationError } from "./financial-input-validation-error.js";

export const maximumIdempotencyKeyLength = 200;

declare const financialIdempotencyKeyBrand: unique symbol;

export type FinancialIdempotencyKey = string & {
  readonly [financialIdempotencyKeyBrand]: "FinancialIdempotencyKey";
};

export function parseFinancialIdempotencyKey(input: string): FinancialIdempotencyKey {
  if (input !== input.trim() || input.length < 1 || input.length > maximumIdempotencyKeyLength) {
    throw new FinancialInputValidationError("idempotencyKey", "IDEMPOTENCY_KEY_INVALID");
  }
  return input as FinancialIdempotencyKey;
}
