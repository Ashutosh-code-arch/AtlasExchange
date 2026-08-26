import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FinancialTradingFunds,
  type ApplyTradingPlacementEffectsPlan,
  type ApplyTradingPlacementEffectsResult,
  type ReleaseTradingOrderReservationResult,
} from "../src/modules/financial/application/trading-funds.js";
import { parseAssetCode } from "../src/modules/financial/domain/asset-code.js";
import { AssetQuantity } from "../src/modules/financial/domain/asset-quantity.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import type { FinancialDatabaseSchema } from "../src/modules/financial/infrastructure/persistence/financial-database-schema.js";
import { PostgresTradingFundsTransaction } from "../src/modules/financial/infrastructure/persistence/postgres-trading-funds-transaction.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_trading_funds_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<FinancialDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});

const btc = parseAssetCode("BTC");
const usd = parseAssetCode("USD");
const btcScale = parseAssetScale(8);
const usdScale = parseAssetScale(2);

interface WalletAccounts {
  readonly available: string;
  readonly reserved: string;
}

function btcQuantity(value: string): AssetQuantity {
  return AssetQuantity.parse(btc, btcScale, value);
}

function usdQuantity(value: string): AssetQuantity {
  return AssetQuantity.parse(usd, usdScale, value);
}

async function createWallet(ownerId: string, assetCode: "BTC" | "USD"): Promise<WalletAccounts> {
  return database.transaction().execute(async (transaction) => {
    const wallet = await transaction
      .insertInto("financial.wallets")
      .values({ owner_id: ownerId, asset_code: assetCode })
      .returning("id")
      .executeTakeFirstOrThrow();
    const rows = await transaction
      .insertInto("financial.ledger_accounts")
      .values([
        { asset_code: assetCode, kind: "user_available", wallet_id: wallet.id },
        { asset_code: assetCode, kind: "user_reserved", wallet_id: wallet.id },
      ])
      .returning(["id", "kind"])
      .execute();
    const available = rows.find(({ kind }) => kind === "user_available")?.id;
    const reserved = rows.find(({ kind }) => kind === "user_reserved")?.id;
    if (available === undefined || reserved === undefined) {
      throw new Error("Trading funds test wallet accounts were not created");
    }
    return { available, reserved };
  });
}

async function createOwnerWallets(ownerId: string): Promise<void> {
  await createWallet(ownerId, "BTC");
  await createWallet(ownerId, "USD");
}

async function fund(ownerId: string, assetCode: "BTC" | "USD", amount: string): Promise<void> {
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
      throw new Error("Trading funds test funding accounts were not found");
    }
    const journal = await transaction
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: "test_trading_funds_credit",
        idempotency_scope: `test.trading.funds.${randomUUID()}`,
        idempotency_key: randomUUID(),
        intent_hash: randomBytes(32).toString("hex"),
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
          amount,
        },
        {
          journal_id: journal.id,
          position: 2,
          account_id: availableId,
          asset_code: assetCode,
          direction: "credit",
          amount,
        },
      ])
      .execute();
  });
}

async function balances(
  ownerId: string,
  assetCode: "BTC" | "USD",
): Promise<{ readonly available: string; readonly reserved: string }> {
  const rows = await database
    .selectFrom("financial.ledger_accounts as account")
    .innerJoin("financial.wallets as wallet", "wallet.id", "account.wallet_id")
    .leftJoin("financial.journal_postings as posting", "posting.account_id", "account.id")
    .select([
      "account.kind",
      sql<string>`COALESCE(SUM(CASE WHEN posting.direction = 'credit' THEN posting.amount ELSE -posting.amount END), 0)::TEXT`.as(
        "balance",
      ),
    ])
    .where("wallet.owner_id", "=", ownerId)
    .where("wallet.asset_code", "=", assetCode)
    .groupBy("account.kind")
    .execute();
  return {
    available: rows.find(({ kind }) => kind === "user_available")?.balance ?? "0",
    reserved: rows.find(({ kind }) => kind === "user_reserved")?.balance ?? "0",
  };
}

function reservationPlan(input: {
  readonly orderId: string;
  readonly ownerId: string;
  readonly side: "buy" | "sell";
  readonly amount: AssetQuantity;
}): ApplyTradingPlacementEffectsPlan {
  return {
    market: { code: "BTC-USD", baseAssetCode: btc, quoteAssetCode: usd },
    incoming: input,
    executions: [],
  };
}

async function apply(
  plan: ApplyTradingPlacementEffectsPlan,
): Promise<ApplyTradingPlacementEffectsResult> {
  return database
    .transaction()
    .execute((transaction) =>
      new FinancialTradingFunds(
        new PostgresTradingFundsTransaction(transaction),
      ).applyPlacementEffects(plan),
    );
}

describe("PostgreSQL Financial Trading funds transaction", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("reserves and atomically settles both assets with price improvement and terminal release", async () => {
    const sellerId = randomUUID();
    const buyerId = randomUUID();
    const sellerOrderId = randomUUID();
    const buyerOrderId = randomUUID();
    const tradeId = randomUUID();
    await createOwnerWallets(sellerId);
    await createOwnerWallets(buyerId);
    await fund(sellerId, "BTC", btcQuantity("1").atomicUnits.toString());
    await fund(buyerId, "USD", usdQuantity("2000").atomicUnits.toString());

    await expect(
      apply(
        reservationPlan({
          orderId: sellerOrderId,
          ownerId: sellerId,
          side: "sell",
          amount: btcQuantity("1"),
        }),
      ),
    ).resolves.toEqual({ status: "applied" });

    const buyerPlan: ApplyTradingPlacementEffectsPlan = {
      market: { code: "BTC-USD", baseAssetCode: btc, quoteAssetCode: usd },
      incoming: {
        orderId: buyerOrderId,
        ownerId: buyerId,
        side: "buy",
        amount: usdQuantity("1100"),
      },
      executions: [
        {
          tradeId,
          makerOrderId: sellerOrderId,
          takerOrderId: buyerOrderId,
          buyerOrderId,
          buyerOwnerId: buyerId,
          sellerOrderId,
          sellerOwnerId: sellerId,
          baseQuantity: btcQuantity("0.4"),
          executionQuote: usdQuantity("400"),
          buyerReservedQuoteReduction: usdQuantity("440"),
        },
      ],
      terminalReleaseReason: "self_trade_prevention",
    };

    await expect(apply(buyerPlan)).resolves.toEqual({ status: "applied" });
    await expect(balances(buyerId, "BTC")).resolves.toEqual({
      available: "40000000",
      reserved: "0",
    });
    await expect(balances(buyerId, "USD")).resolves.toEqual({
      available: "160000",
      reserved: "0",
    });
    await expect(balances(sellerId, "BTC")).resolves.toEqual({
      available: "0",
      reserved: "60000000",
    });
    await expect(balances(sellerId, "USD")).resolves.toEqual({
      available: "40000",
      reserved: "0",
    });

    const reservations = await database
      .selectFrom("financial.trading_reservations")
      .select(["order_id as orderId", "remaining_amount as remaining", "status"])
      .where("order_id", "in", [sellerOrderId, buyerOrderId])
      .orderBy("order_id")
      .execute();
    expect(reservations).toEqual(
      expect.arrayContaining([
        { orderId: sellerOrderId, remaining: "60000000", status: "active" },
        { orderId: buyerOrderId, remaining: "0", status: "released" },
      ]),
    );

    await expect(apply(buyerPlan)).resolves.toEqual({ status: "existing" });
    const tradingJournalCount = await database
      .selectFrom("financial.journal_transactions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("operation_type", "in", [
        "trading_order_reservation",
        "trading_trade_settlement",
        "trading_order_release",
      ])
      .executeTakeFirstOrThrow();
    expect(tradingJournalCount.count).toBe("4");
  });

  it("returns expected preacceptance failures without writing a reservation", async () => {
    const missingWalletOwnerId = randomUUID();
    const missingWalletOrderId = randomUUID();
    await expect(
      apply(
        reservationPlan({
          orderId: missingWalletOrderId,
          ownerId: missingWalletOwnerId,
          side: "buy",
          amount: usdQuantity("1"),
        }),
      ),
    ).resolves.toEqual({
      status: "wallet_not_found",
      ownerId: missingWalletOwnerId,
      assetCode: btc,
    });

    const ownerId = randomUUID();
    const orderId = randomUUID();
    await createOwnerWallets(ownerId);

    await expect(
      apply(
        reservationPlan({
          orderId,
          ownerId,
          side: "buy",
          amount: usdQuantity("1"),
        }),
      ),
    ).resolves.toEqual({ status: "insufficient_available", ownerId, assetCode: usd });
    const reservation = await database
      .selectFrom("financial.trading_reservations")
      .select("order_id")
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    expect(reservation).toBeUndefined();
  });

  it("rolls Financial effects back with the transaction that owns the capability", async () => {
    const ownerId = randomUUID();
    const orderId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "USD", usdQuantity("10").atomicUnits.toString());
    const plan = reservationPlan({
      orderId,
      ownerId,
      side: "buy",
      amount: usdQuantity("5"),
    });

    await expect(
      database.transaction().execute(async (transaction) => {
        const result = await new FinancialTradingFunds(
          new PostgresTradingFundsTransaction(transaction),
        ).applyPlacementEffects(plan);
        expect(result).toEqual({ status: "applied" });
        throw new Error("force owner rollback");
      }),
    ).rejects.toThrow("force owner rollback");

    await expect(balances(ownerId, "USD")).resolves.toEqual({
      available: "1000",
      reserved: "0",
    });
    const reservation = await database
      .selectFrom("financial.trading_reservations")
      .select("order_id")
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    expect(reservation).toBeUndefined();
  });

  it("releases the exact remaining amount after an asset is disabled and makes retry a no-op", async () => {
    const ownerId = randomUUID();
    const orderId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "BTC", btcQuantity("0.5").atomicUnits.toString());
    await apply(
      reservationPlan({
        orderId,
        ownerId,
        side: "sell",
        amount: btcQuantity("0.5"),
      }),
    );
    await database
      .updateTable("financial.assets")
      .set({ status: "disabled" })
      .where("code", "=", "BTC")
      .execute();

    await expect(
      apply(
        reservationPlan({
          orderId: randomUUID(),
          ownerId,
          side: "sell",
          amount: btcQuantity("0.1"),
        }),
      ),
    ).resolves.toEqual({ status: "asset_disabled", assetCode: btc });

    const release = (): Promise<ReleaseTradingOrderReservationResult> =>
      database.transaction().execute((transaction) =>
        new FinancialTradingFunds(
          new PostgresTradingFundsTransaction(transaction),
        ).releaseOrderReservation({
          orderId,
          ownerId,
          marketCode: "BTC-USD",
          reason: "owner_cancelled",
        }),
      );
    await expect(release()).resolves.toEqual({ status: "released" });
    await expect(release()).resolves.toEqual({ status: "existing" });
    await expect(balances(ownerId, "BTC")).resolves.toEqual({
      available: "50000000",
      reserved: "0",
    });
  });
});
