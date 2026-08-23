import { FinancialInputValidationError } from "./financial-input-validation-error.js";

export const minimumAssetScale = 0;
export const maximumAssetScale = 18;

declare const assetScaleBrand: unique symbol;

export type AssetScale = number & {
  readonly [assetScaleBrand]: "AssetScale";
};

export function parseAssetScale(input: number): AssetScale {
  if (!Number.isInteger(input) || input < minimumAssetScale || input > maximumAssetScale) {
    throw new FinancialInputValidationError("assetScale", "ASSET_SCALE_INVALID");
  }

  return input as AssetScale;
}
