import {
  administrationApiErrorResponseSchema,
  administrationUserResponseSchema,
} from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  createAdministrationRouter,
  type AdministrationRequestRateLimiter,
  type ChangeAdministrationAdminRole,
  type ChangeAdministrationUserState,
  type GetAdministrationUser,
} from "../src/modules/administration/index.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const webOrigin = "http://localhost:5173";
const actorUserId = "00000000-0000-4000-8000-000000000961";
const actorSessionId = "00000000-0000-4000-8000-000000000962";
const targetUserId = "00000000-0000-4000-8000-000000000963";
const operationId = "00000000-0000-4000-8000-000000000964";
const csrfToken = "administration-csrf-token";
const target = {
  id: targetUserId,
  email: "target@atlas.test",
  state: "active" as const,
  roles: ["user"] as const,
  createdAt: "2026-08-29T18:00:00.000Z",
};

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly getUser: ReturnType<typeof vi.fn<GetAdministrationUser["execute"]>>;
  readonly changeState: ReturnType<typeof vi.fn<ChangeAdministrationUserState["execute"]>>;
  readonly changeRole: ReturnType<typeof vi.fn<ChangeAdministrationAdminRole["execute"]>>;
  readonly consumeRead: ReturnType<typeof vi.fn<AdministrationRequestRateLimiter["consume"]>>;
  readonly consumeMutation: ReturnType<typeof vi.fn<AdministrationRequestRateLimiter["consume"]>>;
  readonly verifyCsrf: ReturnType<typeof vi.fn<(sessionId: string, token: string) => boolean>>;
}

function createHarness(
  options: {
    readonly authenticated?: boolean;
    readonly admin?: boolean;
    readonly csrfValid?: boolean;
  } = {},
): Harness {
  const authenticate = vi.fn<AuthenticateAccess["execute"]>().mockResolvedValue(
    options.authenticated === false
      ? { status: "authentication_required" }
      : {
          status: "authenticated",
          context: {
            userId: actorUserId,
            sessionId: actorSessionId,
            authorization: { roles: options.admin === false ? ["user"] : ["user", "admin"] },
            requestId: "administration-http-request",
          },
          user: { email: "operator@atlas.test" },
        },
  );
  const getUser = vi
    .fn<GetAdministrationUser["execute"]>()
    .mockResolvedValue({ status: "found", user: target });
  const changeState = vi
    .fn<ChangeAdministrationUserState["execute"]>()
    .mockResolvedValue({ status: "changed", user: { ...target, state: "suspended" } });
  const changeRole = vi
    .fn<ChangeAdministrationAdminRole["execute"]>()
    .mockResolvedValue({ status: "changed", user: { ...target, roles: ["user", "admin"] } });
  const consumeRead = vi
    .fn<AdministrationRequestRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const consumeMutation = vi
    .fn<AdministrationRequestRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const verifyCsrf = vi
    .fn<(sessionId: string, token: string) => boolean>()
    .mockReturnValue(options.csrfValid ?? true);
  const administrationRouter = createAdministrationRouter({
    authenticateAccess: { execute: authenticate },
    sessionCsrfTokenService: { issue: () => csrfToken, verify: verifyCsrf },
    secureCookies: false,
    webOrigin,
    getUser: { execute: getUser },
    changeUserState: { execute: changeState },
    changeAdminRole: { execute: changeRole },
    readRateLimiter: { consume: consumeRead },
    mutationRateLimiter: { consume: consumeMutation },
  });
  return {
    app: createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin,
      administrationRouter,
    }),
    getUser,
    changeState,
    changeRole,
    consumeRead,
    consumeMutation,
    verifyCsrf,
  };
}

function authenticatedGet(app: ReturnType<typeof createApp>, path: string): request.Test {
  return request(app).get(path).set("Cookie", "atlas_access=access-credential");
}

function authenticatedPatch(app: ReturnType<typeof createApp>, path: string): request.Test {
  return request(app)
    .patch(path)
    .set("origin", webOrigin)
    .set("x-csrf-token", csrfToken)
    .set("idempotency-key", operationId)
    .set("Cookie", ["atlas_access=access-credential", `atlas_csrf=${csrfToken}`]);
}

describe("Administration HTTP", () => {
  it("returns one admin-authorized user without persistence details", async () => {
    const harness = createHarness();
    const response = await authenticatedGet(
      harness.app,
      `/api/v1/administration/users/${targetUserId}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(administrationUserResponseSchema.parse(response.body).data.user).toEqual(target);
    expect(harness.consumeRead).toHaveBeenCalledWith(actorUserId);
    const getUserInput = harness.getUser.mock.calls[0]?.[0];
    expect(getUserInput?.context.userId).toBe(actorUserId);
    expect(getUserInput?.userId).toBe(targetUserId);
  });

  it("authenticates and authorizes before validation or limiting", async () => {
    const unauthenticated = createHarness({ authenticated: false });
    const missing = await request(unauthenticated.app).get(
      "/api/v1/administration/users/invalid?private=true",
    );
    expect(missing.status).toBe(401);
    expect(administrationApiErrorResponseSchema.parse(missing.body).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(unauthenticated.consumeRead).not.toHaveBeenCalled();

    const ordinary = createHarness({ admin: false });
    const forbidden = await authenticatedGet(
      ordinary.app,
      "/api/v1/administration/users/invalid?private=true",
    );
    expect(forbidden.status).toBe(403);
    expect(administrationApiErrorResponseSchema.parse(forbidden.body).error.code).toBe(
      "ADMINISTRATION_FORBIDDEN",
    );
    expect(ordinary.consumeRead).not.toHaveBeenCalled();
  });

  it("validates lookup shape and bounds reads", async () => {
    for (const path of [
      "/api/v1/administration/users/invalid",
      `/api/v1/administration/users/${targetUserId}?email=private`,
    ]) {
      const harness = createHarness();
      const response = await authenticatedGet(harness.app, path);
      expect(response.status).toBe(400);
      expect(harness.consumeRead).not.toHaveBeenCalled();
    }
    const limited = createHarness();
    limited.consumeRead.mockReturnValue({ allowed: false, retryAfterSeconds: 11 });
    const response = await authenticatedGet(
      limited.app,
      `/api/v1/administration/users/${targetUserId}`,
    );
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("11");
    expect(limited.getUser).not.toHaveBeenCalled();
  });

  it("requires session CSRF and strict idempotent state input", async () => {
    const badCsrf = createHarness({ csrfValid: false });
    const rejected = await authenticatedPatch(
      badCsrf.app,
      `/api/v1/administration/users/${targetUserId}/state`,
    ).send({ state: "suspended", reason: "Reviewed abuse." });
    expect(rejected.status).toBe(403);
    expect(badCsrf.changeState).not.toHaveBeenCalled();

    const harness = createHarness();
    const response = await authenticatedPatch(
      harness.app,
      `/api/v1/administration/users/${targetUserId}/state`,
    ).send({ state: "suspended", reason: "Reviewed abuse." });
    expect(response.status).toBe(200);
    expect(administrationUserResponseSchema.parse(response.body).data.user.state).toBe("suspended");
    const stateInput = harness.changeState.mock.calls[0]?.[0];
    expect(stateInput).toMatchObject({
      operationId,
      targetUserId,
      state: "suspended",
      reason: "Reviewed abuse.",
    });
    expect(stateInput?.context.userId).toBe(actorUserId);

    const invalid = createHarness();
    const invalidResponse = await authenticatedPatch(
      invalid.app,
      `/api/v1/administration/users/${targetUserId}/state`,
    )
      .set("idempotency-key", "invalid")
      .send({ state: "disabled", reason: "Unsupported." });
    expect(invalidResponse.status).toBe(400);
    expect(invalid.consumeMutation).not.toHaveBeenCalled();
  });

  it("changes admin assignment through the same guarded mutation boundary", async () => {
    const harness = createHarness();
    const response = await authenticatedPatch(
      harness.app,
      `/api/v1/administration/users/${targetUserId}/roles/admin`,
    ).send({ assigned: true, reason: "Approved operational access." });

    expect(response.status).toBe(200);
    expect(administrationUserResponseSchema.parse(response.body).data.user.roles).toEqual([
      "user",
      "admin",
    ]);
    const roleInput = harness.changeRole.mock.calls[0]?.[0];
    expect(roleInput).toMatchObject({
      operationId,
      targetUserId,
      assigned: true,
      reason: "Approved operational access.",
    });
    expect(roleInput?.context.userId).toBe(actorUserId);
  });

  it.each([
    ["self_target_forbidden", "ADMINISTRATION_SELF_TARGET_FORBIDDEN"],
    ["state_conflict", "USER_STATE_CONFLICT"],
    ["idempotency_conflict", "IDEMPOTENCY_CONFLICT"],
    ["not_found", "USER_NOT_FOUND"],
  ] as const)("maps %s without exposing internals", async (status, code) => {
    const harness = createHarness();
    harness.changeState.mockResolvedValue({ status });
    const response = await authenticatedPatch(
      harness.app,
      `/api/v1/administration/users/${targetUserId}/state`,
    ).send({ state: "suspended", reason: "Reviewed abuse." });
    expect(response.status).toBe(status === "not_found" ? 404 : 409);
    expect(administrationApiErrorResponseSchema.parse(response.body).error.code).toBe(code);
  });

  it("rejects malformed application output through generic containment", async () => {
    const harness = createHarness();
    harness.getUser.mockResolvedValue({
      status: "found",
      user: { ...target, email: "not-an-email" },
    });
    const response = await authenticatedGet(
      harness.app,
      `/api/v1/administration/users/${targetUserId}`,
    );
    expect(response.status).toBe(500);
    expect(administrationApiErrorResponseSchema.parse(response.body).error.code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(JSON.stringify(response.body)).not.toContain("not-an-email");
  });
});
