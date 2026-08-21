import { describe, expect, it, vi } from "vitest";

import type { CompromisedPasswordChecker } from "../src/modules/identity/application/compromised-password-checker.js";
import type { PasswordHasher } from "../src/modules/identity/application/password-hasher.js";
import {
  emailVerificationLifetimeMilliseconds,
  RegisterUser,
} from "../src/modules/identity/application/register-user.js";
import type {
  CreatePasswordRegistrationInput,
  CreatePasswordRegistrationResult,
  RegistrationTransaction,
  RegistrationTransactionRunner,
} from "../src/modules/identity/application/registration-transaction.js";
import type { VerificationSecretGenerator } from "../src/modules/identity/application/verification-secret-generator.js";
import type { VerificationEmailDelivery } from "../src/modules/identity/application/verification-email-delivery.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";

const registeredAt = new Date("2026-08-21T12:00:00.000Z");
const verificationDigest = new Uint8Array(32).fill(7);

class FakeRegistrationTransactionRunner implements RegistrationTransactionRunner {
  public receivedInput: CreatePasswordRegistrationInput | undefined;

  public constructor(private readonly result: CreatePasswordRegistrationResult) {}

  public execute<Result>(
    operation: (transaction: RegistrationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      createPasswordRegistration: (input) => {
        this.receivedInput = input;
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(
  transactionResult: CreatePasswordRegistrationResult = {
    status: "created",
    userId: "0198-user-id",
    verificationTokenId: "0198-token-id",
  },
): {
  readonly useCase: RegisterUser;
  readonly isCompromised: ReturnType<typeof vi.fn<CompromisedPasswordChecker["isCompromised"]>>;
  readonly hashPassword: ReturnType<typeof vi.fn<PasswordHasher["hash"]>>;
  readonly transactionRunner: FakeRegistrationTransactionRunner;
  readonly deliverVerificationEmail: ReturnType<typeof vi.fn<VerificationEmailDelivery["deliver"]>>;
} {
  const isCompromised = vi
    .fn<CompromisedPasswordChecker["isCompromised"]>()
    .mockResolvedValue(false);
  const compromisedPasswordChecker = { isCompromised };
  const hashPassword = vi.fn<PasswordHasher["hash"]>().mockResolvedValue("$argon2id$atlas-hash");
  const passwordHasher = {
    hash: hashPassword,
    verify: vi.fn<PasswordHasher["verify"]>(),
    needsRehash: vi.fn<PasswordHasher["needsRehash"]>(),
  };
  const verificationSecretGenerator: VerificationSecretGenerator = {
    generate: vi.fn(() => ({ secret: "verification-secret", digest: verificationDigest })),
  };
  const transactionRunner = new FakeRegistrationTransactionRunner(transactionResult);
  const deliverVerificationEmail = vi
    .fn<VerificationEmailDelivery["deliver"]>()
    .mockResolvedValue({ status: "delivered" });

  return {
    useCase: new RegisterUser({
      compromisedPasswordChecker,
      passwordHasher,
      registrationTransactionRunner: transactionRunner,
      verificationEmailDelivery: { deliver: deliverVerificationEmail },
      verificationSecretGenerator,
      now: () => registeredAt,
    }),
    isCompromised,
    hashPassword,
    transactionRunner,
    deliverVerificationEmail,
  };
}

describe("RegisterUser", () => {
  it("creates a pending password registration and returns an internal verification capability", async () => {
    const harness = createHarness();
    const decomposedPassword = "e\u0301".repeat(15);

    await expect(
      harness.useCase.execute({
        email: "  User@Example.COM  ",
        password: decomposedPassword,
      }),
    ).resolves.toEqual({
      status: "created",
      userId: "0198-user-id",
      verification: {
        recipientEmail: "User@Example.COM",
        credential: "0198-token-id.verification-secret",
        expiresAt: new Date(registeredAt.getTime() + emailVerificationLifetimeMilliseconds),
      },
    });

    expect(harness.isCompromised).toHaveBeenCalledWith("é".repeat(15));
    expect(harness.hashPassword).toHaveBeenCalledWith("é".repeat(15));
    expect(harness.transactionRunner.receivedInput).toEqual({
      displayEmail: "User@Example.COM",
      normalizedEmail: "user@example.com",
      passwordHash: "$argon2id$atlas-hash",
      verificationSecretDigest: verificationDigest,
      registeredAt,
      verificationExpiresAt: new Date(
        registeredAt.getTime() + emailVerificationLifetimeMilliseconds,
      ),
    });
    expect(harness.transactionRunner.receivedInput).not.toHaveProperty("password");
    expect(harness.transactionRunner.receivedInput).not.toHaveProperty("verificationSecret");
    expect(harness.deliverVerificationEmail).toHaveBeenCalledWith({
      recipientEmail: "User@Example.COM",
      credential: "0198-token-id.verification-secret",
      expiresAt: new Date(registeredAt.getTime() + emailVerificationLifetimeMilliseconds),
    });
  });

  it("keeps an existing normalized email as an internal non-creation outcome", async () => {
    const harness = createHarness({ status: "email_exists" });

    await expect(
      harness.useCase.execute({
        email: "existing@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ status: "email_exists" });

    expect(harness.hashPassword).toHaveBeenCalledOnce();
    expect(harness.deliverVerificationEmail).not.toHaveBeenCalled();
  });

  it("rejects compromised passwords before hashing or opening a transaction", async () => {
    const harness = createHarness();
    harness.isCompromised.mockResolvedValue(true);

    const action = harness.useCase.execute({
      email: "user@example.com",
      password: "correct horse battery staple",
    });

    await expect(action).rejects.toBeInstanceOf(IdentityInputValidationError);
    await expect(action).rejects.toMatchObject({
      field: "password",
      issue: "PASSWORD_COMPROMISED",
    });
    expect(harness.hashPassword).not.toHaveBeenCalled();
    expect(harness.transactionRunner.receivedInput).toBeUndefined();
  });
});
