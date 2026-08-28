import { randomBytes, randomUUID } from "node:crypto";

import { portfolioSnapshotResponseSchema } from "@atlas/contracts";
import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import {
  createPortfolioModuleRouter,
  type PortfolioDatabaseSchema,
} from "../src/modules/portfolio/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_portfolio_http_${process.pid}_${randomBytes(6).toString("hex")}`;
const firstOwnerId = "00000000-0000-4000-8000-000000000811";
const secondOwnerId = "00000000-0000-4000-8000-000000000812";

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const integrationDatabaseUrl = databaseUrlFor(databaseName);
const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const fixturePool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
const database = new Kysely<PortfolioDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 4 }),
  }),
});

const authenticateAccess: Pick<AuthenticateAccess, "execute"> = {
  execute: ({ accessCredential, requestId }) => {
    const ownerId =
      accessCredential === "first-access"
        ? firstOwnerId
        : accessCredential === "second-access"
          ? secondOwnerId
          : undefined;
    return Promise.resolve(
      ownerId === undefined
        ? { status: "authentication_required" }
        : {
            status: "authenticated",
            context: {
              userId: ownerId,
              sessionId: "00000000-0000-4000-8000-000000000813",
              authorization: { roles: ["user"] },
              requestId,
            },
            user: { email: `${ownerId}@atlas.test` },
          },
    );
  },
};

const portfolioRouter = createPortfolioModuleRouter({
  database,
  authenticateAccess,
  secureCookies: false,
  now: () => new Date("2026-08-28T16:00:00.000Z"),
});
const app = createApp({
  lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
  logger: pino({ enabled: false }),
  webOrigin: "http://localhost:5173",
  portfolioRouter,
});

async function createWallet(ownerId: string, assetCode: "BTC" | "USD"): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const wallet = await transaction
      .insertInto("financial.wallets")
      .values({ owner_id: ownerId, asset_code: assetCode })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("financial.ledger_accounts")
      .values([
        { asset_code: assetCode, kind: "user_available", wallet_id: wallet.id },
        { asset_code: assetCode, kind: "user_reserved", wallet_id: wallet.id },
      ])
      .execute();
  });
}

async function fund(ownerId: string, assetCode: "BTC" | "USD", amount: bigint): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const accounts = await transaction
      .selectFrom("financial.ledger_accounts as account")
      .leftJoin("financial.wallets as wallet", "wallet.id", "account.wallet_id")
      .select(["account.id", "account.kind"])
      .where("account.asset_code", "=", assetCode)
      .where((expression) =>
        expression.or([
          expression("account.kind", "=", "external_custody"),
          expression.and([
            expression("account.kind", "=", "user_available"),
            expression("wallet.owner_id", "=", ownerId),
          ]),
        ]),
      )
      .execute();
    const custodyId = accounts.find(({ kind }) => kind === "external_custody")?.id;
    const availableId = accounts.find(({ kind }) => kind === "user_available")?.id;
    if (custodyId === undefined || availableId === undefined) {
      throw new Error("Portfolio funding accounts were not found.");
    }
    const journal = await transaction
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: "test_portfolio_credit",
        idempotency_scope: `test.portfolio.${randomUUID()}`,
        idempotency_key: randomUUID(),
        intent_hash: "d".repeat(64),
        business_references: {},
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("financial.journal_postings")
      .values([
        {
          journal_id: journal.id,
          position: 1,
          account_id: custodyId,
          asset_code: assetCode,
          direction: "debit",
          amount: amount.toString(),
        },
        {
          journal_id: journal.id,
          position: 2,
          account_id: availableId,
          asset_code: assetCode,
          direction: "credit",
          amount: amount.toString(),
        },
      ])
      .execute();
  });
}

function authenticatedGet(credential: "first-access" | "second-access"): request.Test {
  return request(app).get("/api/v1/portfolio").set("Cookie", `atlas_access=${credential}`);
}

describe("composed Portfolio HTTP flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    await createWallet(firstOwnerId, "BTC");
    await createWallet(firstOwnerId, "USD");
    await createWallet(secondOwnerId, "USD");
    await fund(firstOwnerId, "BTC", 50_000_000n);
    await fund(firstOwnerId, "USD", 3_500_000n);
    await fund(secondOwnerId, "USD", 10_000n);

    const tickerGeneration = await fixturePool.query<{ id: string }>(
      `SELECT id FROM market_data.projection_generations
       WHERE projection_name = 'trade_ticker' AND status = 'active'`,
    );
    const generationId = tickerGeneration.rows[0]?.id;
    if (generationId === undefined) throw new Error("Active ticker generation was not found.");
    await fixturePool.query(
      `INSERT INTO market_data.projection_checkpoints (
         generation_id, market_code, last_sequence, last_occurred_at
       ) VALUES ($1, 'BTC-USD', 4, '2026-08-28T15:59:00.000Z')`,
      [generationId],
    );
    await fixturePool.query(
      `INSERT INTO market_data.ticker_trades (
         generation_id, market_code, trade_id, market_sequence, execution_sequence,
         price_ticks, quantity_lots, executed_at
       ) VALUES ($1, 'BTC-USD', $2, 4, 1, 5000, 1, '2026-08-28T15:59:00.000Z')`,
      [generationId, randomUUID()],
    );
    await fixturePool.query(
      "UPDATE trading.market_publication_sequences SET last_sequence = 4 WHERE market_code = 'BTC-USD'",
    );
  });

  afterAll(async () => {
    await database.destroy();
    await fixturePool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("composes exact owner balances and committed ticker valuation from PostgreSQL", async () => {
    const response = await authenticatedGet("first-access");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(portfolioSnapshotResponseSchema.parse(response.body).data).toEqual({
      valuationCurrency: "USD",
      generatedAt: "2026-08-28T16:00:00.000Z",
      positions: [
        {
          assetCode: "BTC",
          displayName: "Bitcoin",
          available: "0.5",
          reserved: "0",
          total: "0.5",
          valuation: {
            status: "valued",
            marketCode: "BTC-USD",
            referencePrice: "50000",
            referencePriceAsOf: "2026-08-28T15:59:00.000Z",
            freshness: "current",
            value: "25000",
          },
        },
        {
          assetCode: "USD",
          displayName: "US Dollar",
          available: "35000",
          reserved: "0",
          total: "35000",
          valuation: {
            status: "cash",
            marketCode: null,
            referencePrice: "1",
            referencePriceAsOf: null,
            freshness: "current",
            value: "35000",
          },
        },
      ],
      summary: { totalValue: "60000", unpricedAssetCodes: [], complete: true },
    });
  });

  it("isolates portfolios by authenticated owner", async () => {
    const response = await authenticatedGet("second-access");
    expect(response.status).toBe(200);
    const snapshot = portfolioSnapshotResponseSchema.parse(response.body).data;
    expect(snapshot.positions).toEqual([
      {
        assetCode: "USD",
        displayName: "US Dollar",
        available: "100",
        reserved: "0",
        total: "100",
        valuation: {
          status: "cash",
          marketCode: null,
          referencePrice: "1",
          referencePriceAsOf: null,
          freshness: "current",
          value: "100",
        },
      },
    ]);
    expect(snapshot.summary).toEqual({
      totalValue: "100",
      unpricedAssetCodes: [],
      complete: true,
    });
  });

  it("rejects an unauthenticated portfolio read", async () => {
    await request(app).get("/api/v1/portfolio").expect(401);
  });
});
