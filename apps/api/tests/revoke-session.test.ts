import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedContext } from "../src/modules/identity/application/authenticated-context.js";
import {
  RevokeSession,
  type RevokeSessionCommand,
} from "../src/modules/identity/application/revoke-session.js";
import type {
  RevokeOwnedSessionInput,
  RevokeOwnedSessionResult,
  RevokeSessionTransaction,
  RevokeSessionTransactionRunner,
} from "../src/modules/identity/application/revoke-session-transaction.js";
import type { SessionCsrfTokenService } from "../src/modules/identity/application/session-csrf-token-service.js";

const revokedAt = new Date("2026-08-23T12:00:00.000Z");
const csrfToken = `${"n".repeat(43)}.${"s".repeat(43)}`;
const context: AuthenticatedContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  authorization: { roles: ["user"] },
  requestId: "revoke-session-request",
};
const otherSessionId = "33333333-3333-4333-8333-333333333333";

class FakeRevokeSessionTransactionRunner implements RevokeSessionTransactionRunner {
  public receivedInput: RevokeOwnedSessionInput | undefined;

  public constructor(private readonly result: RevokeOwnedSessionResult = { status: "revoked" }) {}

  public execute<Result>(
    operation: (transaction: RevokeSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      revokeOwnedSession: (input) => {
        this.receivedInput = input;
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(transactionResult: RevokeOwnedSessionResult = { status: "revoked" }): {
  readonly useCase: RevokeSession;
  readonly verifyCsrf: ReturnType<typeof vi.fn<SessionCsrfTokenService["verify"]>>;
  readonly runner: FakeRevokeSessionTransactionRunner;
} {
  const verifyCsrf = vi.fn<SessionCsrfTokenService["verify"]>().mockReturnValue(true);
  const runner = new FakeRevokeSessionTransactionRunner(transactionResult);
  return {
    useCase: new RevokeSession({
      sessionCsrfTokenService: { issue: vi.fn(), verify: verifyCsrf },
      transactionRunner: runner,
      now: () => revokedAt,
    }),
    verifyCsrf,
    runner,
  };
}

function command(targetSessionId = otherSessionId): RevokeSessionCommand {
  return {
    context,
    targetSessionId,
    csrfCookie: csrfToken,
    csrfHeader: csrfToken,
  };
}

describe("RevokeSession", () => {
  it("authorizes with current-session CSRF before revoking an owned target", async () => {
    const harness = createHarness();

    await expect(harness.useCase.execute(command())).resolves.toEqual({
      status: "completed",
      revokedCurrentSession: false,
    });
    expect(harness.verifyCsrf).toHaveBeenCalledWith(context.sessionId, csrfToken);
    expect(harness.runner.receivedInput).toEqual({
      actorUserId: context.userId,
      actorSessionId: context.sessionId,
      targetSessionId: otherSessionId,
      revokedAt,
      requestId: context.requestId,
    });
  });

  it("marks current-session revocation so the HTTP boundary can clear cookies", async () => {
    const harness = createHarness();

    await expect(harness.useCase.execute(command(context.sessionId))).resolves.toEqual({
      status: "completed",
      revokedCurrentSession: true,
    });
  });

  it("keeps missing and already-revoked targets idempotent", async () => {
    const harness = createHarness({ status: "not_active" });

    await expect(harness.useCase.execute(command())).resolves.toEqual({
      status: "completed",
      revokedCurrentSession: false,
    });
  });

  it.each([
    { ...command(), csrfCookie: undefined },
    { ...command(), csrfHeader: undefined },
    { ...command(), csrfHeader: "different" },
  ])("rejects missing or unequal double-submit CSRF values", async (invalidCommand) => {
    const harness = createHarness();

    await expect(harness.useCase.execute(invalidCommand)).resolves.toEqual({
      status: "csrf_failed",
    });
    expect(harness.runner.receivedInput).toBeUndefined();
  });

  it("rejects a CSRF token not signed for the current session", async () => {
    const harness = createHarness();
    harness.verifyCsrf.mockReturnValue(false);

    await expect(harness.useCase.execute(command())).resolves.toEqual({
      status: "csrf_failed",
    });
    expect(harness.runner.receivedInput).toBeUndefined();
  });
});
