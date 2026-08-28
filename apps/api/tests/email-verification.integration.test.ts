import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import {
  createIdentityModuleRouter,
  type IdentityDatabaseSchema,
} from "../src/modules/identity/index.js";
import { PostgresRegistrationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-registration-transaction-runner.js";
import { CryptoVerificationSecretGenerator } from "../src/modules/identity/infrastructure/security/crypto-verification-secret-generator.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_email_verification_${process.pid}_${randomBytes(6).toString("hex")}`;
const webOrigin = "http://localhost:5173";
const csrfHmacKey = Buffer.alloc(32, 7).toString("base64url");

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<IdentityDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 6 }),
  }),
});
const registrationRunner = new PostgresRegistrationTransactionRunner(database);
const verificationSecretGenerator = new CryptoVerificationSecretGenerator();
let app: ReturnType<typeof createApp>;
let emailSequence = 0;

interface PendingVerification {
  readonly credential: string;
  readonly tokenId: string;
  readonly userId: string;
}

async function createPendingVerification(expiresAt: Date): Promise<PendingVerification> {
  emailSequence += 1;
  const email = `verify-${emailSequence}@example.com`;
  const verificationSecret = verificationSecretGenerator.generate();
  const registeredAt = new Date(expiresAt.getTime() - 24 * 60 * 60 * 1_000);
  const result = await registrationRunner.execute((transaction) =>
    transaction.createPasswordRegistration({
      displayEmail: email,
      normalizedEmail: email as NormalizedEmail,
      passwordHash: "$argon2id$integration-hash",
      verificationSecretDigest: verificationSecret.digest,
      registeredAt,
      verificationExpiresAt: expiresAt,
    }),
  );
  if (result.status !== "created") {
    throw new Error("Pending verification fixture was not created");
  }
  return {
    credential: `${result.verificationTokenId}.${verificationSecret.secret}`,
    tokenId: result.verificationTokenId,
    userId: result.userId,
  };
}

function verifyEmail(token: string, requestId: string): request.Test {
  return request(app)
    .post("/api/v1/auth/verify-email")
    .set("origin", webOrigin)
    .set("x-request-id", requestId)
    .send({ token });
}

describe("PostgreSQL email verification", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    const identityRouter = await createIdentityModuleRouter({
      database,
      passwordBlocklistPath: new URL(
        "../resources/development-password-blocklist.sha256",
        import.meta.url,
      ).pathname,
      verificationEmailDelivery: {
        deliver: () => Promise.resolve({ status: "delivered" }),
      },
      passwordResetEmailDelivery: {
        deliver: () => Promise.resolve({ status: "delivered" }),
      },
      sessionSecurity: { secureCookies: false, csrfHmacKey },
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
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("does not mutate an account when the verification secret is wrong", async () => {
    const pending = await createPendingVerification(new Date(Date.now() + 60_000));
    const response = await verifyEmail(
      `${pending.tokenId}.${"x".repeat(43)}`,
      "wrong-verification-secret",
    );

    expect(response.status).toBe(400);
    const user = await database
      .selectFrom("identity.users")
      .select("state")
      .where("id", "=", pending.userId)
      .executeTakeFirstOrThrow();
    const token = await database
      .selectFrom("identity.email_verification_tokens")
      .select("consumed_at")
      .where("id", "=", pending.tokenId)
      .executeTakeFirstOrThrow();
    expect(user.state).toBe("pending_verification");
    expect(token.consumed_at).toBeNull();
  });

  it("does not consume an expired verification capability", async () => {
    const pending = await createPendingVerification(new Date(Date.now() - 1_000));
    const response = await verifyEmail(pending.credential, "expired-verification-token");

    expect(response.status).toBe(400);
    const token = await database
      .selectFrom("identity.email_verification_tokens")
      .select("consumed_at")
      .where("id", "=", pending.tokenId)
      .executeTakeFirstOrThrow();
    expect(token.consumed_at).toBeNull();
  });

  it("allows only one concurrent verifier to activate the account and record the event", async () => {
    const pending = await createPendingVerification(new Date(Date.now() + 60_000));
    const responses = await Promise.all([
      verifyEmail(pending.credential, "concurrent-verifier-one"),
      verifyEmail(pending.credential, "concurrent-verifier-two"),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([204, 400]);
    const user = await database
      .selectFrom("identity.users")
      .select("state")
      .where("id", "=", pending.userId)
      .executeTakeFirstOrThrow();
    const token = await database
      .selectFrom("identity.email_verification_tokens")
      .select("consumed_at")
      .where("id", "=", pending.tokenId)
      .executeTakeFirstOrThrow();
    const events = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "request_id"])
      .where("target_user_id", "=", pending.userId)
      .execute();

    expect(user.state).toBe("active");
    expect(token.consumed_at).toBeInstanceOf(Date);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "identity.email_verified" });
    expect(["concurrent-verifier-one", "concurrent-verifier-two"]).toContain(events[0]?.request_id);
  });
});
