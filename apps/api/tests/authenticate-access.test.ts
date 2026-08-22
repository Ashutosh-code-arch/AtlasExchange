import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AccessSessionAuthenticator } from "../src/modules/identity/application/access-session-authenticator.js";
import { AuthenticateAccess } from "../src/modules/identity/application/authenticate-access.js";

const tokenId = "11111111-1111-4111-8111-111111111111";
const secret = "s".repeat(43);
const authenticatedAt = new Date("2026-08-23T10:00:00.000Z");

describe("AuthenticateAccess", () => {
  it("builds a credential-free authenticated context from a valid access credential", async () => {
    const authenticate = vi.fn<AccessSessionAuthenticator["authenticate"]>().mockResolvedValue({
      userId: "22222222-2222-4222-8222-222222222222",
      displayEmail: "User@Example.com",
      sessionId: "33333333-3333-4333-8333-333333333333",
      roles: ["admin", "user"],
    });
    const useCase = new AuthenticateAccess({
      accessSessionAuthenticator: { authenticate },
      now: () => authenticatedAt,
    });

    const result = await useCase.execute({
      accessCredential: `${tokenId}.${secret}`,
      requestId: "request-123",
    });

    expect(authenticate).toHaveBeenCalledWith({
      tokenId,
      secretDigest: createHash("sha256").update(secret).digest(),
      authenticatedAt,
    });
    expect(result).toEqual({
      status: "authenticated",
      context: {
        userId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        authorization: { roles: ["admin", "user"] },
        requestId: "request-123",
      },
      user: { email: "User@Example.com" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["", "not-a-token", `${tokenId}.short`, `not-a-uuid.${secret}`])(
    "rejects malformed credential %j before persistence",
    async (accessCredential) => {
      const authenticate = vi.fn<AccessSessionAuthenticator["authenticate"]>();
      const useCase = new AuthenticateAccess({
        accessSessionAuthenticator: { authenticate },
        now: () => authenticatedAt,
      });

      await expect(
        useCase.execute({ accessCredential, requestId: "request-123" }),
      ).resolves.toEqual({ status: "authentication_required" });
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  it("maps an unrecognized, expired, or unavailable persisted session generically", async () => {
    const authenticate = vi
      .fn<AccessSessionAuthenticator["authenticate"]>()
      .mockResolvedValue(undefined);
    const useCase = new AuthenticateAccess({
      accessSessionAuthenticator: { authenticate },
      now: () => authenticatedAt,
    });

    await expect(
      useCase.execute({ accessCredential: `${tokenId}.${secret}`, requestId: "request-123" }),
    ).resolves.toEqual({ status: "authentication_required" });
  });
});
