import { TradingInputValidationError } from "./trading-input-validation-error.js";

export const maximumPlacementIdempotencyKeyLength = 200;

declare const placementIdempotencyKeyBrand: unique symbol;

export type PlacementIdempotencyKey = string & {
  readonly [placementIdempotencyKeyBrand]: "PlacementIdempotencyKey";
};

export function parsePlacementIdempotencyKey(input: string): PlacementIdempotencyKey {
  if (
    input.length === 0 ||
    input.length > maximumPlacementIdempotencyKeyLength ||
    input.trim() !== input
  ) {
    throw new TradingInputValidationError("idempotencyKey", "IDEMPOTENCY_KEY_INVALID");
  }
  return input as PlacementIdempotencyKey;
}
