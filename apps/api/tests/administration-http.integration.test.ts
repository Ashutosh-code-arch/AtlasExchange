import { randomBytes } from "node:crypto";

import {
  administrationApiErrorResponseSchema,
  administrationUserResponseSchema,
} from "@atlas/contracts";
import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  createAdministrationModuleRouter,
  PostgresAdministrationUserCommandTransactionRunner,
  type AdministrationDatabaseSchema,
} from "../src/modules/administration/index.js";
import type { AuthenticateAccess, IdentityDatabaseSchema } from "../src/modules/identity/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

type TestSchema = AdministrationDatabaseSchema & IdentityDatabaseSchema;

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_administration_http_${process.pid}_${randomBytes(6).toString("hex")}`;
const actorUserId = "00000000-0000-4000-8000-000000000971";
const actorSessionId = "00000000-0000-4000-8000-000000000972";
const targetUserId = "00000000-0000-4000-8000-000000000973";
const targetSessionId = "00000000-0000-4000-8000-000000000974";
const pendingUserId = "00000000-0000-4000-8000-000000000975";
const csrfToken = "administration-integration-csrf";
const webOrigin = "http://localhost:5173";

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const integrationDatabaseUrl = databaseUrlFor(databaseName);
const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const fixturePool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
const database = new Kysely<TestSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 6 }),
  }),
});

const authenticateAccess: Pick<AuthenticateAccess, "execute"> = {
  execute: (command) =>
    Promise.resolve({
      status: "authenticated",
      context: {
        userId: actorUserId,
        sessionId: actorSessionId,
        authorization: { roles: ["user", "admin"] },
        requestId: command.requestId,
      },
      user: { email: "operator@atlas.test" },
    }),
};

const administrationRouter = createAdministrationModuleRouter({
  database,
  authenticateAccess,
  sessionCsrfTokenService: {
    issue: () => csrfToken,
    verify: (sessionId, token) => sessionId === actorSessionId && token === csrfToken,
  },
  secureCookies: false,
  webOrigin,
  now: () => new Date("2026-08-29T19:00:00.000Z"),
});
const app = createApp({
  lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
  logger: pino({ enabled: false }),
  webOrigin,
  administrationRouter,
});

function get(path: string): request.Test {
  return request(app).get(path).set("Cookie", "atlas_access=access-credential");
}

function patch(
  path: string,
  operationId: string,
  requestId = "administration-request-001",
): request.Test {
  return request(app)
    .patch(path)
    .set("origin", webOrigin)
    .set("x-csrf-token", csrfToken)
    .set("x-request-id", requestId)
    .set("idempotency-key", operationId)
    .set("Cookie", ["atlas_access=access-credential", `atlas_csrf=${csrfToken}`]);
}

describe("Administration HTTP with PostgreSQL", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    await fixturePool.query(
      `INSERT INTO identity.users (id, display_email, normalized_email, state)
       VALUES
         ($1, 'operator@atlas.test', 'operator@atlas.test', 'active'),
         ($2, 'target@atlas.test', 'target@atlas.test', 'active'),
         ($3, 'pending@atlas.test', 'pending@atlas.test', 'pending_verification')`,
      [actorUserId, targetUserId, pendingUserId],
    );
    await fixturePool.query(
      `INSERT INTO identity.user_roles (user_id, role_code, assigned_by_user_id)
       VALUES ($1, 'user', NULL), ($1, 'admin', $1), ($2, 'user', NULL), ($3, 'user', NULL)`,
      [actorUserId, targetUserId, pendingUserId],
    );
    await fixturePool.query(
      `INSERT INTO identity.sessions (id, user_id, absolute_expires_at)
       VALUES
         ($1, $2, '2027-08-29T19:00:00.000Z'),
         ($3, $4, '2027-08-29T19:00:00.000Z')`,
      [actorSessionId, actorUserId, targetSessionId, targetUserId],
    );
  });

  afterAll(async () => {
    await database.destroy();
    await fixturePool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("reads one user through Identity-owned persistence", async () => {
    const response = await get(`/api/v1/administration/users/${targetUserId}`);
    expect(response.status).toBe(200);
    const user = administrationUserResponseSchema.parse(response.body).data.user;
    expect(user).toMatchObject({
      id: targetUserId,
      email: "target@atlas.test",
      state: "active",
      roles: ["user"],
    });
    expect(user.createdAt).toEqual(expect.any(String));
    expect(JSON.stringify(response.body)).not.toContain("normalized_email");
  });

  it("atomically suspends, audits, revokes sessions, and preserves retry identity", async () => {
    const operationId = "00000000-0000-4000-8000-000000000976";
    const path = `/api/v1/administration/users/${targetUserId}/state`;
    const body = { state: "suspended", reason: "Abuse confirmed by manual review." };
    const response = await patch(path, operationId).send(body);
    expect(response.status).toBe(200);
    expect(administrationUserResponseSchema.parse(response.body).data.user.state).toBe("suspended");

    const persisted = await fixturePool.query<{
      state: string;
      revoked_at: Date | null;
      revocation_reason: string | null;
      action: string;
      actor_user_id: string;
      actor_session_id: string;
      target_user_id: string;
      reason: string;
      request_id: string;
    }>(
      `SELECT users.state, sessions.revoked_at, sessions.revocation_reason,
              audit.action, audit.actor_user_id, audit.actor_session_id,
              audit.target_user_id, audit.reason, audit.request_id
       FROM identity.users AS users
       JOIN identity.sessions AS sessions ON sessions.user_id = users.id
       JOIN administration.audit_events AS audit ON audit.target_user_id = users.id
       WHERE users.id = $1 AND audit.operation_id = $2`,
      [targetUserId, operationId],
    );
    expect(persisted.rows[0]).toMatchObject({
      state: "suspended",
      revocation_reason: "administration_user_suspended",
      action: "identity.user_suspended",
      actor_user_id: actorUserId,
      actor_session_id: actorSessionId,
      target_user_id: targetUserId,
      reason: body.reason,
      request_id: "administration-request-001",
    });
    expect(persisted.rows[0]?.revoked_at).not.toBeNull();

    const retry = await patch(path, operationId, "administration-request-002").send(body);
    expect(retry.status).toBe(200);
    const count = await fixturePool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM administration.audit_events WHERE operation_id = $1",
      [operationId],
    );
    expect(count.rows[0]?.count).toBe("1");

    const changedRetry = await patch(path, operationId, "administration-request-003").send({
      ...body,
      reason: "A different reviewed reason.",
    });
    expect(changedRetry.status).toBe(409);
    expect(administrationApiErrorResponseSchema.parse(changedRetry.body).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("reactivates the suspended target and records the inverse transition", async () => {
    const operationId = "00000000-0000-4000-8000-000000000977";
    const response = await patch(
      `/api/v1/administration/users/${targetUserId}/state`,
      operationId,
    ).send({ state: "active", reason: "Reactivation approved after review." });
    expect(response.status).toBe(200);
    expect(administrationUserResponseSchema.parse(response.body).data.user.state).toBe("active");
    const audit = await fixturePool.query<{ action: string; details: unknown }>(
      "SELECT action, details FROM administration.audit_events WHERE operation_id = $1",
      [operationId],
    );
    expect(audit.rows[0]).toEqual({
      action: "identity.user_reactivated",
      details: { previousState: "suspended", newState: "active" },
    });
  });

  it("grants and revokes admin while invalidating target sessions", async () => {
    await fixturePool.query(
      `INSERT INTO identity.sessions (user_id, absolute_expires_at)
       VALUES ($1, '2027-08-29T19:00:00.000Z')`,
      [targetUserId],
    );
    const path = `/api/v1/administration/users/${targetUserId}/roles/admin`;
    const grant = await patch(path, "00000000-0000-4000-8000-000000000978").send({
      assigned: true,
      reason: "Approved operational access.",
    });
    expect(grant.status).toBe(200);
    expect(administrationUserResponseSchema.parse(grant.body).data.user.roles).toEqual([
      "user",
      "admin",
    ]);

    const revoke = await patch(path, "00000000-0000-4000-8000-000000000979").send({
      assigned: false,
      reason: "Operational access is no longer required.",
    });
    expect(revoke.status).toBe(200);
    expect(administrationUserResponseSchema.parse(revoke.body).data.user.roles).toEqual(["user"]);

    const facts = await fixturePool.query<{ action: string }>(
      `SELECT action FROM administration.audit_events
       WHERE target_user_id = $1 AND action LIKE 'identity.admin_role_%'
       ORDER BY occurred_at, id`,
      [targetUserId],
    );
    expect(facts.rows).toEqual([
      { action: "identity.admin_role_granted" },
      { action: "identity.admin_role_revoked" },
    ]);
    const activeSessions = await fixturePool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM identity.sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [targetUserId],
    );
    expect(activeSessions.rows[0]?.count).toBe("0");
  });

  it("rejects self-targeting and invalid target state without side effects", async () => {
    const selfOperation = "00000000-0000-4000-8000-000000000980";
    const self = await patch(
      `/api/v1/administration/users/${actorUserId}/state`,
      selfOperation,
    ).send({ state: "suspended", reason: "Must not be accepted." });
    expect(self.status).toBe(409);
    expect(administrationApiErrorResponseSchema.parse(self.body).error.code).toBe(
      "ADMINISTRATION_SELF_TARGET_FORBIDDEN",
    );

    const pendingOperation = "00000000-0000-4000-8000-000000000981";
    const pending = await patch(
      `/api/v1/administration/users/${pendingUserId}/state`,
      pendingOperation,
    ).send({ state: "suspended", reason: "Unsupported source state." });
    expect(pending.status).toBe(409);
    expect(administrationApiErrorResponseSchema.parse(pending.body).error.code).toBe(
      "USER_STATE_CONFLICT",
    );
    const audit = await fixturePool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM administration.audit_events WHERE operation_id IN ($1, $2)",
      [selfOperation, pendingOperation],
    );
    expect(audit.rows[0]?.count).toBe("0");
  });

  it("rolls back the Identity mutation when audit attribution fails", async () => {
    const runner = new PostgresAdministrationUserCommandTransactionRunner(database);
    await expect(
      runner.changeUserState({
        actor: {
          userId: actorUserId,
          sessionId: "00000000-0000-4000-8000-000000000999",
          requestId: "administration-request-rollback",
        },
        operationId: "00000000-0000-4000-8000-000000000982",
        targetUserId,
        state: "suspended",
        reason: "This audit actor session does not exist.",
        occurredAt: "2026-08-29T19:05:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "23503" });
    const user = await fixturePool.query<{ state: string }>(
      "SELECT state FROM identity.users WHERE id = $1",
      [targetUserId],
    );
    expect(user.rows[0]?.state).toBe("active");
  });
});
