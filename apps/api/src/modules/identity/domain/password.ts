import { IdentityInputValidationError } from "./identity-input-validation-error.js";

export const minimumPasswordCodePoints = 15;
export const maximumPasswordCodePoints = 128;

declare const normalizedPasswordBrand: unique symbol;

export type NormalizedPassword = string & {
  readonly [normalizedPasswordBrand]: "NormalizedPassword";
};

export function normalizePassword(input: string): NormalizedPassword {
  const normalized = input.normalize("NFC");
  const codePointLength = Array.from(normalized).length;

  if (codePointLength < minimumPasswordCodePoints) {
    throw new IdentityInputValidationError("password", "PASSWORD_TOO_SHORT");
  }
  if (codePointLength > maximumPasswordCodePoints) {
    throw new IdentityInputValidationError("password", "PASSWORD_TOO_LONG");
  }

  return normalized as NormalizedPassword;
}

export function normalizePasswordForAuthentication(input: string): NormalizedPassword {
  const normalized = input.normalize("NFC");
  const codePointLength = Array.from(normalized).length;

  if (codePointLength === 0) {
    throw new IdentityInputValidationError("password", "PASSWORD_TOO_SHORT");
  }
  if (codePointLength > maximumPasswordCodePoints) {
    throw new IdentityInputValidationError("password", "PASSWORD_TOO_LONG");
  }

  return normalized as NormalizedPassword;
}
