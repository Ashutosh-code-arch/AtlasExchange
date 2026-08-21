import { z } from "zod";

import { IdentityInputValidationError } from "./identity-input-validation-error.js";

const maximumEmailCodePoints = 254;
const emailSyntaxSchema = z.email();

declare const normalizedEmailBrand: unique symbol;

export type NormalizedEmail = string & {
  readonly [normalizedEmailBrand]: "NormalizedEmail";
};

export interface EmailAddress {
  readonly display: string;
  readonly normalized: NormalizedEmail;
}

export function parseEmailAddress(input: string): EmailAddress {
  const display = input.trim().normalize("NFC");

  if (Array.from(display).length > maximumEmailCodePoints) {
    throw new IdentityInputValidationError("email", "EMAIL_TOO_LONG");
  }
  if (Array.from(display).some((character) => (character.codePointAt(0) ?? 0) > 0x7f)) {
    throw new IdentityInputValidationError("email", "EMAIL_INTERNATIONALIZATION_UNSUPPORTED");
  }

  const normalized = display.toLowerCase();
  if (!emailSyntaxSchema.safeParse(normalized).success) {
    throw new IdentityInputValidationError("email", "EMAIL_INVALID");
  }

  return Object.freeze({
    display,
    normalized: normalized as NormalizedEmail,
  });
}
