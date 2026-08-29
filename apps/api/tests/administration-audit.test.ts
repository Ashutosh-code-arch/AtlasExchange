import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AdministrationAuditEventRecord,
  AdministrationAuditInvariantError,
  AdministrationAuthorizationError,
  parseCreateAdministrationAuditEventInput,
  RecordAdministrationAuditEvent,
  requireAdministrationAuthorization,
  type AdministrationAuditWriter,
  type CreateAdministrationAuditEventInput,
} from "../src/modules/administration/index.js";
import type { AuthenticatedContext } from "../src/modules/identity/index.js";

const actorUserId = randomUUID();
const actorSessionId = randomUUID();
const targetUserId = randomUUID();
const operationId = randomUUID();
const occurredAt = "2026-08-29T21:00:00.000Z";

function input(
  overrides: Readonly<Record<string, unknown>> = {},
): CreateAdministrationAuditEventInput {
  return {
    operationId,
    actorUserId,
    actorSessionId,
    action: "identity.user_suspended",
    targetUserId,
    reason: "Repeated abuse confirmed by manual review.",
    details: { previousState: "active", newState: "suspended" },
    requestId: "admin-request-001",
    occurredAt,
    ...overrides,
  };
}

function context(roles: AuthenticatedContext["authorization"]["roles"]): AuthenticatedContext {
  return {
    userId: actorUserId,
    sessionId: actorSessionId,
    authorization: { roles },
    requestId: "admin-request-001",
  };
}

describe("Administration authorization", () => {
  it("returns only the authenticated actor fields for an explicit admin permission", () => {
    expect(
      requireAdministrationAuthorization(
        context(["user", "admin"]),
        "administration.users.change_state",
      ),
    ).toEqual({ userId: actorUserId, sessionId: actorSessionId, requestId: "admin-request-001" });
  });

  it("denies ordinary users and unknown runtime permissions by default", () => {
    expect(() =>
      requireAdministrationAuthorization(context(["user"]), "administration.users.read"),
    ).toThrow(AdministrationAuthorizationError);
    expect(() =>
      requireAdministrationAuthorization(
        context(["user", "admin"]),
        "administration.everything" as "administration.users.read",
      ),
    ).toThrow(AdministrationAuthorizationError);
  });
});

describe("Administration audit domain", () => {
  it.each([
    ["identity.user_suspended", { previousState: "active", newState: "suspended" }],
    ["identity.user_reactivated", { previousState: "suspended", newState: "active" }],
    ["identity.admin_role_granted", { role: "admin" }],
    ["identity.admin_role_revoked", { role: "admin" }],
  ] as const)("accepts and freezes the typed %s fact", (action, details) => {
    const parsed = parseCreateAdministrationAuditEventInput(input({ action, details }));
    expect(parsed.action).toBe(action);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.details)).toBe(true);
  });

  it.each([
    [{ operationId: "invalid" }, "ADMINISTRATION_AUDIT_OPERATION_ID_INVALID"],
    [{ actorSessionId: "invalid" }, "ADMINISTRATION_AUDIT_ACTOR_INVALID"],
    [{ targetUserId: "invalid" }, "ADMINISTRATION_AUDIT_TARGET_INVALID"],
    [{ reason: " surrounded " }, "ADMINISTRATION_AUDIT_REASON_INVALID"],
    [{ requestId: "short" }, "ADMINISTRATION_AUDIT_REQUEST_ID_INVALID"],
    [{ occurredAt: "not-a-time" }, "ADMINISTRATION_AUDIT_OCCURRED_AT_INVALID"],
    [
      { details: { previousState: "suspended", newState: "active" } },
      "ADMINISTRATION_AUDIT_DETAILS_INVALID",
    ],
  ] as const)("rejects invalid audit input %#", (overrides, issue) => {
    expect(() => parseCreateAdministrationAuditEventInput(input(overrides))).toThrowError(
      expect.objectContaining<Partial<AdministrationAuditInvariantError>>({ issue }),
    );
  });

  it("restores an immutable record and validates generated fields", () => {
    const record = AdministrationAuditEventRecord.restore({
      ...input(),
      id: randomUUID(),
      createdAt: "2026-08-29T21:00:01.000Z",
    });
    expect(record).toMatchObject(input());
    expect(Object.isFrozen(record)).toBe(true);
    expect(() =>
      AdministrationAuditEventRecord.restore({
        ...input(),
        id: "invalid",
        createdAt: "2026-08-29T21:00:01.000Z",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AdministrationAuditInvariantError>>({
        issue: "ADMINISTRATION_AUDIT_ID_INVALID",
      }),
    );
  });

  it("validates before delegating to the audit writer", async () => {
    const event = AdministrationAuditEventRecord.restore({
      ...input(),
      id: randomUUID(),
      createdAt: "2026-08-29T21:00:01.000Z",
    });
    const appendOrGet = vi
      .fn<AdministrationAuditWriter["appendOrGet"]>()
      .mockResolvedValue({ status: "created", event });
    const recorder = new RecordAdministrationAuditEvent({ appendOrGet });

    await expect(recorder.execute(input())).resolves.toEqual({ status: "created", event });
    expect(appendOrGet).toHaveBeenCalledWith(input());
    await expect(recorder.execute({ ...input(), reason: "" })).rejects.toBeInstanceOf(
      AdministrationAuditInvariantError,
    );
    expect(appendOrGet).toHaveBeenCalledOnce();
  });
});
