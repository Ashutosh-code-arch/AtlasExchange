import { describe, expect, it, vi } from "vitest";

import type { AuthenticatePassword } from "../src/modules/identity/application/authenticate-password.js";
import type {
  IssueLoginSessionInput,
  IssueLoginSessionResult,
  LoginSessionTransaction,
  LoginSessionTransactionRunner,
} from "../src/modules/identity/application/login-session-transaction.js";
import {
  accessCredentialLifetimeMilliseconds,
  LoginUser,
  sessionAbsoluteLifetimeMilliseconds,
} from "../src/modules/identity/application/login-user.js";
import type { OpaqueCredentialGenerator } from "../src/modules/identity/application/opaque-credential-generator.js";
import type { PasswordHasher } from "../src/modules/identity/application/password-hasher.js";

const issuedAt = new Date("2026-08-22T12:00:00.000Z");
const credentialUpdatedAt = new Date("2026-08-22T11:00:00.000Z");
const accessDigest = new Uint8Array(32).fill(1);
const refreshDigest = new Uint8Array(32).fill(2);

class FakeLoginSessionTransactionRunner implements LoginSessionTransactionRunner {
  public receivedInput: IssueLoginSessionInput | undefined;

  public constructor(private readonly result: IssueLoginSessionResult) {}

  public execute<Result>(
    operation: (transaction: LoginSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      issueLoginSession: (input) => {
        this.receivedInput = input;
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(
  options: {
    readonly authenticationResult?: Awaited<ReturnType<AuthenticatePassword["execute"]>>;
    readonly transactionResult?: IssueLoginSessionResult;
  } = {},
): {
  readonly loginUser: LoginUser;
  readonly authenticate: ReturnType<typeof vi.fn<AuthenticatePassword["execute"]>>;
  readonly generateCredential: ReturnType<typeof vi.fn<OpaqueCredentialGenerator["generate"]>>;
  readonly hashPassword: ReturnType<typeof vi.fn<PasswordHasher["hash"]>>;
  readonly transactionRunner: FakeLoginSessionTransactionRunner;
} {
  const authenticate = vi.fn<AuthenticatePassword["execute"]>().mockResolvedValue(
    options.authenticationResult ?? {
      status: "authenticated",
      userId: "user-id",
      displayEmail: "User@Example.com",
      credentialUpdatedAt,
      passwordHashNeedsRehash: false,
    },
  );
  const generateCredential = vi
    .fn<OpaqueCredentialGenerator["generate"]>()
    .mockReturnValueOnce({ secret: "access-secret", digest: accessDigest })
    .mockReturnValueOnce({ secret: "refresh-secret", digest: refreshDigest });
  const hashPassword = vi.fn<PasswordHasher["hash"]>().mockResolvedValue("replacement-hash");
  const transactionRunner = new FakeLoginSessionTransactionRunner(
    options.transactionResult ?? {
      status: "issued",
      sessionId: "session-id",
      accessTokenId: "access-id",
      refreshTokenId: "refresh-id",
    },
  );

  return {
    loginUser: new LoginUser({
      authenticatePassword: { execute: authenticate },
      credentialGenerator: { generate: generateCredential },
      passwordHasher: {
        hash: hashPassword,
        verify: vi.fn<PasswordHasher["verify"]>(),
        needsRehash: vi.fn<PasswordHasher["needsRehash"]>(),
      },
      transactionRunner,
      now: () => issuedAt,
    }),
    authenticate,
    generateCredential,
    hashPassword,
    transactionRunner,
  };
}

const command = {
  email: "user@example.com",
  password: "safe login password",
  requestId: "login-request-id",
};

describe("LoginUser", () => {
  it("creates a session and returns credentials only after the transaction succeeds", async () => {
    const harness = createHarness();

    await expect(harness.loginUser.execute(command)).resolves.toEqual({
      status: "authenticated",
      user: { id: "user-id", email: "User@Example.com" },
      session: {
        id: "session-id",
        absoluteExpiresAt: new Date(issuedAt.getTime() + sessionAbsoluteLifetimeMilliseconds),
      },
      accessCredential: {
        value: "access-id.access-secret",
        expiresAt: new Date(issuedAt.getTime() + accessCredentialLifetimeMilliseconds),
      },
      refreshCredential: {
        value: "refresh-id.refresh-secret",
        expiresAt: new Date(issuedAt.getTime() + sessionAbsoluteLifetimeMilliseconds),
      },
    });
    expect(harness.transactionRunner.receivedInput).toEqual({
      userId: "user-id",
      expectedCredentialUpdatedAt: credentialUpdatedAt,
      accessSecretDigest: accessDigest,
      refreshSecretDigest: refreshDigest,
      issuedAt,
      accessExpiresAt: new Date(issuedAt.getTime() + accessCredentialLifetimeMilliseconds),
      absoluteExpiresAt: new Date(issuedAt.getTime() + sessionAbsoluteLifetimeMilliseconds),
      requestId: "login-request-id",
    });
    expect(harness.transactionRunner.receivedInput).not.toHaveProperty("accessSecret");
    expect(harness.transactionRunner.receivedInput).not.toHaveProperty("refreshSecret");
  });

  it("rehashes an obsolete password before the atomic session transaction", async () => {
    const harness = createHarness({
      authenticationResult: {
        status: "authenticated",
        userId: "user-id",
        displayEmail: "User@Example.com",
        credentialUpdatedAt,
        passwordHashNeedsRehash: true,
      },
    });

    await harness.loginUser.execute(command);

    expect(harness.hashPassword).toHaveBeenCalledWith(command.password);
    expect(harness.transactionRunner.receivedInput).toMatchObject({
      replacementPasswordHash: "replacement-hash",
    });
  });

  it.each([
    { status: "invalid_credentials" as const },
    { status: "verification_required" as const, userId: "user-id" },
    { status: "account_unavailable" as const, userId: "user-id" },
  ])("does not generate credentials when authentication returns $status", async (result) => {
    const harness = createHarness({ authenticationResult: result });

    await expect(harness.loginUser.execute(command)).resolves.toEqual(result);
    expect(harness.generateCredential).not.toHaveBeenCalled();
    expect(harness.transactionRunner.receivedInput).toBeUndefined();
  });

  it("maps a credential-change race to invalid credentials without returning generated secrets", async () => {
    const harness = createHarness({ transactionResult: { status: "credential_changed" } });

    await expect(harness.loginUser.execute(command)).resolves.toEqual({
      status: "invalid_credentials",
    });
  });
});
