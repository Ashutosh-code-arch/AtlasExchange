import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AdministrationAuditInvariantError,
  AdministrationAuthorizationError,
  ChangeAdministrationAdminRole,
  ChangeAdministrationUserState,
  GetAdministrationUser,
  InMemoryAdministrationRequestRateLimiter,
  type AdministrationUserCommandTransactionRunner,
} from "../src/modules/administration/index.js";
import type {
  AuthenticatedContext,
  IdentityAdministrationStore,
} from "../src/modules/identity/index.js";

const actorUserId = randomUUID();
const actorSessionId = randomUUID();
const targetUserId = randomUUID();
const operationId = randomUUID();
const now = new Date("2026-08-29T20:00:00.000Z");
const user = {
  id: targetUserId,
  email: "target@atlas.test",
  state: "active" as const,
  roles: ["user"] as const,
  createdAt: "2026-08-29T18:00:00.000Z",
};

function context(roles: AuthenticatedContext["authorization"]["roles"]): AuthenticatedContext {
  return {
    userId: actorUserId,
    sessionId: actorSessionId,
    authorization: { roles },
    requestId: "administration-unit-request",
  };
}

describe("Administration user management application", () => {
  it("authorizes reads and preserves absent users", async () => {
    const findUser = vi
      .fn<IdentityAdministrationStore["findUser"]>()
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce(undefined);
    const getUser = new GetAdministrationUser({ findUser });
    await expect(
      getUser.execute({ context: context(["user", "admin"]), userId: targetUserId }),
    ).resolves.toEqual({ status: "found", user });
    await expect(
      getUser.execute({ context: context(["user", "admin"]), userId: targetUserId }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      getUser.execute({ context: context(["user"]), userId: targetUserId }),
    ).rejects.toBeInstanceOf(AdministrationAuthorizationError);
  });

  it("validates and delegates exact state transition facts", async () => {
    const changeUserState = vi
      .fn<AdministrationUserCommandTransactionRunner["changeUserState"]>()
      .mockResolvedValue({ status: "changed", user: { ...user, state: "suspended" } });
    const useCase = new ChangeAdministrationUserState({ changeUserState }, { now: () => now });
    await expect(
      useCase.execute({
        context: context(["user", "admin"]),
        operationId,
        targetUserId,
        state: "suspended",
        reason: "Reviewed abuse report.",
      }),
    ).resolves.toMatchObject({ status: "changed" });
    expect(changeUserState).toHaveBeenCalledWith({
      actor: {
        userId: actorUserId,
        sessionId: actorSessionId,
        requestId: "administration-unit-request",
      },
      operationId,
      targetUserId,
      state: "suspended",
      reason: "Reviewed abuse report.",
      occurredAt: now.toISOString(),
    });
    await expect(
      useCase.execute({
        context: context(["user", "admin"]),
        operationId,
        targetUserId,
        state: "suspended",
        reason: " surrounded ",
      }),
    ).rejects.toBeInstanceOf(AdministrationAuditInvariantError);
  });

  it("forbids self-targeted state and role changes before transactions", async () => {
    const changeUserState = vi.fn<AdministrationUserCommandTransactionRunner["changeUserState"]>();
    const changeAdminRole = vi.fn<AdministrationUserCommandTransactionRunner["changeAdminRole"]>();
    const input = {
      context: context(["user", "admin"]),
      operationId,
      targetUserId: actorUserId,
      reason: "Must not execute.",
    };
    await expect(
      new ChangeAdministrationUserState({ changeUserState }).execute({
        ...input,
        state: "suspended",
      }),
    ).resolves.toEqual({ status: "self_target_forbidden" });
    await expect(
      new ChangeAdministrationAdminRole({ changeAdminRole }).execute({
        ...input,
        assigned: false,
      }),
    ).resolves.toEqual({ status: "self_target_forbidden" });
    expect(changeUserState).not.toHaveBeenCalled();
    expect(changeAdminRole).not.toHaveBeenCalled();
  });

  it("requires the role-management permission and delegates reviewed intent", async () => {
    const changeAdminRole = vi
      .fn<AdministrationUserCommandTransactionRunner["changeAdminRole"]>()
      .mockResolvedValue({ status: "changed", user: { ...user, roles: ["user", "admin"] } });
    const useCase = new ChangeAdministrationAdminRole({ changeAdminRole }, { now: () => now });
    await expect(
      useCase.execute({
        context: context(["user", "admin"]),
        operationId,
        targetUserId,
        assigned: true,
        reason: "Approved operational access.",
      }),
    ).resolves.toMatchObject({ status: "changed" });
    expect(changeAdminRole).toHaveBeenCalledWith(
      expect.objectContaining({ assigned: true, occurredAt: now.toISOString() }),
    );
    await expect(
      useCase.execute({
        context: context(["user"]),
        operationId,
        targetUserId,
        assigned: true,
        reason: "Approved operational access.",
      }),
    ).rejects.toBeInstanceOf(AdministrationAuthorizationError);
  });

  it("bounds request windows without retaining raw actor identifiers", () => {
    let milliseconds = 0;
    const limiter = new InMemoryAdministrationRequestRateLimiter({
      maximumRequests: 2,
      windowMilliseconds: 1_000,
      now: () => milliseconds,
    });
    expect(limiter.consume(actorUserId)).toEqual({ allowed: true });
    expect(limiter.consume(actorUserId)).toEqual({ allowed: true });
    expect(limiter.consume(actorUserId)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    milliseconds = 1_000;
    expect(limiter.consume(actorUserId)).toEqual({ allowed: true });
  });
});
