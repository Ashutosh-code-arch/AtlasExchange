import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_trading_reservation_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 6 });

interface WalletFixture {
  readonly assetCode: string;
  readonly availableAccountId: string;
  readonly ownerId: string;
  readonly reservedAccountId: string;
  readonly walletId: string;
}

interface ReservationFixture {
  readonly journalId: string;
  readonly orderId: string;
  readonly wallet: WalletFixture;
}

async function createWallet(ownerId: string, assetCode: string): Promise<WalletFixture> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wallet = await client.query<{ id: string }>(
      `INSERT INTO financial.wallets (owner_id, asset_code)
       VALUES ($1, $2)
       RETURNING id`,
      [ownerId, assetCode],
    );
    const walletId = wallet.rows[0]?.id;
    if (walletId === undefined) {
      throw new Error("Trading reservation test wallet was not created");
    }
    const accounts = await client.query<{ id: string; kind: string }>(
      `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
       VALUES ($1, 'user_available', $2), ($1, 'user_reserved', $2)
       RETURNING id, kind`,
      [assetCode, walletId],
    );
    await client.query("COMMIT");

    const availableAccountId = accounts.rows.find(({ kind }) => kind === "user_available")?.id;
    const reservedAccountId = accounts.rows.find(({ kind }) => kind === "user_reserved")?.id;
    if (availableAccountId === undefined || reservedAccountId === undefined) {
      throw new Error("Trading reservation test accounts were not created");
    }
    return { assetCode, availableAccountId, ownerId, reservedAccountId, walletId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertJournal(
  client: PoolClient,
  input: {
    readonly businessReferences: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
    readonly idempotencyScope: string;
    readonly operationType: string;
  },
): Promise<string> {
  const journal = await client.query<{ id: string }>(
    `INSERT INTO financial.journal_transactions (
       operation_type, idempotency_scope, idempotency_key, intent_hash, business_references
     ) VALUES ($1, $2, $3, $4, $5::JSONB)
     RETURNING id`,
    [
      input.operationType,
      input.idempotencyScope,
      input.idempotencyKey,
      randomBytes(32).toString("hex"),
      JSON.stringify(input.businessReferences),
    ],
  );
  const journalId = journal.rows[0]?.id;
  if (journalId === undefined) {
    throw new Error("Trading reservation test journal was not created");
  }
  return journalId;
}

async function fundAvailable(wallet: WalletFixture, amount: string): Promise<void> {
  const custody = await pool.query<{ id: string }>(
    `SELECT id
     FROM financial.ledger_accounts
     WHERE asset_code = $1 AND kind = 'external_custody'`,
    [wallet.assetCode],
  );
  const custodyAccountId = custody.rows[0]?.id;
  if (custodyAccountId === undefined) {
    throw new Error("Trading reservation test custody account was not found");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const journalId = await insertJournal(client, {
      operationType: "test_trading_funding",
      idempotencyScope: `test:${randomUUID()}`,
      idempotencyKey: randomUUID(),
      businessReferences: {},
    });
    await client.query(
      `INSERT INTO financial.journal_postings (
         journal_id, position, account_id, asset_code, direction, amount
       ) VALUES
         ($1, 1, $2, $4, 'debit', $5),
         ($1, 2, $3, $4, 'credit', $5)`,
      [journalId, custodyAccountId, wallet.availableAccountId, wallet.assetCode, amount],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createReservation(
  wallet: WalletFixture,
  input: {
    readonly amount: string;
    readonly marketCode?: string;
    readonly orderId?: string;
    readonly reservationOwnerId?: string;
    readonly side: "buy" | "sell";
  },
): Promise<ReservationFixture> {
  const orderId = input.orderId ?? randomUUID();
  const ownerId = input.reservationOwnerId ?? wallet.ownerId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const journalId = await insertJournal(client, {
      operationType: "trading_order_reservation",
      idempotencyScope: "trading.order.reserve",
      idempotencyKey: orderId,
      businessReferences: {
        source: "trading",
        orderId,
        ownerId,
        marketCode: input.marketCode ?? "BTC-USD",
        side: input.side,
      },
    });
    await client.query(
      `INSERT INTO financial.journal_postings (
         journal_id, position, account_id, asset_code, direction, amount
       ) VALUES
         ($1, 1, $2, $4, 'debit', $5),
         ($1, 2, $3, $4, 'credit', $5)`,
      [
        journalId,
        wallet.availableAccountId,
        wallet.reservedAccountId,
        wallet.assetCode,
        input.amount,
      ],
    );
    await client.query(
      `INSERT INTO financial.trading_reservations (
         order_id, owner_id, market_code, side, asset_code,
         original_amount, remaining_amount, status, reservation_journal_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'active', $7)`,
      [
        orderId,
        ownerId,
        input.marketCode ?? "BTC-USD",
        input.side,
        wallet.assetCode,
        input.amount,
        journalId,
      ],
    );
    await client.query("COMMIT");
    return { journalId, orderId, wallet };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function walletBalances(wallet: WalletFixture): Promise<{
  readonly available: string;
  readonly reserved: string;
}> {
  const result = await pool.query<{ available: string; reserved: string }>(
    `SELECT
       COALESCE(SUM(
         CASE WHEN account.kind = 'user_available'
           THEN CASE posting.direction WHEN 'credit' THEN posting.amount ELSE -posting.amount END
           ELSE 0 END
       ), 0)::TEXT AS available,
       COALESCE(SUM(
         CASE WHEN account.kind = 'user_reserved'
           THEN CASE posting.direction WHEN 'credit' THEN posting.amount ELSE -posting.amount END
           ELSE 0 END
       ), 0)::TEXT AS reserved
     FROM financial.ledger_accounts AS account
     LEFT JOIN financial.journal_postings AS posting ON posting.account_id = account.id
     WHERE account.wallet_id = $1`,
    [wallet.walletId],
  );
  return result.rows[0] ?? { available: "0", reserved: "0" };
}

async function releaseReservation(
  reservation: ReservationFixture,
  amount: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const journalId = await insertJournal(client, {
      operationType: "trading_order_release",
      idempotencyScope: "trading.order.release",
      idempotencyKey: reservation.orderId,
      businessReferences: {
        source: "trading",
        orderId: reservation.orderId,
        ownerId: reservation.wallet.ownerId,
        marketCode: "BTC-USD",
        reason: "owner_cancelled",
      },
    });
    await client.query(
      `INSERT INTO financial.journal_postings (
         journal_id, position, account_id, asset_code, direction, amount
       ) VALUES
         ($1, 1, $2, $4, 'debit', $5),
         ($1, 2, $3, $4, 'credit', $5)`,
      [
        journalId,
        reservation.wallet.reservedAccountId,
        reservation.wallet.availableAccountId,
        reservation.wallet.assetCode,
        amount,
      ],
    );
    await client.query(
      `INSERT INTO financial.trading_reservation_movements (
         reservation_order_id, journal_id, movement_kind, amount
       ) VALUES ($1, $2, 'release', $3)`,
      [reservation.orderId, journalId, amount],
    );
    await client.query(
      `UPDATE financial.trading_reservations
       SET remaining_amount = 0, status = 'released'
       WHERE order_id = $1`,
      [reservation.orderId],
    );
    await client.query("COMMIT");
    return journalId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("Financial Trading reservation schema migration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("commits one exact order reservation linked to its journal", async () => {
    const wallet = await createWallet(randomUUID(), "USD");
    await fundAvailable(wallet, "10000");
    const reservation = await createReservation(wallet, { amount: "5000", side: "buy" });
    const stored = await pool.query<{
      original_amount: string;
      remaining_amount: string;
      reservation_journal_id: string;
      status: string;
    }>(
      `SELECT original_amount::TEXT, remaining_amount::TEXT, status, reservation_journal_id
       FROM financial.trading_reservations
       WHERE order_id = $1`,
      [reservation.orderId],
    );

    expect(stored.rows[0]).toEqual({
      original_amount: "5000",
      remaining_amount: "5000",
      status: "active",
      reservation_journal_id: reservation.journalId,
    });
    await expect(walletBalances(wallet)).resolves.toEqual({ available: "5000", reserved: "5000" });
  });

  it("rejects a reservation whose journal uses another owner's accounts", async () => {
    const wallet = await createWallet(randomUUID(), "USD");
    await fundAvailable(wallet, "1000");

    await expect(
      createReservation(wallet, {
        amount: "500",
        reservationOwnerId: randomUUID(),
        side: "buy",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(walletBalances(wallet)).resolves.toEqual({ available: "1000", reserved: "0" });
  });

  it("releases the complete residual once and keeps movement facts immutable", async () => {
    const wallet = await createWallet(randomUUID(), "USD");
    await fundAvailable(wallet, "2000");
    const reservation = await createReservation(wallet, { amount: "1250", side: "buy" });
    const releaseJournalId = await releaseReservation(reservation, "1250");

    await expect(walletBalances(wallet)).resolves.toEqual({ available: "2000", reserved: "0" });
    const state = await pool.query<{ remaining_amount: string; status: string }>(
      `SELECT remaining_amount::TEXT, status
       FROM financial.trading_reservations
       WHERE order_id = $1`,
      [reservation.orderId],
    );
    expect(state.rows[0]).toEqual({ remaining_amount: "0", status: "released" });

    await expect(
      pool.query(
        `UPDATE financial.trading_reservation_movements
         SET amount = 1
         WHERE reservation_order_id = $1 AND journal_id = $2`,
        [reservation.orderId, releaseJournalId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE financial.trading_reservations SET status = 'consumed' WHERE order_id = $1",
        [reservation.orderId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects release state that does not reconcile with its movement", async () => {
    const wallet = await createWallet(randomUUID(), "USD");
    await fundAvailable(wallet, "2000");
    const reservation = await createReservation(wallet, { amount: "1250", side: "buy" });

    await expect(releaseReservation(reservation, "1200")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(walletBalances(wallet)).resolves.toEqual({ available: "750", reserved: "1250" });
  });

  it("settles base, quote, and price improvement in one immutable journal", async () => {
    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const buyerUsd = await createWallet(buyerId, "USD");
    const buyerBtc = await createWallet(buyerId, "BTC");
    const sellerUsd = await createWallet(sellerId, "USD");
    const sellerBtc = await createWallet(sellerId, "BTC");
    await fundAvailable(buyerUsd, "10000");
    await fundAvailable(sellerBtc, "200000");
    const buyerReservation = await createReservation(buyerUsd, { amount: "5000", side: "buy" });
    const sellerReservation = await createReservation(sellerBtc, {
      amount: "100000",
      side: "sell",
    });
    const tradeId = randomUUID();
    const client = await pool.connect();
    let settlementJournalId: string;
    try {
      await client.query("BEGIN");
      settlementJournalId = await insertJournal(client, {
        operationType: "trading_trade_settlement",
        idempotencyScope: "trading.trade.settle",
        idempotencyKey: tradeId,
        businessReferences: {
          source: "trading",
          tradeId,
          marketCode: "BTC-USD",
          makerOrderId: sellerReservation.orderId,
          takerOrderId: buyerReservation.orderId,
          buyerOrderId: buyerReservation.orderId,
          sellerOrderId: sellerReservation.orderId,
        },
      });
      await client.query(
        `INSERT INTO financial.journal_postings (
           journal_id, position, account_id, asset_code, direction, amount
         ) VALUES
           ($1, 1, $2, 'BTC', 'debit', 100000),
           ($1, 2, $3, 'BTC', 'credit', 100000),
           ($1, 3, $4, 'USD', 'debit', 5000),
           ($1, 4, $5, 'USD', 'credit', 4900),
           ($1, 5, $6, 'USD', 'credit', 100)`,
        [
          settlementJournalId,
          sellerBtc.reservedAccountId,
          buyerBtc.availableAccountId,
          buyerUsd.reservedAccountId,
          sellerUsd.availableAccountId,
          buyerUsd.availableAccountId,
        ],
      );
      await client.query(
        `INSERT INTO financial.trading_reservation_movements (
           reservation_order_id, journal_id, movement_kind, amount, trade_id
         ) VALUES
           ($1, $3, 'trade_settlement', 5000, $4),
           ($2, $3, 'trade_settlement', 100000, $4)`,
        [buyerReservation.orderId, sellerReservation.orderId, settlementJournalId, tradeId],
      );
      await client.query(
        `UPDATE financial.trading_reservations
         SET remaining_amount = 0, status = 'consumed'
         WHERE order_id IN ($1, $2)`,
        [buyerReservation.orderId, sellerReservation.orderId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expect(walletBalances(buyerBtc)).resolves.toEqual({
      available: "100000",
      reserved: "0",
    });
    await expect(walletBalances(sellerBtc)).resolves.toEqual({
      available: "100000",
      reserved: "0",
    });
    await expect(walletBalances(buyerUsd)).resolves.toEqual({
      available: "5100",
      reserved: "0",
    });
    await expect(walletBalances(sellerUsd)).resolves.toEqual({
      available: "4900",
      reserved: "0",
    });

    const movements = await pool.query<{ amount: string; movement_kind: string }>(
      `SELECT amount::TEXT, movement_kind
       FROM financial.trading_reservation_movements
       WHERE journal_id = $1
       ORDER BY financial.trading_reservation_movements.amount`,
      [settlementJournalId],
    );
    expect(movements.rows).toEqual([
      { amount: "5000", movement_kind: "trade_settlement" },
      { amount: "100000", movement_kind: "trade_settlement" },
    ]);
  });

  it("rejects Trading journals without their matching reservation facts", async () => {
    const wallet = await createWallet(randomUUID(), "USD");
    await fundAvailable(wallet, "1000");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const orderId = randomUUID();
      const journalId = await insertJournal(client, {
        operationType: "trading_order_reservation",
        idempotencyScope: "trading.order.reserve",
        idempotencyKey: orderId,
        businessReferences: {
          source: "trading",
          orderId,
          ownerId: wallet.ownerId,
          marketCode: "BTC-USD",
          side: "buy",
        },
      });
      await client.query(
        `INSERT INTO financial.journal_postings (
           journal_id, position, account_id, asset_code, direction, amount
         ) VALUES
           ($1, 1, $2, 'USD', 'debit', 500),
           ($1, 2, $3, 'USD', 'credit', 500)`,
        [journalId, wallet.availableAccountId, wallet.reservedAccountId],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
