import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CompromisedPasswordChecker } from "../src/modules/identity/application/compromised-password-checker.js";
import type { PasswordHasher } from "../src/modules/identity/application/password-hasher.js";
import { ResetPassword } from "../src/modules/identity/application/reset-password.js";
import type {
  CompletePasswordResetInput,
  CompletePasswordResetResult,
  ResetPasswordTransaction,
  ResetPasswordTransactionRunner,
} from "../src/modules/identity/application/reset-password-transaction.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";

const completedAt = new Date("2026-08-23T15:00:00.000Z");
const tokenId = "11111111-1111-4111-8111-111111111111";
const secret = "s".repeat(43);

class FakeResetPasswordTransactionRunner implements ResetPasswordTransactionRunner {
  public receivedInput: CompletePasswordResetInput | undefined;

  public constructor(private readonly result: CompletePasswordResetResult) {}

  public execute<Result>(
    operation: (transaction: ResetPasswordTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      completePasswordReset: (input) => {
        this.receivedInput = input;
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(
  result: CompletePasswordResetResult = { status: "completed", userId: "user-id" },
): {
  readonly useCase: ResetPassword;
  readonly runner: FakeResetPasswordTransactionRunner;
  readonly isCompromised: ReturnType<typeof vi.fn<CompromisedPasswordChecker["isCompromised"]>>;
  readonly hashPassword: ReturnType<typeof vi.fn<PasswordHasher["hash"]>>;
} {
  const runner = new FakeResetPasswordTransactionRunner(result);
  const isCompromised = vi
    .fn<CompromisedPasswordChecker["isCompromised"]>()
    .mockResolvedValue(false);
  const hashPassword = vi.fn<PasswordHasher["hash"]>().mockResolvedValue("$argon2id$new-hash");

  return {
    useCase: new ResetPassword({
      compromisedPasswordChecker: { isCompromised },
      passwordHasher: {
        hash: hashPassword,
        verify: vi.fn<PasswordHasher["verify"]>(),
        needsRehash: vi.fn<PasswordHasher["needsRehash"]>(),
      },
      transactionRunner: runner,
      now: () => completedAt,
    }),
    runner,
    isCompromised,
    hashPassword,
  };
}

describe("ResetPassword", () => {
  it("normalizes and hashes the password before completing the reset transaction", async () => {
    const harness = createHarness();
    const decomposedPassword = "e\u0301".repeat(15);

    await expect(
      harness.useCase.execute({
        token: `${tokenId}.${secret}`,
        password: decomposedPassword,
        requestId: "reset-completion-request",
      }),
    ).resolves.toEqual({ status: "completed", userId: "user-id" });

    expect(harness.isCompromised).toHaveBeenCalledWith("é".repeat(15));
    expect(harness.hashPassword).toHaveBeenCalledWith("é".repeat(15));
    expect(harness.runner.receivedInput).toEqual({
      tokenId,
      secretDigest: createHash("sha256").update(secret).digest(),
      passwordHash: "$argon2id$new-hash",
      completedAt,
      requestId: "reset-completion-request",
    });
    expect(harness.runner.receivedInput).not.toHaveProperty("password");
  });

  it("preserves the generic invalid capability result", async () => {
    const harness = createHarness({ status: "invalid" });

    await expect(
      harness.useCase.execute({
        token: `${tokenId}.${secret}`,
        password: "a new safe password phrase",
        requestId: "invalid-reset-request",
      }),
    ).resolves.toEqual({ status: "invalid" });
  });

  it("rejects malformed credentials before password checks and persistence", async () => {
    const harness = createHarness();

    await expect(
      harness.useCase.execute({
        token: "not-a-reset-credential",
        password: "a new safe password phrase",
        requestId: "malformed-reset-request",
      }),
    ).rejects.toMatchObject({
      field: "token",
      issue: "PASSWORD_RESET_TOKEN_INVALID",
    });
    expect(harness.isCompromised).not.toHaveBeenCalled();
    expect(harness.hashPassword).not.toHaveBeenCalled();
    expect(harness.runner.receivedInput).toBeUndefined();
  });

  it("rejects weak or compromised passwords before hashing or persistence", async () => {
    const shortPasswordHarness = createHarness();
    await expect(
      shortPasswordHarness.useCase.execute({
        token: `${tokenId}.${secret}`,
        password: "too short",
        requestId: "short-password-request",
      }),
    ).rejects.toBeInstanceOf(IdentityInputValidationError);
    expect(shortPasswordHarness.hashPassword).not.toHaveBeenCalled();
    expect(shortPasswordHarness.runner.receivedInput).toBeUndefined();

    const compromisedHarness = createHarness();
    compromisedHarness.isCompromised.mockResolvedValue(true);
    await expect(
      compromisedHarness.useCase.execute({
        token: `${tokenId}.${secret}`,
        password: "compromised password phrase",
        requestId: "compromised-password-request",
      }),
    ).rejects.toMatchObject({ field: "password", issue: "PASSWORD_COMPROMISED" });
    expect(compromisedHarness.hashPassword).not.toHaveBeenCalled();
    expect(compromisedHarness.runner.receivedInput).toBeUndefined();
  });
});
