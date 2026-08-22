import { describe, expect, it, vi } from "vitest";

import type { OpaqueCredentialGenerator } from "../src/modules/identity/application/opaque-credential-generator.js";
import type { PasswordResetEmailDelivery } from "../src/modules/identity/application/password-reset-email-delivery.js";
import {
  RequestPasswordReset,
  type RequestPasswordResetResult,
} from "../src/modules/identity/application/request-password-reset.js";
import type {
  ReplacePasswordResetInput,
  ReplacePasswordResetResult,
  RequestPasswordResetTransaction,
  RequestPasswordResetTransactionRunner,
} from "../src/modules/identity/application/request-password-reset-transaction.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";

const issuedAt = new Date("2026-08-23T14:00:00.000Z");
const secretDigest = new Uint8Array(32).fill(7);

class FakePasswordResetTransactionRunner implements RequestPasswordResetTransactionRunner {
  public receivedInput: ReplacePasswordResetInput | undefined;

  public constructor(private readonly result: ReplacePasswordResetResult) {}

  public execute<Result>(
    operation: (transaction: RequestPasswordResetTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      replacePasswordReset: (input) => {
        this.receivedInput = input;
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(
  result: ReplacePasswordResetResult = {
    status: "issued",
    userId: "user-id",
    recipientEmail: "Display@Example.com",
    passwordResetTokenId: "token-id",
  },
): {
  readonly useCase: RequestPasswordReset;
  readonly runner: FakePasswordResetTransactionRunner;
  readonly deliver: ReturnType<typeof vi.fn<PasswordResetEmailDelivery["deliver"]>>;
} {
  const runner = new FakePasswordResetTransactionRunner(result);
  const credentialGenerator: OpaqueCredentialGenerator = {
    generate: () => ({ secret: "reset-secret", digest: secretDigest }),
  };
  const deliver = vi
    .fn<PasswordResetEmailDelivery["deliver"]>()
    .mockResolvedValue({ status: "delivered" });
  return {
    useCase: new RequestPasswordReset({
      credentialGenerator,
      passwordResetEmailDelivery: { deliver },
      transactionRunner: runner,
      now: () => issuedAt,
    }),
    runner,
    deliver,
  };
}

describe("RequestPasswordReset", () => {
  it("replaces the capability and delivers a 30-minute credential to the stored address", async () => {
    const harness = createHarness();

    await expect(
      harness.useCase.execute({
        email: "  DISPLAY@example.COM  ",
        requestId: "password-reset-request",
      }),
    ).resolves.toEqual({
      status: "issued",
      userId: "user-id",
    } satisfies RequestPasswordResetResult);
    expect(harness.runner.receivedInput).toEqual({
      normalizedEmail: "display@example.com",
      secretDigest,
      issuedAt,
      expiresAt: new Date("2026-08-23T14:30:00.000Z"),
      requestId: "password-reset-request",
    });
    expect(harness.deliver).toHaveBeenCalledWith({
      recipientEmail: "Display@Example.com",
      credential: "token-id.reset-secret",
      expiresAt: new Date("2026-08-23T14:30:00.000Z"),
    });
  });

  it("does not deliver when no eligible account exists", async () => {
    const harness = createHarness({ status: "not_issued" });

    await expect(
      harness.useCase.execute({ email: "unknown@example.com", requestId: "unknown-request" }),
    ).resolves.toEqual({ status: "not_issued" });
    expect(harness.deliver).not.toHaveBeenCalled();
  });

  it("rejects invalid email before persistence and delivery", async () => {
    const harness = createHarness();

    await expect(
      harness.useCase.execute({ email: "invalid", requestId: "invalid-request" }),
    ).rejects.toBeInstanceOf(IdentityInputValidationError);
    expect(harness.runner.receivedInput).toBeUndefined();
    expect(harness.deliver).not.toHaveBeenCalled();
  });
});
