import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizePassword } from "../src/modules/identity/domain/password.js";
import {
  CryptoVerificationSecretGenerator,
  verificationSecretEntropyBytes,
} from "../src/modules/identity/infrastructure/security/crypto-verification-secret-generator.js";
import { LocalCompromisedPasswordChecker } from "../src/modules/identity/infrastructure/security/local-compromised-password-checker.js";

describe("local Identity security adapters", () => {
  it("matches compromised passwords locally, exactly, and after NFC normalization", async () => {
    const decomposedPassword = "e\u0301".repeat(15);
    const checker = new LocalCompromisedPasswordChecker([
      "correct horse battery staple",
      decomposedPassword,
    ]);

    await expect(
      checker.isCompromised(normalizePassword("correct horse battery staple")),
    ).resolves.toBe(true);
    await expect(
      checker.isCompromised(normalizePassword("Correct horse battery staple")),
    ).resolves.toBe(false);
    await expect(checker.isCompromised(normalizePassword("é".repeat(15)))).resolves.toBe(true);
  });

  it("generates a 256-bit local secret and stores only its SHA-256 digest", () => {
    const generated = new CryptoVerificationSecretGenerator().generate();

    expect(Buffer.from(generated.secret, "base64url")).toHaveLength(verificationSecretEntropyBytes);
    expect(generated.digest).toEqual(
      createHash("sha256").update(generated.secret, "utf8").digest(),
    );
    expect(generated.digest).toHaveLength(32);
  });
});
