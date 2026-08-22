import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { OpaqueCredentialGenerator } from "../src/modules/identity/application/opaque-credential-generator.js";
import type {
  RefreshSessionTransaction,
  RefreshSessionTransactionRunner,
  RotateRefreshSessionInput,
  RotateRefreshSessionResult,
} from "../src/modules/identity/application/refresh-session-transaction.js";
import { RefreshSession } from "../src/modules/identity/application/refresh-session.js";
import type { SessionCsrfTokenService } from "../src/modules/identity/application/session-csrf-token-service.js";
import { parseRefreshCredential } from "../src/modules/identity/domain/refresh-credential.js";

const now = new Date("2026-08-22T12:10:00.000Z");
const absoluteExpiresAt = new Date("2026-09-21T12:00:00.000Z");
const tokenId = "019c0000-0000-7000-8000-000000000001";
const presentedSecret = "p".repeat(43);
const csrfToken = `${"n".repeat(43)}.${"s".repeat(43)}`;
const accessDigest = new Uint8Array(32).fill(1);
const refreshDigest = new Uint8Array(32).fill(2);

class FakeRefreshSessionTransactionRunner implements RefreshSessionTransactionRunner {
  public receivedInput: RotateRefreshSessionInput | undefined;

  public constructor(private readonly result: RotateRefreshSessionResult) {}

  public execute<Result>(
    operation: (transaction: RefreshSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      rotate: (input) => {
        this.receivedInput = input;
        if (!input.authorizeSession("session-id")) {
          return Promise.resolve({ status: "csrf_failed" });
        }
        return Promise.resolve(this.result);
      },
    });
  }
}

function createHarness(
  transactionResult: RotateRefreshSessionResult = {
    status: "rotated",
    sessionId: "session-id",
    sessionAbsoluteExpiresAt: absoluteExpiresAt,
    accessTokenId: "replacement-access-id",
    accessExpiresAt: new Date("2026-08-22T12:20:00.000Z"),
    refreshTokenId: "replacement-refresh-id",
  },
): {
  readonly refreshSession: RefreshSession;
  readonly generate: ReturnType<typeof vi.fn<OpaqueCredentialGenerator["generate"]>>;
  readonly verifyCsrf: ReturnType<typeof vi.fn<SessionCsrfTokenService["verify"]>>;
  readonly transactionRunner: FakeRefreshSessionTransactionRunner;
} {
  const generate = vi
    .fn<OpaqueCredentialGenerator["generate"]>()
    .mockReturnValueOnce({ secret: "replacement-access-secret", digest: accessDigest })
    .mockReturnValueOnce({ secret: "replacement-refresh-secret", digest: refreshDigest });
  const verifyCsrf = vi.fn<SessionCsrfTokenService["verify"]>().mockReturnValue(true);
  const transactionRunner = new FakeRefreshSessionTransactionRunner(transactionResult);
  return {
    refreshSession: new RefreshSession({
      credentialGenerator: { generate },
      sessionCsrfTokenService: { issue: vi.fn(), verify: verifyCsrf },
      transactionRunner,
      now: () => now,
    }),
    generate,
    verifyCsrf,
    transactionRunner,
  };
}

const validCommand = {
  refreshCredential: `${tokenId}.${presentedSecret}`,
  csrfCookie: csrfToken,
  csrfHeader: csrfToken,
  requestId: "refresh-request",
};

describe("RefreshSession", () => {
  it("rotates opaque credentials without passing their raw secrets to persistence", async () => {
    const harness = createHarness();

    await expect(harness.refreshSession.execute(validCommand)).resolves.toEqual({
      status: "rotated",
      session: { id: "session-id", absoluteExpiresAt },
      accessCredential: {
        value: "replacement-access-id.replacement-access-secret",
        expiresAt: new Date("2026-08-22T12:20:00.000Z"),
      },
      refreshCredential: {
        value: "replacement-refresh-id.replacement-refresh-secret",
        expiresAt: absoluteExpiresAt,
      },
    });
    expect(harness.transactionRunner.receivedInput).toMatchObject({
      tokenId,
      secretDigest: createHash("sha256").update(presentedSecret, "utf8").digest(),
      replacementAccessSecretDigest: accessDigest,
      replacementRefreshSecretDigest: refreshDigest,
      issuedAt: now,
      requestedAccessExpiresAt: new Date("2026-08-22T12:20:00.000Z"),
      requestId: "refresh-request",
    });
    expect(harness.verifyCsrf).toHaveBeenCalledWith("session-id", csrfToken);
    expect(JSON.stringify(harness.transactionRunner.receivedInput)).not.toMatch(
      /replacement-access-secret|replacement-refresh-secret/,
    );
  });

  it.each([
    [{ ...validCommand, csrfCookie: undefined }, "missing cookie"],
    [{ ...validCommand, csrfHeader: undefined }, "missing header"],
    [{ ...validCommand, csrfHeader: "different" }, "unequal values"],
  ] as const)("rejects CSRF before generating credentials for %s", async (command, _label) => {
    const harness = createHarness();

    await expect(harness.refreshSession.execute(command)).resolves.toEqual({
      status: "csrf_failed",
    });
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.transactionRunner.receivedInput).toBeUndefined();
  });

  it.each(["malformed", `${tokenId}.short`, `${tokenId}.${presentedSecret}.extra`])(
    "maps a malformed refresh credential to authentication required: %s",
    async (refreshCredential) => {
      const harness = createHarness();

      await expect(
        harness.refreshSession.execute({ ...validCommand, refreshCredential }),
      ).resolves.toEqual({ status: "authentication_required" });
      expect(harness.generate).not.toHaveBeenCalled();
    },
  );

  it.each(["invalid_credential", "reuse_detected"] as const)(
    "maps internal %s to the same public authentication result",
    async (status) => {
      const harness = createHarness({ status });

      await expect(harness.refreshSession.execute(validCommand)).resolves.toEqual({
        status: "authentication_required",
      });
    },
  );

  it("propagates a session-bound CSRF failure without rotating", async () => {
    const harness = createHarness();
    harness.verifyCsrf.mockReturnValue(false);

    await expect(harness.refreshSession.execute(validCommand)).resolves.toEqual({
      status: "csrf_failed",
    });
  });
});

describe("refresh credential parser", () => {
  it("authenticates the secret through its SHA-256 digest", () => {
    expect(parseRefreshCredential(`${tokenId}.${presentedSecret}`)).toEqual({
      tokenId,
      secretDigest: createHash("sha256").update(presentedSecret, "utf8").digest(),
    });
  });
});
