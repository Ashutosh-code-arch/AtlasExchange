import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizePassword } from "../src/modules/identity/domain/password.js";
import {
  CryptoOpaqueCredentialGenerator,
  opaqueCredentialEntropyBytes,
} from "../src/modules/identity/infrastructure/security/crypto-opaque-credential-generator.js";
import {
  CryptoVerificationSecretGenerator,
  verificationSecretEntropyBytes,
} from "../src/modules/identity/infrastructure/security/crypto-verification-secret-generator.js";
import { LocalCompromisedPasswordChecker } from "../src/modules/identity/infrastructure/security/local-compromised-password-checker.js";

describe("local Identity security adapters", () => {
  it("matches compromised passwords locally, exactly, and after NFC normalization", async () => {
    const decomposedPassword = "e\u0301".repeat(15);
    const checker = LocalCompromisedPasswordChecker.fromPasswords([
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

  it("loads the development blocklist from local digests and rejects malformed input", async () => {
    const blocklistPath = new URL(
      "../resources/development-password-blocklist.sha256",
      import.meta.url,
    );
    const checker = await LocalCompromisedPasswordChecker.fromFile(blocklistPath.pathname);

    await expect(
      checker.isCompromised(normalizePassword("correct horse battery staple")),
    ).resolves.toBe(true);
    expect(() => LocalCompromisedPasswordChecker.fromSha256Digests(["not-a-digest"])).toThrow(
      /line 1/,
    );
    expect(() => LocalCompromisedPasswordChecker.fromSha256Digests([])).toThrow(
      /at least one digest/,
    );
  });

  it("generates a 256-bit local secret and stores only its SHA-256 digest", () => {
    const generated = new CryptoVerificationSecretGenerator().generate();

    expect(Buffer.from(generated.secret, "base64url")).toHaveLength(verificationSecretEntropyBytes);
    expect(generated.digest).toEqual(
      createHash("sha256").update(generated.secret, "utf8").digest(),
    );
    expect(generated.digest).toHaveLength(32);
  });

  it("generates independent 256-bit opaque session credentials", () => {
    const generator = new CryptoOpaqueCredentialGenerator();
    const first = generator.generate();
    const second = generator.generate();

    expect(Buffer.from(first.secret, "base64url")).toHaveLength(opaqueCredentialEntropyBytes);
    expect(first.digest).toEqual(createHash("sha256").update(first.secret, "utf8").digest());
    expect(first.secret).not.toBe(second.secret);
    expect(first.digest).not.toEqual(second.digest);
  });
});
