import { describe, expect, it, vi } from "vitest";

import { AuthenticatePassword } from "../src/modules/identity/application/authenticate-password.js";
import type { PasswordAccountReader } from "../src/modules/identity/application/password-account-reader.js";
import type { PasswordHasher } from "../src/modules/identity/application/password-hasher.js";
import type { IdentityAccountState } from "../src/modules/identity/domain/account-state.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";

const dummyPasswordHash = "$argon2id$dummy";
const storedPasswordHash = "$argon2id$stored";
const credentialUpdatedAt = new Date("2026-08-22T10:00:00.000Z");

function createHarness(
  options: {
    readonly accountState?: IdentityAccountState;
    readonly passwordMatches?: boolean;
    readonly needsRehash?: boolean;
    readonly accountExists?: boolean;
  } = {},
): {
  readonly authenticatePassword: AuthenticatePassword;
  readonly findByNormalizedEmail: ReturnType<
    typeof vi.fn<PasswordAccountReader["findByNormalizedEmail"]>
  >;
  readonly verifyPassword: ReturnType<typeof vi.fn<PasswordHasher["verify"]>>;
  readonly needsRehash: ReturnType<typeof vi.fn<PasswordHasher["needsRehash"]>>;
} {
  const findByNormalizedEmail = vi.fn<PasswordAccountReader["findByNormalizedEmail"]>();
  if (options.accountExists === false) {
    findByNormalizedEmail.mockResolvedValue(undefined);
  } else {
    findByNormalizedEmail.mockResolvedValue({
      userId: "user-id",
      displayEmail: "User@Example.com",
      state: options.accountState ?? "active",
      passwordHash: storedPasswordHash,
      credentialUpdatedAt,
    });
  }
  const verifyPassword = vi
    .fn<PasswordHasher["verify"]>()
    .mockResolvedValue(options.passwordMatches ?? true);
  const needsRehash = vi
    .fn<PasswordHasher["needsRehash"]>()
    .mockReturnValue(options.needsRehash ?? false);

  return {
    authenticatePassword: new AuthenticatePassword({
      passwordAccountReader: { findByNormalizedEmail },
      passwordHasher: {
        hash: vi.fn<PasswordHasher["hash"]>(),
        verify: verifyPassword,
        needsRehash,
      },
      dummyPasswordHash,
    }),
    findByNormalizedEmail,
    verifyPassword,
    needsRehash,
  };
}

describe("AuthenticatePassword", () => {
  it("authenticates an active account and reports whether its hash needs upgrading", async () => {
    const harness = createHarness({ needsRehash: true });

    await expect(
      harness.authenticatePassword.execute({
        email: "  USER@example.COM  ",
        password: "safe login password",
      }),
    ).resolves.toEqual({
      status: "authenticated",
      userId: "user-id",
      displayEmail: "User@Example.com",
      credentialUpdatedAt,
      passwordHashNeedsRehash: true,
    });
    expect(harness.findByNormalizedEmail).toHaveBeenCalledWith("user@example.com");
    expect(harness.verifyPassword).toHaveBeenCalledWith("safe login password", storedPasswordHash);
    expect(harness.needsRehash).toHaveBeenCalledWith(storedPasswordHash);
  });

  it("uses the dummy hash and returns the same failure for an unknown account", async () => {
    const harness = createHarness({ accountExists: false, passwordMatches: false });

    await expect(
      harness.authenticatePassword.execute({
        email: "unknown@example.com",
        password: "safe login password",
      }),
    ).resolves.toEqual({ status: "invalid_credentials" });
    expect(harness.verifyPassword).toHaveBeenCalledWith("safe login password", dummyPasswordHash);
    expect(harness.needsRehash).not.toHaveBeenCalled();
  });

  it("returns the same invalid-credential decision for an incorrect known password", async () => {
    const harness = createHarness({ passwordMatches: false });

    await expect(
      harness.authenticatePassword.execute({
        email: "user@example.com",
        password: "incorrect password",
      }),
    ).resolves.toEqual({ status: "invalid_credentials" });
    expect(harness.needsRehash).not.toHaveBeenCalled();
  });

  it("verifies a short wrong password instead of applying the registration minimum", async () => {
    const harness = createHarness({ passwordMatches: false });

    await expect(
      harness.authenticatePassword.execute({
        email: "user@example.com",
        password: "short",
      }),
    ).resolves.toEqual({ status: "invalid_credentials" });
    expect(harness.verifyPassword).toHaveBeenCalledWith("short", storedPasswordHash);
  });

  it.each([
    ["pending_verification", "verification_required"],
    ["suspended", "account_unavailable"],
    ["disabled", "account_unavailable"],
  ] as const)("maps a valid password for %s to %s", async (accountState, expectedStatus) => {
    const harness = createHarness({ accountState });

    await expect(
      harness.authenticatePassword.execute({
        email: "user@example.com",
        password: "safe login password",
      }),
    ).resolves.toEqual({ status: expectedStatus, userId: "user-id" });
    expect(harness.needsRehash).not.toHaveBeenCalled();
  });

  it("rejects invalid input before account lookup or password verification", async () => {
    const harness = createHarness();

    await expect(
      harness.authenticatePassword.execute({ email: "invalid", password: "safe login password" }),
    ).rejects.toBeInstanceOf(IdentityInputValidationError);
    expect(harness.findByNormalizedEmail).not.toHaveBeenCalled();
    expect(harness.verifyPassword).not.toHaveBeenCalled();
  });
});
