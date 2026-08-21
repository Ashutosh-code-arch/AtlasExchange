import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  createIdentityModuleRouter,
  type IdentityDatabaseSchema,
} from "../src/modules/identity/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_registration_http_${process.pid}_${randomBytes(6).toString("hex")}`;
const webOrigin = "http://localhost:5173";

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<IdentityDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 4 }),
  }),
});
let app: ReturnType<typeof createApp>;

describe("composed registration HTTP flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    const identityRouter = await createIdentityModuleRouter({
      database,
      passwordBlocklistPath: new URL(
        "../resources/development-password-blocklist.sha256",
        import.meta.url,
      ).pathname,
      webOrigin,
    });
    app = createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin,
      identityRouter,
    });
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("rejects a locally blocked password without creating an account", async () => {
    const response = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send({
        email: "blocked@example.com",
        password: "correct horse battery staple",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    const user = await database
      .selectFrom("identity.users")
      .select("id")
      .where("normalized_email", "=", "blocked@example.com")
      .executeTakeFirst();
    expect(user).toBeUndefined();
  });

  it("creates the complete registration and keeps duplicate responses indistinguishable", async () => {
    const registration = {
      email: "  Composed@Example.COM  ",
      password: "unique atlas integration passphrase",
    };
    const createdResponse = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send(registration);
    const duplicateResponse = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send(registration);

    expect(createdResponse.status).toBe(202);
    expect(duplicateResponse.status).toBe(202);
    expect(createdResponse.body).toEqual({ success: true, data: {} });
    expect(duplicateResponse.body).toEqual(createdResponse.body);

    const users = await database
      .selectFrom("identity.users")
      .innerJoin(
        "identity.password_credentials",
        "identity.password_credentials.user_id",
        "identity.users.id",
      )
      .innerJoin("identity.user_roles", "identity.user_roles.user_id", "identity.users.id")
      .innerJoin(
        "identity.email_verification_tokens",
        "identity.email_verification_tokens.user_id",
        "identity.users.id",
      )
      .select([
        "identity.users.display_email",
        "identity.users.state",
        "identity.user_roles.role_code",
      ])
      .where("identity.users.normalized_email", "=", "composed@example.com")
      .execute();

    expect(users).toEqual([
      {
        display_email: "Composed@Example.COM",
        state: "pending_verification",
        role_code: "user",
      },
    ]);
  });
});
