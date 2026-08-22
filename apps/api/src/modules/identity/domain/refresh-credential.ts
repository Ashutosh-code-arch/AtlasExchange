import { createHash } from "node:crypto";

import { z } from "zod";

const refreshTokenIdSchema = z.uuid();
const refreshSecretPattern = /^[A-Za-z0-9_-]{43}$/;

export interface RefreshCredential {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
}

export function parseRefreshCredential(input: string): RefreshCredential | undefined {
  const separatorIndex = input.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex !== input.lastIndexOf(".")) {
    return undefined;
  }

  const tokenId = input.slice(0, separatorIndex);
  const secret = input.slice(separatorIndex + 1);
  if (!refreshTokenIdSchema.safeParse(tokenId).success || !refreshSecretPattern.test(secret)) {
    return undefined;
  }

  return {
    tokenId,
    secretDigest: createHash("sha256").update(secret, "utf8").digest(),
  };
}
