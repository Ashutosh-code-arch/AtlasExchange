import { createHash, randomBytes } from "node:crypto";

import type {
  VerificationSecret,
  VerificationSecretGenerator,
} from "../../application/verification-secret-generator.js";

export const verificationSecretEntropyBytes = 32;

export class CryptoVerificationSecretGenerator implements VerificationSecretGenerator {
  public generate(): VerificationSecret {
    const secret = randomBytes(verificationSecretEntropyBytes).toString("base64url");
    const digest = createHash("sha256").update(secret, "utf8").digest();

    return { secret, digest };
  }
}
