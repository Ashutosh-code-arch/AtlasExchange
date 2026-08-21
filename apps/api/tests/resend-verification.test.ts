import { describe, expect, it, vi } from "vitest";

import {
  ResendVerification,
  type ResendVerificationResult,
} from "../src/modules/identity/application/resend-verification.js";
import type {
  ReplaceEmailVerificationInput,
  ReplaceEmailVerificationResult,
  ResendVerificationTransaction,
  ResendVerificationTransactionRunner,
} from "../src/modules/identity/application/resend-verification-transaction.js";
import type { VerificationEmailDelivery } from "../src/modules/identity/application/verification-email-delivery.js";
import type { VerificationSecretGenerator } from "../src/modules/identity/application/verification-secret-generator.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";

const issuedAt = new Date("2026-08-21T12:00:00.000Z");
const secretDigest = new Uint8Array(32).fill(9);

class FakeResendTransactionRunner implements ResendVerificationTransactionRunner {
  public receivedInput: ReplaceEmailVerificationInput | undefined;

  public constructor(private readonly result: ReplaceEmailVerificationResult) {}

  public execute<Result>(
    operation: (transaction: ResendVerificationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      replaceEmailVerification: (input) => {
        this.receivedInput = input;
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(
  transactionResult: ReplaceEmailVerificationResult = {
    status: "issued",
    userId: "user-id",
    recipientEmail: "Display@Example.com",
    verificationTokenId: "token-id",
  },
): {
  readonly useCase: ResendVerification;
  readonly runner: FakeResendTransactionRunner;
  readonly deliver: ReturnType<typeof vi.fn<VerificationEmailDelivery["deliver"]>>;
} {
  const runner = new FakeResendTransactionRunner(transactionResult);
  const verificationSecretGenerator: VerificationSecretGenerator = {
    generate: () => ({ secret: "replacement-secret", digest: secretDigest }),
  };
  const deliver = vi
    .fn<VerificationEmailDelivery["deliver"]>()
    .mockResolvedValue({ status: "delivered" });

  return {
    useCase: new ResendVerification({
      transactionRunner: runner,
      verificationEmailDelivery: { deliver },
      verificationSecretGenerator,
      now: () => issuedAt,
    }),
    runner,
    deliver,
  };
}

describe("ResendVerification", () => {
  it("replaces the capability and delivers it to the stored display address", async () => {
    const harness = createHarness();

    await expect(harness.useCase.execute({ email: "  DISPLAY@example.COM  " })).resolves.toEqual({
      status: "issued",
      userId: "user-id",
    } satisfies ResendVerificationResult);
    expect(harness.runner.receivedInput).toEqual({
      normalizedEmail: "display@example.com",
      secretDigest,
      issuedAt,
      expiresAt: new Date("2026-08-22T12:00:00.000Z"),
    });
    expect(harness.deliver).toHaveBeenCalledWith({
      recipientEmail: "Display@Example.com",
      credential: "token-id.replacement-secret",
      expiresAt: new Date("2026-08-22T12:00:00.000Z"),
    });
  });

  it("does not deliver when no pending account exists", async () => {
    const harness = createHarness({ status: "not_issued" });

    await expect(harness.useCase.execute({ email: "unknown@example.com" })).resolves.toEqual({
      status: "not_issued",
    });
    expect(harness.deliver).not.toHaveBeenCalled();
  });

  it("rejects an invalid address before persistence or delivery", async () => {
    const harness = createHarness();

    await expect(harness.useCase.execute({ email: "invalid" })).rejects.toBeInstanceOf(
      IdentityInputValidationError,
    );
    expect(harness.runner.receivedInput).toBeUndefined();
    expect(harness.deliver).not.toHaveBeenCalled();
  });
});
