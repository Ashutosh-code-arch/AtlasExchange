import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  EmailVerificationTransaction,
  EmailVerificationTransactionRunner,
  VerifyEmailPersistenceInput,
  VerifyEmailPersistenceResult,
} from "../src/modules/identity/application/email-verification-transaction.js";
import { VerifyEmail } from "../src/modules/identity/application/verify-email.js";
import type { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";
import { parseVerificationCredential } from "../src/modules/identity/domain/verification-credential.js";

const tokenId = "019c0000-0000-7000-8000-000000000001";
const secret = "a".repeat(43);
const verifiedAt = new Date("2026-08-21T12:00:00.000Z");

class FakeEmailVerificationTransactionRunner implements EmailVerificationTransactionRunner {
  public receivedInput: VerifyEmailPersistenceInput | undefined;

  public constructor(private readonly result: VerifyEmailPersistenceResult) {}

  public execute<Result>(
    operation: (transaction: EmailVerificationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      verifyEmail: (input) => {
        this.receivedInput = input;
        return Promise.resolve(this.result);
      },
    });
  }
}

describe("email verification", () => {
  it("parses the opaque credential and passes only its digest into the transaction", async () => {
    const transactionRunner = new FakeEmailVerificationTransactionRunner({ status: "verified" });
    const useCase = new VerifyEmail({ transactionRunner, now: () => verifiedAt });

    await expect(
      useCase.execute({ token: `${tokenId}.${secret}`, requestId: "verification-request" }),
    ).resolves.toEqual({ status: "verified" });
    expect(transactionRunner.receivedInput).toEqual({
      tokenId,
      secretDigest: createHash("sha256").update(secret, "utf8").digest(),
      verifiedAt,
      requestId: "verification-request",
    });
    expect(transactionRunner.receivedInput).not.toHaveProperty("secret");
    expect(transactionRunner.receivedInput).not.toHaveProperty("token");
  });

  it.each([
    "missing-separator",
    `not-a-uuid.${secret}`,
    `${tokenId}.short`,
    `${tokenId}.${secret}.extra`,
  ])("rejects a malformed verification credential: %s", (credential) => {
    expect(() => parseVerificationCredential(credential)).toThrowError(
      expect.objectContaining<Partial<IdentityInputValidationError>>({
        field: "token",
        issue: "VERIFICATION_TOKEN_INVALID",
      }),
    );
  });
});
