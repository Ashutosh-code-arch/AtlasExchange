import { createHash } from "node:crypto";

import { z } from "zod";

import { IdentityInputValidationError } from "./identity-input-validation-error.js";

const tokenIdSchema = z.uuid();
const resetSecretPattern = /^[A-Za-z0-9_-]{43}$/;

export interface PasswordResetCredential {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
}

export function parsePasswordResetCredential(input: string): PasswordResetCredential {
  const separatorIndex = input.indexOf(".");
  const hasOneSeparator = separatorIndex > 0 && separatorIndex === input.lastIndexOf(".");
  if (!hasOneSeparator) {
    throw new IdentityInputValidationError("token", "PASSWORD_RESET_TOKEN_INVALID");
  }

  const tokenId = input.slice(0, separatorIndex);
  const secret = input.slice(separatorIndex + 1);
  if (!tokenIdSchema.safeParse(tokenId).success || !resetSecretPattern.test(secret)) {
    throw new IdentityInputValidationError("token", "PASSWORD_RESET_TOKEN_INVALID");
  }

  return {
    tokenId,
    secretDigest: createHash("sha256").update(secret, "utf8").digest(),
  };
}
