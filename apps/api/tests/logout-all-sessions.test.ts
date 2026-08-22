import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  LogoutAllSessionsTransaction,
  LogoutAllSessionsTransactionRunner,
  RevokeAllSessionsInput,
  RevokeAllSessionsResult,
} from "../src/modules/identity/application/logout-all-sessions-transaction.js";
import { LogoutAllSessions } from "../src/modules/identity/application/logout-all-sessions.js";
import type { SessionCsrfTokenService } from "../src/modules/identity/application/session-csrf-token-service.js";

const revokedAt = new Date("2026-08-22T12:15:00.000Z");
const tokenId = "019c0000-0000-7000-8000-000000000001";
const refreshSecret = "r".repeat(43);
const csrfToken = `${"n".repeat(43)}.${"s".repeat(43)}`;

class FakeRunner implements LogoutAllSessionsTransactionRunner {
  public receivedInput: RevokeAllSessionsInput | undefined;

  public constructor(private readonly result: RevokeAllSessionsResult) {}

  public execute<Result>(
    operation: (transaction: LogoutAllSessionsTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      revokeAllSessions: (input) => {
        this.receivedInput = input;
        return Promise.resolve(
          input.authorizeSession("session-id") ? this.result : { status: "csrf_failed" },
        );
      },
    });
  }
}

function createHarness(result: RevokeAllSessionsResult = { status: "revoked" }): {
  readonly logoutAll: LogoutAllSessions;
  readonly verifyCsrf: ReturnType<typeof vi.fn<SessionCsrfTokenService["verify"]>>;
  readonly runner: FakeRunner;
} {
  const verifyCsrf = vi.fn<SessionCsrfTokenService["verify"]>().mockReturnValue(true);
  const runner = new FakeRunner(result);
  return {
    logoutAll: new LogoutAllSessions({
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
  requestId: "logout-all-request",
};

describe("LogoutAllSessions", () => {
  it("authenticates the current session before revoking every user session", async () => {
    const harness = createHarness();

    await expect(harness.logoutAll.execute(command)).resolves.toEqual({ status: "logged_out" });
    expect(harness.runner.receivedInput).toMatchObject({
      tokenId,
      secretDigest: createHash("sha256").update(refreshSecret, "utf8").digest(),
      revokedAt,
      requestId: "logout-all-request",
    });
    expect(harness.verifyCsrf).toHaveBeenCalledWith("session-id", csrfToken);
  });

  it.each([
    { ...command, csrfCookie: undefined },
    { ...command, csrfHeader: undefined },
    { ...command, csrfHeader: "different" },
  ])("rejects invalid double-submit CSRF before persistence", async (invalidCommand) => {
    const harness = createHarness();

    await expect(harness.logoutAll.execute(invalidCommand)).resolves.toEqual({
      status: "csrf_failed",
    });
    expect(harness.runner.receivedInput).toBeUndefined();
  });

  it("maps malformed and invalid credentials to authentication required", async () => {
    const malformed = createHarness();
    await expect(
      malformed.logoutAll.execute({ ...command, refreshCredential: "malformed" }),
    ).resolves.toEqual({ status: "authentication_required" });

    const invalid = createHarness({ status: "invalid_credential" });
    await expect(invalid.logoutAll.execute(command)).resolves.toEqual({
      status: "authentication_required",
    });
  });

  it("propagates session-bound CSRF rejection", async () => {
    const harness = createHarness();
    harness.verifyCsrf.mockReturnValue(false);
    await expect(harness.logoutAll.execute(command)).resolves.toEqual({ status: "csrf_failed" });
  });
});
