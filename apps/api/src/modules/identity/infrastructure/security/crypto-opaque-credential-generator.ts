import { createHash, randomBytes } from "node:crypto";

import type {
  OpaqueCredential,
  OpaqueCredentialGenerator,
} from "../../application/opaque-credential-generator.js";

export const opaqueCredentialEntropyBytes = 32;

export class CryptoOpaqueCredentialGenerator implements OpaqueCredentialGenerator {
  public generate(): OpaqueCredential {
    const secret = randomBytes(opaqueCredentialEntropyBytes).toString("base64url");
    const digest = createHash("sha256").update(secret, "utf8").digest();

    return { secret, digest };
  }
}
