import { createHash } from "node:crypto";

import { z } from "zod";

const accessTokenIdSchema = z.uuid();
const accessSecretPattern = /^[A-Za-z0-9_-]{43}$/;

export interface AccessCredential {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
}

export function parseAccessCredential(input: string): AccessCredential | undefined {
  const separatorIndex = input.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex !== input.lastIndexOf(".")) {
    return undefined;
  }

  const tokenId = input.slice(0, separatorIndex);
  const secret = input.slice(separatorIndex + 1);
  if (!accessTokenIdSchema.safeParse(tokenId).success || !accessSecretPattern.test(secret)) {
    return undefined;
  }

  return {
    tokenId,
    secretDigest: createHash("sha256").update(secret, "utf8").digest(),
  };
}
