import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  LogoutSessionTransaction,
  LogoutSessionTransactionRunner,
  RevokeCurrentSessionInput,
  RevokeCurrentSessionResult,
} from "../src/modules/identity/application/logout-session-transaction.js";
import { LogoutSession } from "../src/modules/identity/application/logout-session.js";
import type { SessionCsrfTokenService } from "../src/modules/identity/application/session-csrf-token-service.js";

const revokedAt = new Date("2026-08-22T12:15:00.000Z");
const tokenId = "019c0000-0000-7000-8000-000000000001";
const refreshSecret = "r".repeat(43);
const csrfToken = `${"n".repeat(43)}.${"s".repeat(43)}`;

class FakeLogoutSessionTransactionRunner implements LogoutSessionTransactionRunner {
  public receivedInput: RevokeCurrentSessionInput | undefined;

  public constructor(private readonly result: RevokeCurrentSessionResult) {}

  public execute<Result>(
    operation: (transaction: LogoutSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      revokeCurrentSession: (input) => {
        this.receivedInput = input;
        if (!input.authorizeSession("session-id")) {
          return Promise.resolve({ status: "csrf_failed" });
        }
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(transactionResult: RevokeCurrentSessionResult = { status: "revoked" }): {
  readonly logoutSession: LogoutSession;
  readonly verifyCsrf: ReturnType<typeof vi.fn<SessionCsrfTokenService["verify"]>>;
  readonly runner: FakeLogoutSessionTransactionRunner;
} {
  const verifyCsrf = vi.fn<SessionCsrfTokenService["verify"]>().mockReturnValue(true);
  const runner = new FakeLogoutSessionTransactionRunner(transactionResult);
  return {
    logoutSession: new LogoutSession({
      sessionCsrfTokenService: { issue: vi.fn(), verify: verifyCsrf },
      transactionRunner: runner,
      now: () => revokedAt,
    }),
    verifyCsrf,
    runner,
  };
}

const command = {
  refreshCredential: `${tokenId}.${refreshSecret}`,
  csrfCookie: csrfToken,
  csrfHeader: csrfToken,
  requestId: "logout-request",
};

describe("LogoutSession", () => {
  it("authenticates the refresh secret and session-bound CSRF token before revocation", async () => {
    const harness = createHarness();

    await expect(harness.logoutSession.execute(command)).resolves.toEqual({
      status: "logged_out",
    });
    expect(harness.runner.receivedInput).toMatchObject({
      tokenId,
      secretDigest: createHash("sha256").update(refreshSecret, "utf8").digest(),
      revokedAt,
      requestId: "logout-request",
    });
    expect(harness.verifyCsrf).toHaveBeenCalledWith("session-id", csrfToken);
  });

  it.each([
    { ...command, csrfCookie: undefined },
    { ...command, csrfHeader: undefined },
    { ...command, csrfHeader: "different" },
  ])("rejects missing or unequal double-submit CSRF values", async (invalidCommand) => {
    const harness = createHarness();

    await expect(harness.logoutSession.execute(invalidCommand)).resolves.toEqual({
      status: "csrf_failed",
    });
    expect(harness.runner.receivedInput).toBeUndefined();
  });

  it("maps malformed and invalid credentials to authentication required", async () => {
    const malformed = createHarness();
    await expect(
      malformed.logoutSession.execute({ ...command, refreshCredential: "malformed" }),
    ).resolves.toEqual({ status: "authentication_required" });
    expect(malformed.runner.receivedInput).toBeUndefined();

    const invalid = createHarness({ status: "invalid_credential" });
    await expect(invalid.logoutSession.execute(command)).resolves.toEqual({
      status: "authentication_required",
    });
  });

  it("propagates session-bound CSRF rejection", async () => {
    const harness = createHarness();
    harness.verifyCsrf.mockReturnValue(false);

    await expect(harness.logoutSession.execute(command)).resolves.toEqual({
      status: "csrf_failed",
    });
  });
});
