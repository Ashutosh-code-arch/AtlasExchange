import { randomBytes } from "node:crypto";

import {
  assetCatalogResponseSchema,
  simulatedDepositResponseSchema,
  simulatedWithdrawalResponseSchema,
  walletListResponseSchema,
  walletResponseSchema,
} from "@atlas/contracts";
import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  createAccessAuthentication,
  createIdentityModuleRouter,
  CryptoSessionCsrfTokenService,
  type IdentityDatabaseSchema,
} from "../src/modules/identity/index.js";
import {
  createFinancialModuleRouter,
  type FinancialDatabaseSchema,
} from "../src/modules/financial/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_financial_http_${process.pid}_${randomBytes(6).toString("hex")}`;
const webOrigin = "http://localhost:5173";
const csrfHmacKey = Buffer.alloc(32, 11).toString("base64url");

type AtlasHttpDatabaseSchema = IdentityDatabaseSchema & FinancialDatabaseSchema;

interface AuthenticatedBrowser {
  readonly userId: string;
  readonly accessCredential: string;
  readonly csrfToken: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function cookieValue(cookies: readonly string[], name: string): string {
  const cookie = cookies.find((candidate) => candidate.startsWith(`${name}=`));
  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`);
  }
  return decodeURIComponent(cookie.slice(name.length + 1, cookie.indexOf(";")));
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<AtlasHttpDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});
let app: ReturnType<typeof createApp>;
let firstBrowser: AuthenticatedBrowser;
let secondBrowser: AuthenticatedBrowser;

function accessCookies(browser: AuthenticatedBrowser): string[] {
  return [`atlas_access=${browser.accessCredential}`];
}

function mutationCookies(browser: AuthenticatedBrowser): string[] {
  return [`atlas_access=${browser.accessCredential}`, `atlas_csrf=${browser.csrfToken}`];
}

async function registerAndLogin(label: string): Promise<AuthenticatedBrowser> {
  const email = `${label}@example.com`;
  const password = `unique ${label} financial integration passphrase`;
  const registration = await request(app)
    .post("/api/v1/auth/register")
    .set("origin", webOrigin)
    .send({ email, password });
  expect(registration.status).toBe(202);

  const user = await database
    .selectFrom("identity.users")
    .select("id")
    .where("normalized_email", "=", email)
    .executeTakeFirstOrThrow();
  await database
    .updateTable("identity.users")
    .set({ state: "active", updated_at: new Date() })
    .where("id", "=", user.id)
    .execute();

  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("origin", webOrigin)
    .send({ email, password });
  expect(login.status).toBe(200);
  const cookies = login.headers["set-cookie"];
  if (!Array.isArray(cookies)) {
    throw new Error("Expected authentication cookies");
  }
  return {
    userId: user.id,
    accessCredential: cookieValue(cookies, "atlas_access"),
    csrfToken: cookieValue(cookies, "atlas_csrf"),
  };
}

describe("composed Financial HTTP flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    const authenticateAccess = createAccessAuthentication(database);
    const sessionCsrfTokenService = new CryptoSessionCsrfTokenService(csrfHmacKey);
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
      authenticateAccess,
      sessionCsrfTokenService,
    });
    const financialRouter = createFinancialModuleRouter({
      database,
      authenticateAccess,
      sessionCsrfTokenService,
      secureCookies: false,
      webOrigin,
      simulatedFundingEnabled: true,
      simulatedWithdrawalsEnabled: true,
    });
    app = createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin,
      identityRouter,
      financialRouter,
    });
    firstBrowser = await registerAndLogin("financial-owner-one");
    secondBrowser = await registerAndLogin("financial-owner-two");
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("serves the committed public catalog and explicit Financial preflight headers", async () => {
    const catalog = await request(app).get("/api/v1/assets");
    expect(catalog.status).toBe(200);
    expect(assetCatalogResponseSchema.parse(catalog.body).data.assets).toEqual([
      { code: "BTC", displayName: "Bitcoin", ledgerScale: 8, status: "active" },
      { code: "ETH", displayName: "Ethereum", ledgerScale: 18, status: "active" },
      { code: "USD", displayName: "US Dollar", ledgerScale: 2, status: "active" },
    ]);

    const preflight = await request(app)
      .options("/api/v1/deposits/simulated")
      .set("origin", webOrigin)
      .set("access-control-request-method", "POST")
      .set(
        "access-control-request-headers",
        "content-type,x-csrf-token,idempotency-key,x-request-id",
      );
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(webOrigin);
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers["access-control-allow-headers"]?.toLowerCase()).toContain(
      "idempotency-key",
    );
  });

  it("creates, reuses, funds, and reads only the authenticated owner's resources", async () => {
    const createdWallet = await request(app)
      .put("/api/v1/wallets/BTC")
      .set("origin", webOrigin)
      .set("x-csrf-token", firstBrowser.csrfToken)
      .set("Cookie", mutationCookies(firstBrowser));
    expect(createdWallet.status).toBe(201);
    const createdWalletBody = walletResponseSchema.parse(createdWallet.body);
    expect(createdWalletBody.data.wallet).toMatchObject({
      assetCode: "BTC",
      available: "0",
      reserved: "0",
      total: "0",
    });
    const walletId = createdWalletBody.data.wallet.id;

    const reusedWallet = await request(app)
      .put("/api/v1/wallets/BTC")
      .set("origin", webOrigin)
      .set("x-csrf-token", firstBrowser.csrfToken)
      .set("Cookie", mutationCookies(firstBrowser));
    expect(reusedWallet.status).toBe(200);
    expect(walletResponseSchema.parse(reusedWallet.body).data.wallet.id).toBe(walletId);

    const createDeposit = (): request.Test =>
      request(app)
        .post("/api/v1/deposits/simulated")
        .set("origin", webOrigin)
        .set("x-csrf-token", firstBrowser.csrfToken)
        .set("idempotency-key", "financial-http-deposit-1")
        .set("Cookie", mutationCookies(firstBrowser))
        .send({ assetCode: "BTC", amount: "1.25" });
    const createdDeposit = await createDeposit();
    const replayedDeposit = await createDeposit();
    expect(createdDeposit.status).toBe(201);
    expect(replayedDeposit.status).toBe(200);
    const createdDepositBody = simulatedDepositResponseSchema.parse(createdDeposit.body);
    expect(simulatedDepositResponseSchema.parse(replayedDeposit.body)).toEqual(createdDepositBody);
    const depositId = createdDepositBody.data.deposit.id;

    const wallet = await request(app)
      .get("/api/v1/wallets/BTC")
      .set("Cookie", accessCookies(firstBrowser));
    const wallets = await request(app)
      .get("/api/v1/wallets")
      .set("Cookie", accessCookies(firstBrowser));
    const deposit = await request(app)
      .get(`/api/v1/deposits/${depositId}`)
      .set("Cookie", accessCookies(firstBrowser));
    expect(wallet.status).toBe(200);
    const walletBody = walletResponseSchema.parse(wallet.body);
    expect(walletBody.data.wallet).toMatchObject({
      id: walletId,
      available: "1.25",
      reserved: "0",
      total: "1.25",
    });
    expect(walletListResponseSchema.parse(wallets.body).data.wallets).toEqual([
      walletBody.data.wallet,
    ]);
    expect(simulatedDepositResponseSchema.parse(deposit.body)).toEqual(createdDepositBody);

    const persisted = await database
      .selectFrom("financial.deposits")
      .select(["owner_id", "wallet_id", "amount"])
      .where("id", "=", depositId)
      .executeTakeFirstOrThrow();
    expect(persisted).toEqual({
      owner_id: firstBrowser.userId,
      wallet_id: walletId,
      amount: "125000000",
    });
  });

  it("atomically withdraws available value, replays safely, and conceals ownership", async () => {
    const createdWallet = await request(app)
      .put("/api/v1/wallets/ETH")
      .set("origin", webOrigin)
      .set("x-csrf-token", firstBrowser.csrfToken)
      .set("Cookie", mutationCookies(firstBrowser));
    expect(createdWallet.status).toBe(201);
    const walletId = walletResponseSchema.parse(createdWallet.body).data.wallet.id;

    const funding = await request(app)
      .post("/api/v1/deposits/simulated")
      .set("origin", webOrigin)
      .set("x-csrf-token", firstBrowser.csrfToken)
      .set("idempotency-key", "financial-http-withdrawal-funding-1")
      .set("Cookie", mutationCookies(firstBrowser))
      .send({ assetCode: "ETH", amount: "2" });
    expect(funding.status).toBe(201);

    const createWithdrawal = (): request.Test =>
      request(app)
        .post("/api/v1/withdrawals/simulated")
        .set("origin", webOrigin)
        .set("x-csrf-token", firstBrowser.csrfToken)
        .set("idempotency-key", "financial-http-withdrawal-1")
        .set("Cookie", mutationCookies(firstBrowser))
        .send({ assetCode: "ETH", amount: "0.75" });
    const created = await createWithdrawal();
    const replayed = await createWithdrawal();
    expect(created.status).toBe(201);
    expect(replayed.status).toBe(200);
    expect(created.headers["cache-control"]).toBe("no-store");
    const createdBody = simulatedWithdrawalResponseSchema.parse(created.body);
    expect(simulatedWithdrawalResponseSchema.parse(replayed.body)).toEqual(createdBody);
    const withdrawalId = createdBody.data.withdrawal.id;
    expect(created.headers.location).toBe(`/api/v1/withdrawals/${withdrawalId}`);
    expect(createdBody.data.withdrawal).toEqual({
      id: withdrawalId,
      walletId,
      assetCode: "ETH",
      amount: "0.75",
      method: "simulated",
      status: "completed",
      completedAt: createdBody.data.withdrawal.completedAt,
    });
    expect(JSON.stringify(createdBody)).not.toMatch(
      /journal|posting|intentHash|owner|custody|destination|address|network|fee/i,
    );

    const lookup = await request(app)
      .get(`/api/v1/withdrawals/${withdrawalId}`)
      .set("Cookie", accessCookies(firstBrowser));
    const concealed = await request(app)
      .get(`/api/v1/withdrawals/${withdrawalId}`)
      .set("Cookie", accessCookies(secondBrowser));
    expect(lookup.status).toBe(200);
    expect(simulatedWithdrawalResponseSchema.parse(lookup.body)).toEqual(createdBody);
    expect(concealed.status).toBe(404);
    expect(concealed.body).toMatchObject({ error: { code: "WITHDRAWAL_NOT_FOUND" } });

    const persisted = await database
      .selectFrom("financial.withdrawals")
      .select(["owner_id", "wallet_id", "amount", "journal_id"])
      .where("id", "=", withdrawalId)
      .executeTakeFirstOrThrow();
    expect(persisted).toMatchObject({
      owner_id: firstBrowser.userId,
      wallet_id: walletId,
      amount: "750000000000000000",
    });
    const postings = await database
      .selectFrom("financial.journal_postings as posting")
      .innerJoin("financial.ledger_accounts as account", "account.id", "posting.account_id")
      .select(["posting.direction", "posting.amount", "account.kind"])
      .where("posting.journal_id", "=", persisted.journal_id)
      .orderBy("posting.position")
      .execute();
    expect(postings).toEqual([
      { direction: "debit", amount: "750000000000000000", kind: "user_available" },
      { direction: "credit", amount: "750000000000000000", kind: "external_custody" },
    ]);

    const walletAfterWithdrawal = await request(app)
      .get("/api/v1/wallets/ETH")
      .set("Cookie", accessCookies(firstBrowser));
    expect(walletResponseSchema.parse(walletAfterWithdrawal.body).data.wallet).toMatchObject({
      id: walletId,
      available: "1.25",
      reserved: "0",
      total: "1.25",
    });

    const insufficient = await request(app)
      .post("/api/v1/withdrawals/simulated")
      .set("origin", webOrigin)
      .set("x-csrf-token", firstBrowser.csrfToken)
      .set("idempotency-key", "financial-http-withdrawal-insufficient-1")
      .set("Cookie", mutationCookies(firstBrowser))
      .send({ assetCode: "ETH", amount: "2" });
    expect(insufficient.status).toBe(409);
    expect(insufficient.body).toMatchObject({
      error: { code: "INSUFFICIENT_AVAILABLE_BALANCE" },
    });
    expect(JSON.stringify(insufficient.body)).not.toMatch(/reserved|requested|amount/i);

    const withdrawals = await database
      .selectFrom("financial.withdrawals")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", firstBrowser.userId)
      .where("asset_code", "=", "ETH")
      .executeTakeFirstOrThrow();
    expect(withdrawals.count).toBe("1");
    const walletAfterRejection = await request(app)
      .get("/api/v1/wallets/ETH")
      .set("Cookie", accessCookies(firstBrowser));
    expect(walletResponseSchema.parse(walletAfterRejection.body).data.wallet).toMatchObject({
      available: "1.25",
      reserved: "0",
      total: "1.25",
    });
  });

  it("rejects cross-session CSRF and conceals another owner's wallet and deposit", async () => {
    const mismatchedCsrf = await request(app)
      .put("/api/v1/wallets/ETH")
      .set("origin", webOrigin)
      .set("x-csrf-token", secondBrowser.csrfToken)
      .set("Cookie", [
        `atlas_access=${firstBrowser.accessCredential}`,
        `atlas_csrf=${secondBrowser.csrfToken}`,
      ]);
    expect(mismatchedCsrf.status).toBe(403);

    const firstDeposit = await database
      .selectFrom("financial.deposits")
      .select("id")
      .where("owner_id", "=", firstBrowser.userId)
      .executeTakeFirstOrThrow();
    const secondWallets = await request(app)
      .get("/api/v1/wallets")
      .set("Cookie", accessCookies(secondBrowser));
    const concealedDeposit = await request(app)
      .get(`/api/v1/deposits/${firstDeposit.id}`)
      .set("Cookie", accessCookies(secondBrowser));
    expect(secondWallets.status).toBe(200);
    expect(walletListResponseSchema.parse(secondWallets.body).data.wallets).toEqual([]);
    expect(concealedDeposit.status).toBe(404);
    expect(concealedDeposit.body).toMatchObject({ error: { code: "DEPOSIT_NOT_FOUND" } });
  });
});
