import { describe, expect, it, vi } from "vitest";

import type {
  CreateActiveDemoIdentityInput,
  DemoIdentityProvisioningTransaction,
  ExistingDemoIdentity,
} from "../src/modules/identity/application/demo-identity-provisioning-transaction.js";
import type { CompromisedPasswordChecker } from "../src/modules/identity/application/compromised-password-checker.js";
import type { PasswordHasher } from "../src/modules/identity/application/password-hasher.js";
import {
  DemoIdentityProvisioningConflictError,
  ProvisionDemoIdentity,
} from "../src/modules/identity/application/provision-demo-identity.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";

interface DemoIdentityHarness {
  readonly useCase: ProvisionDemoIdentity;
  readonly findByNormalizedEmail: ReturnType<
    typeof vi.fn<DemoIdentityProvisioningTransaction["findByNormalizedEmail"]>
  >;
  readonly createActiveIdentity: ReturnType<
    typeof vi.fn<DemoIdentityProvisioningTransaction["createActiveIdentity"]>
  >;
  readonly verifyPassword: ReturnType<typeof vi.fn<PasswordHasher["verify"]>>;
  readonly isCompromised: ReturnType<typeof vi.fn<CompromisedPasswordChecker["isCompromised"]>>;
  readonly createdInput: () => CreateActiveDemoIdentityInput | undefined;
}

function createUseCase(existing: ExistingDemoIdentity | null = null): DemoIdentityHarness {
  let createdInput: CreateActiveDemoIdentityInput | undefined;
  const findByNormalizedEmail = vi
    .fn<DemoIdentityProvisioningTransaction["findByNormalizedEmail"]>()
    .mockResolvedValue(existing);
  const createActiveIdentity = vi.fn<DemoIdentityProvisioningTransaction["createActiveIdentity"]>(
    (input) => {
      createdInput = input;
      return Promise.resolve({ userId: "019c1234-0000-7000-8000-000000000001" });
    },
  );
  const transaction: DemoIdentityProvisioningTransaction = {
    findByNormalizedEmail,
    createActiveIdentity,
  };
  const verifyPassword = vi.fn<PasswordHasher["verify"]>().mockResolvedValue(true);
  const passwordHasher = {
    hash: vi.fn().mockResolvedValue("approved-password-hash"),
    verify: verifyPassword,
    needsRehash: vi.fn().mockReturnValue(false),
  };
  const isCompromised = vi
    .fn<CompromisedPasswordChecker["isCompromised"]>()
    .mockResolvedValue(false);
  const compromisedPasswordChecker = { isCompromised };
  const useCase = new ProvisionDemoIdentity({
    compromisedPasswordChecker,
    passwordHasher,
    transactionRunner: {
      execute: <Result>(
        operation: (candidate: DemoIdentityProvisioningTransaction) => Promise<Result>,
      ) => operation(transaction),
    },
    now: () => new Date("2026-08-31T15:00:00.000Z"),
  });
  return {
    useCase,
    findByNormalizedEmail,
    createActiveIdentity,
    verifyPassword,
    isCompromised,
    createdInput: () => createdInput,
  };
}

describe("demo identity provisioning", () => {
  it("creates one active user-only password identity without a verification capability", async () => {
    const harness = createUseCase();

    await expect(
      harness.useCase.execute({
        email: "Demo.User@Example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ status: "created" });
    expect(harness.createdInput()).toEqual({
      displayEmail: "Demo.User@Example.com",
      normalizedEmail: "demo.user@example.com",
      passwordHash: "approved-password-hash",
      provisionedAt: new Date("2026-08-31T15:00:00.000Z"),
    });
  });

  it("is idempotent only when the existing authoritative identity matches exactly", async () => {
    const harness = createUseCase({
      userId: "019c1234-0000-7000-8000-000000000001",
      displayEmail: "demo@example.com",
      state: "active",
      passwordHash: "existing-password-hash",
      roles: ["user"],
    });

    await expect(
      harness.useCase.execute({
        email: "demo@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ status: "existing" });
    expect(harness.verifyPassword).toHaveBeenCalledWith(
      "correct horse battery staple",
      "existing-password-hash",
    );
    expect(harness.createActiveIdentity).not.toHaveBeenCalled();
  });

  it.each([
    { state: "suspended" as const, roles: ["user"], passwordMatches: true },
    { state: "active" as const, roles: ["admin", "user"], passwordMatches: true },
    { state: "active" as const, roles: ["user"], passwordMatches: false },
  ])("refuses to overwrite a conflicting existing identity: %o", async (conflict) => {
    const harness = createUseCase({
      userId: "019c1234-0000-7000-8000-000000000001",
      displayEmail: "demo@example.com",
      state: conflict.state,
      passwordHash: "existing-password-hash",
      roles: conflict.roles,
    });
    harness.verifyPassword.mockResolvedValue(conflict.passwordMatches);

    await expect(
      harness.useCase.execute({
        email: "demo@example.com",
        password: "correct horse battery staple",
      }),
    ).rejects.toBeInstanceOf(DemoIdentityProvisioningConflictError);
    expect(harness.createActiveIdentity).not.toHaveBeenCalled();
  });

  it("rejects a compromised password before reading or mutating persistence", async () => {
    const harness = createUseCase();
    harness.isCompromised.mockResolvedValue(true);

    await expect(
      harness.useCase.execute({
        email: "demo@example.com",
        password: "correct horse battery staple",
      }),
    ).rejects.toEqual(new IdentityInputValidationError("password", "PASSWORD_COMPROMISED"));
    expect(harness.findByNormalizedEmail).not.toHaveBeenCalled();
  });
});
