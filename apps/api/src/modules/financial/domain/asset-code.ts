import { FinancialInputValidationError } from "./financial-input-validation-error.js";

export const minimumAssetCodeLength = 2;
export const maximumAssetCodeLength = 16;

const assetCodePattern = /^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+(?![\s\S])/;

declare const assetCodeBrand: unique symbol;

export type AssetCode = string & {
  readonly [assetCodeBrand]: "AssetCode";
};

export function parseAssetCode(input: string): AssetCode {
  if (
    input.length < minimumAssetCodeLength ||
    input.length > maximumAssetCodeLength ||
    !assetCodePattern.test(input)
  ) {
    throw new FinancialInputValidationError("assetCode", "ASSET_CODE_INVALID");
  }

  return input as AssetCode;
}
