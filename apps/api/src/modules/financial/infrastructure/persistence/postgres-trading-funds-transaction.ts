import { createHash } from "node:crypto";

import { sql, type Transaction } from "kysely";

import type {
  ApplyTradingPlacementEffectsPlan,
  ApplyTradingPlacementEffectsResult,
  ReleaseTradingOrderReservationCommand,
  ReleaseTradingOrderReservationResult,
  TradingExecutionIntent,
  TradingFundsTransaction,
  TradingOrderSide,
} from "../../application/trading-funds.js";
import type { AssetCode } from "../../domain/asset-code.js";
import { maximumAtomicUnits } from "../../domain/asset-quantity.js";
import {
  FinancialInvariantError,
  type FinancialInvariantIssue,
} from "../../domain/financial-invariant-error.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

type UserAccountKind = "user_available" | "user_reserved";

interface AssetRow {
  readonly code: string;
  readonly scale: number;
  readonly status: "active" | "disabled";
}

interface ReservationRow {
  readonly orderId: string;
  readonly ownerId: string;
  readonly marketCode: string;
  readonly side: TradingOrderSide;
  readonly assetCode: string;
  readonly originalAmount: string;
  readonly remainingAmount: string;
  readonly status: "active" | "consumed" | "released";
  readonly reservationJournalId: string;
}

interface MutableReservationState {
  readonly orderId: string;
  readonly ownerId: string;
  readonly marketCode: string;
  readonly side: TradingOrderSide;
  readonly assetCode: string;
  readonly originalAmount: bigint;
  remainingAmount: bigint;
  status: "active" | "consumed" | "released";
}

interface WalletAccountRow {
  readonly ownerId: string;
  readonly assetCode: string;
  readonly accountId: string;
  readonly kind: UserAccountKind;
}

interface AccountTotalsRow {
  readonly accountId: string;
  readonly creditAtomicUnits: string;
  readonly debitAtomicUnits: string;
}

interface JournalPostingEffect {
  readonly accountId: string;
  readonly assetCode: AssetCode;
  readonly direction: "credit" | "debit";
  readonly amountAtomicUnits: bigint;
}

interface JournalEffect {
  readonly operationType:
    "trading_order_reservation" | "trading_order_release" | "trading_trade_settlement";
  readonly idempotencyScope:
    "trading.order.reserve" | "trading.order.release" | "trading.trade.settle";
  readonly idempotencyKey: string;
  readonly businessReferences: Readonly<Record<string, string>>;
  readonly postings: readonly JournalPostingEffect[];
  readonly intentHash: string;
}

interface PlacementContext {
  readonly assets: ReadonlyMap<string, AssetRow>;
  readonly reservations: ReadonlyMap<string, ReservationRow>;
  readonly accounts: ReadonlyMap<string, string>;
  readonly accountTotals: ReadonlyMap<string, AccountTotalsRow>;
}

function invariant(issue: FinancialInvariantIssue): never {
  throw new FinancialInvariantError(issue);
}

function accountKey(ownerId: string, assetCode: string, kind: UserAccountKind): string {
  return `${ownerId}:${assetCode}:${kind}`;
}

function accountId(
  accounts: ReadonlyMap<string, string>,
  ownerId: string,
  assetCode: AssetCode,
  kind: UserAccountKind,
): string {
  return (
    accounts.get(accountKey(ownerId, assetCode, kind)) ?? invariant("TRADING_RESERVATION_CONFLICT")
  );
}

function journalEffect(input: Omit<JournalEffect, "intentHash">): JournalEffect {
  const businessReferences = Object.fromEntries(
    Object.entries(input.businessReferences).sort(([left], [right]) => left.localeCompare(right)),
  );
  const intentHash = createHash("sha256")
    .update(
      JSON.stringify({
        businessReferences,
        operationType: input.operationType,
        postings: input.postings.map((posting, index) => ({
          accountId: posting.accountId,
          amount: posting.amountAtomicUnits.toString(),
          direction: posting.direction,
          position: index + 1,
        })),
      }),
      "utf8",
    )
    .digest("hex");
  return { ...input, businessReferences, intentHash };
}

function reservationEffect(
  plan: ApplyTradingPlacementEffectsPlan,
  accounts: ReadonlyMap<string, string>,
): JournalEffect {
  const assetCode = plan.incoming.amount.assetCode;
  return journalEffect({
    operationType: "trading_order_reservation",
    idempotencyScope: "trading.order.reserve",
    idempotencyKey: plan.incoming.orderId,
    businessReferences: {
      source: "trading",
      orderId: plan.incoming.orderId,
      ownerId: plan.incoming.ownerId,
      marketCode: plan.market.code,
      side: plan.incoming.side,
    },
    postings: [
      {
        accountId: accountId(accounts, plan.incoming.ownerId, assetCode, "user_available"),
        assetCode,
        direction: "debit",
        amountAtomicUnits: plan.incoming.amount.atomicUnits,
      },
      {
        accountId: accountId(accounts, plan.incoming.ownerId, assetCode, "user_reserved"),
        assetCode,
        direction: "credit",
        amountAtomicUnits: plan.incoming.amount.atomicUnits,
      },
    ],
  });
}

function settlementEffect(
  plan: ApplyTradingPlacementEffectsPlan,
  execution: TradingExecutionIntent,
  accounts: ReadonlyMap<string, string>,
): JournalEffect {
  const base = plan.market.baseAssetCode;
  const quote = plan.market.quoteAssetCode;
  const improvement =
    execution.buyerReservedQuoteReduction.atomicUnits - execution.executionQuote.atomicUnits;
  const postings: JournalPostingEffect[] = [
    {
      accountId: accountId(accounts, execution.sellerOwnerId, base, "user_reserved"),
      assetCode: base,
      direction: "debit",
      amountAtomicUnits: execution.baseQuantity.atomicUnits,
    },
    {
      accountId: accountId(accounts, execution.buyerOwnerId, base, "user_available"),
      assetCode: base,
      direction: "credit",
      amountAtomicUnits: execution.baseQuantity.atomicUnits,
    },
    {
      accountId: accountId(accounts, execution.buyerOwnerId, quote, "user_reserved"),
      assetCode: quote,
      direction: "debit",
      amountAtomicUnits: execution.buyerReservedQuoteReduction.atomicUnits,
    },
    {
      accountId: accountId(accounts, execution.sellerOwnerId, quote, "user_available"),
      assetCode: quote,
      direction: "credit",
      amountAtomicUnits: execution.executionQuote.atomicUnits,
    },
  ];
  if (improvement > 0n) {
    postings.push({
      accountId: accountId(accounts, execution.buyerOwnerId, quote, "user_available"),
      assetCode: quote,
      direction: "credit",
      amountAtomicUnits: improvement,
    });
  }

  return journalEffect({
    operationType: "trading_trade_settlement",
    idempotencyScope: "trading.trade.settle",
    idempotencyKey: execution.tradeId,
    businessReferences: {
      source: "trading",
      tradeId: execution.tradeId,
      marketCode: plan.market.code,
      makerOrderId: execution.makerOrderId,
      takerOrderId: execution.takerOrderId,
      buyerOrderId: execution.buyerOrderId,
      sellerOrderId: execution.sellerOrderId,
    },
    postings,
  });
}

function releaseEffect(
  input: ReleaseTradingOrderReservationCommand,
  assetCode: AssetCode,
  remainingAmount: bigint,
  accounts: ReadonlyMap<string, string>,
): JournalEffect {
  return journalEffect({
    operationType: "trading_order_release",
    idempotencyScope: "trading.order.release",
    idempotencyKey: input.orderId,
    businessReferences: {
      source: "trading",
      orderId: input.orderId,
      ownerId: input.ownerId,
      marketCode: input.marketCode,
      reason: input.reason,
    },
    postings: [
      {
        accountId: accountId(accounts, input.ownerId, assetCode, "user_reserved"),
        assetCode,
        direction: "debit",
        amountAtomicUnits: remainingAmount,
      },
      {
        accountId: accountId(accounts, input.ownerId, assetCode, "user_available"),
        assetCode,
        direction: "credit",
        amountAtomicUnits: remainingAmount,
      },
    ],
  });
}

function mutableReservation(row: ReservationRow): MutableReservationState {
  return {
    ...row,
    originalAmount: BigInt(row.originalAmount),
    remainingAmount: BigInt(row.remainingAmount),
  };
}

function assertReservationIdentity(
  reservation: ReservationRow | MutableReservationState,
  input: {
    readonly orderId: string;
    readonly ownerId: string;
    readonly marketCode: string;
    readonly side: TradingOrderSide;
    readonly assetCode: string;
  },
): void {
  if (
    reservation.orderId !== input.orderId ||
    reservation.ownerId !== input.ownerId ||
    reservation.marketCode !== input.marketCode ||
    reservation.side !== input.side ||
    reservation.assetCode !== input.assetCode
  ) {
    invariant("TRADING_RESERVATION_CONFLICT");
  }
}

function consumeReservation(reservation: MutableReservationState, amount: bigint): void {
  if (reservation.status !== "active" || amount <= 0n || reservation.remainingAmount < amount) {
    invariant("TRADING_RESERVATION_CONFLICT");
  }
  reservation.remainingAmount -= amount;
  reservation.status = reservation.remainingAmount === 0n ? "consumed" : "active";
}

function assertAccountBalances(
  effects: readonly JournalEffect[],
  totals: ReadonlyMap<string, AccountTotalsRow>,
): void {
  const balances = new Map(
    [...totals].map(([accountIdValue, accountTotals]) => [
      accountIdValue,
      BigInt(accountTotals.creditAtomicUnits) - BigInt(accountTotals.debitAtomicUnits),
    ]),
  );
  for (const effect of effects) {
    for (const posting of effect.postings) {
      const current = balances.get(posting.accountId) ?? 0n;
      const next =
        current +
        (posting.direction === "credit" ? posting.amountAtomicUnits : -posting.amountAtomicUnits);
      if (next < 0n || next > maximumAtomicUnits) {
        invariant("TRADING_RESERVATION_CONFLICT");
      }
      balances.set(posting.accountId, next);
    }
  }
}

export class PostgresTradingFundsTransaction implements TradingFundsTransaction {
  public constructor(private readonly database: Transaction<FinancialDatabaseSchema>) {}

  public async applyPlacementEffects(
    plan: ApplyTradingPlacementEffectsPlan,
  ): Promise<ApplyTradingPlacementEffectsResult> {
    const contextResult = await this.loadPlacementContext(plan);
    if ("status" in contextResult) {
      return contextResult;
    }
    const context = contextResult;
    const reservation = reservationEffect(plan, context.accounts);
    const settlements = plan.executions.map((execution) => ({
      execution,
      journal: settlementEffect(plan, execution, context.accounts),
    }));

    const existingIncoming = context.reservations.get(plan.incoming.orderId);
    if (existingIncoming !== undefined) {
      await this.assertExistingPlacement(plan, context, reservation, settlements);
      return { status: "existing" };
    }

    for (const effect of [reservation, ...settlements.map(({ journal }) => journal)]) {
      if (await this.findJournal(effect)) {
        invariant(
          effect.operationType === "trading_trade_settlement"
            ? "TRADING_SETTLEMENT_CONFLICT"
            : "TRADING_RESERVATION_CONFLICT",
        );
      }
    }
    if (plan.terminalReleaseReason !== undefined) {
      const existingRelease = await this.findJournalByKey(
        "trading.order.release",
        plan.incoming.orderId,
      );
      if (existingRelease !== undefined) {
        invariant("TRADING_RELEASE_CONFLICT");
      }
    }

    const states = new Map(
      [...context.reservations].map(([orderId, row]) => [orderId, mutableReservation(row)]),
    );
    const incomingState: MutableReservationState = {
      orderId: plan.incoming.orderId,
      ownerId: plan.incoming.ownerId,
      marketCode: plan.market.code,
      side: plan.incoming.side,
      assetCode: plan.incoming.amount.assetCode,
      originalAmount: plan.incoming.amount.atomicUnits,
      remainingAmount: plan.incoming.amount.atomicUnits,
      status: "active",
    };
    states.set(incomingState.orderId, incomingState);
    this.simulateSettlements(plan, states);

    const incomingAvailableId = accountId(
      context.accounts,
      plan.incoming.ownerId,
      plan.incoming.amount.assetCode,
      "user_available",
    );
    const totals = context.accountTotals.get(incomingAvailableId);
    const available =
      BigInt(totals?.creditAtomicUnits ?? "0") - BigInt(totals?.debitAtomicUnits ?? "0");
    if (available < plan.incoming.amount.atomicUnits) {
      return {
        status: "insufficient_available",
        ownerId: plan.incoming.ownerId,
        assetCode: plan.incoming.amount.assetCode,
      };
    }

    const effects = [reservation, ...settlements.map(({ journal }) => journal)];
    if (plan.terminalReleaseReason !== undefined) {
      effects.push(
        releaseEffect(
          {
            orderId: incomingState.orderId,
            ownerId: incomingState.ownerId,
            marketCode: incomingState.marketCode,
            reason: plan.terminalReleaseReason,
          },
          incomingState.assetCode as AssetCode,
          incomingState.remainingAmount,
          context.accounts,
        ),
      );
    }
    assertAccountBalances(effects, context.accountTotals);

    const reservationJournalId = await this.persistJournal(
      reservation,
      "TRADING_RESERVATION_CONFLICT",
    );
    await this.database
      .insertInto("financial.trading_reservations")
      .values({
        order_id: incomingState.orderId,
        owner_id: incomingState.ownerId,
        market_code: incomingState.marketCode,
        side: incomingState.side,
        asset_code: incomingState.assetCode,
        original_amount: incomingState.originalAmount.toString(),
        remaining_amount: incomingState.originalAmount.toString(),
        status: "active",
        reservation_journal_id: reservationJournalId,
      })
      .execute();

    const persistedStates = new Map(
      [...context.reservations].map(([orderId, row]) => [orderId, mutableReservation(row)]),
    );
    persistedStates.set(incomingState.orderId, {
      ...incomingState,
      remainingAmount: incomingState.originalAmount,
      status: "active",
    });
    for (const { execution, journal } of settlements) {
      const journalId = await this.persistJournal(journal, "TRADING_SETTLEMENT_CONFLICT");
      const buyer = persistedStates.get(execution.buyerOrderId);
      const seller = persistedStates.get(execution.sellerOrderId);
      if (buyer === undefined || seller === undefined) {
        invariant("TRADING_RESERVATION_CONFLICT");
      }
      consumeReservation(buyer, execution.buyerReservedQuoteReduction.atomicUnits);
      consumeReservation(seller, execution.baseQuantity.atomicUnits);
      await this.database
        .insertInto("financial.trading_reservation_movements")
        .values([
          {
            reservation_order_id: buyer.orderId,
            journal_id: journalId,
            movement_kind: "trade_settlement",
            amount: execution.buyerReservedQuoteReduction.atomicUnits.toString(),
            trade_id: execution.tradeId,
          },
          {
            reservation_order_id: seller.orderId,
            journal_id: journalId,
            movement_kind: "trade_settlement",
            amount: execution.baseQuantity.atomicUnits.toString(),
            trade_id: execution.tradeId,
          },
        ])
        .execute();
      await this.persistReservationState(buyer);
      await this.persistReservationState(seller);
    }

    if (plan.terminalReleaseReason !== undefined) {
      const currentIncoming = persistedStates.get(plan.incoming.orderId);
      if (currentIncoming === undefined || currentIncoming.remainingAmount <= 0n) {
        invariant("TRADING_RELEASE_CONFLICT");
      }
      const command: ReleaseTradingOrderReservationCommand = {
        orderId: currentIncoming.orderId,
        ownerId: currentIncoming.ownerId,
        marketCode: currentIncoming.marketCode,
        reason: plan.terminalReleaseReason,
      };
      await this.persistRelease(command, currentIncoming, context.accounts);
    }
    return { status: "applied" };
  }

  public async releaseOrderReservation(
    command: ReleaseTradingOrderReservationCommand,
  ): Promise<ReleaseTradingOrderReservationResult> {
    const row = (await this.database
      .selectFrom("financial.trading_reservations")
      .select([
        "order_id as orderId",
        "owner_id as ownerId",
        "market_code as marketCode",
        "side",
        "asset_code as assetCode",
        "original_amount as originalAmount",
        "remaining_amount as remainingAmount",
        "status",
        "reservation_journal_id as reservationJournalId",
      ])
      .where("order_id", "=", command.orderId)
      .forUpdate()
      .executeTakeFirst()) as ReservationRow | undefined;
    if (row === undefined) {
      invariant("TRADING_RESERVATION_NOT_FOUND");
    }
    if (row.ownerId !== command.ownerId || row.marketCode !== command.marketCode) {
      invariant("TRADING_RESERVATION_CONFLICT");
    }
    if (row.status === "consumed") {
      invariant("TRADING_RELEASE_CONFLICT");
    }

    const accountsResult = await this.loadAndLockWalletAccounts(
      [command.ownerId],
      [row.assetCode as AssetCode],
    );
    if ("status" in accountsResult) {
      invariant("TRADING_RESERVATION_CONFLICT");
    }
    const amount =
      row.status === "released" ? BigInt(row.originalAmount) : BigInt(row.remainingAmount);
    const movement =
      row.status === "released"
        ? await this.database
            .selectFrom("financial.trading_reservation_movements")
            .select(["amount", "journal_id as journalId"])
            .where("reservation_order_id", "=", row.orderId)
            .where("movement_kind", "=", "release")
            .executeTakeFirst()
        : undefined;
    const releaseAmount = movement === undefined ? amount : BigInt(movement.amount);
    const effect = releaseEffect(
      command,
      row.assetCode as AssetCode,
      releaseAmount,
      accountsResult.accounts,
    );
    const existing = await this.findJournal(effect);
    if (row.status === "released") {
      if (existing === false || movement === undefined || existing.id !== movement.journalId) {
        invariant("TRADING_RELEASE_CONFLICT");
      }
      return { status: "existing" };
    }
    if (existing !== false) {
      invariant("TRADING_RELEASE_CONFLICT");
    }

    assertAccountBalances([effect], accountsResult.accountTotals);
    await this.persistRelease(command, mutableReservation(row), accountsResult.accounts);
    return { status: "released" };
  }

  private async loadPlacementContext(
    plan: ApplyTradingPlacementEffectsPlan,
  ): Promise<
    | PlacementContext
    | Exclude<ApplyTradingPlacementEffectsResult, { status: "applied" | "existing" }>
  > {
    const orderIds = [
      ...new Set([
        plan.incoming.orderId,
        ...plan.executions.flatMap(({ buyerOrderId, sellerOrderId }) => [
          buyerOrderId,
          sellerOrderId,
        ]),
      ]),
    ].sort();
    const reservationRows =
      orderIds.length === 0
        ? []
        : ((await this.database
            .selectFrom("financial.trading_reservations")
            .select([
              "order_id as orderId",
              "owner_id as ownerId",
              "market_code as marketCode",
              "side",
              "asset_code as assetCode",
              "original_amount as originalAmount",
              "remaining_amount as remainingAmount",
              "status",
              "reservation_journal_id as reservationJournalId",
            ])
            .where("order_id", "in", orderIds)
            .orderBy("order_id")
            .forUpdate()
            .execute()) as readonly ReservationRow[]);

    const assetCodes = [plan.market.baseAssetCode, plan.market.quoteAssetCode].sort();
    const assetRows = (await this.database
      .selectFrom("financial.assets")
      .select(["code", "ledger_scale as scale", "status"])
      .where("code", "in", assetCodes)
      .orderBy("code")
      .forShare()
      .execute()) as readonly AssetRow[];
    const assets = new Map(assetRows.map((row) => [row.code, row]));
    for (const assetCode of assetCodes) {
      const asset = assets.get(assetCode);
      if (asset === undefined || asset.status === "disabled") {
        return { status: "asset_disabled", assetCode };
      }
    }
    for (const quantity of [
      plan.incoming.amount,
      ...plan.executions.flatMap((execution) => [
        execution.baseQuantity,
        execution.executionQuote,
        execution.buyerReservedQuoteReduction,
      ]),
    ]) {
      if (assets.get(quantity.assetCode)?.scale !== quantity.scale) {
        invariant("TRADING_FUNDS_PLAN_INVALID");
      }
    }

    const ownerIds = [
      ...new Set([
        plan.incoming.ownerId,
        ...plan.executions.flatMap(({ buyerOwnerId, sellerOwnerId }) => [
          buyerOwnerId,
          sellerOwnerId,
        ]),
      ]),
    ].sort();
    const accountsResult = await this.loadAndLockWalletAccounts(ownerIds, assetCodes);
    if ("status" in accountsResult) {
      return accountsResult;
    }
    return {
      assets,
      reservations: new Map(reservationRows.map((row) => [row.orderId, row])),
      accounts: accountsResult.accounts,
      accountTotals: accountsResult.accountTotals,
    };
  }

  private async loadAndLockWalletAccounts(
    ownerIds: readonly string[],
    assetCodes: readonly AssetCode[],
  ): Promise<
    | {
        readonly accounts: ReadonlyMap<string, string>;
        readonly accountTotals: ReadonlyMap<string, AccountTotalsRow>;
      }
    | Extract<ApplyTradingPlacementEffectsResult, { status: "wallet_not_found" }>
  > {
    const rows = (await this.database
      .selectFrom("financial.wallets as wallet")
      .innerJoin("financial.ledger_accounts as account", "account.wallet_id", "wallet.id")
      .select([
        "wallet.owner_id as ownerId",
        "wallet.asset_code as assetCode",
        "account.id as accountId",
        "account.kind as kind",
      ])
      .where("wallet.owner_id", "in", ownerIds)
      .where("wallet.asset_code", "in", assetCodes)
      .where("account.kind", "in", ["user_available", "user_reserved"])
      .execute()) as readonly WalletAccountRow[];
    const accounts = new Map(
      rows.map((row) => [accountKey(row.ownerId, row.assetCode, row.kind), row.accountId]),
    );
    for (const ownerId of ownerIds) {
      for (const assetCode of assetCodes) {
        if (
          !accounts.has(accountKey(ownerId, assetCode, "user_available")) ||
          !accounts.has(accountKey(ownerId, assetCode, "user_reserved"))
        ) {
          return { status: "wallet_not_found", ownerId, assetCode };
        }
      }
    }

    const accountIds = [...accounts.values()].sort();
    await this.database
      .selectFrom("financial.ledger_accounts")
      .select("id")
      .where("id", "in", accountIds)
      .orderBy("id")
      .forUpdate()
      .execute();
    const totals = (await this.database
      .selectFrom("financial.journal_postings")
      .select([
        "account_id as accountId",
        sql<string>`COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::TEXT`.as(
          "creditAtomicUnits",
        ),
        sql<string>`COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::TEXT`.as(
          "debitAtomicUnits",
        ),
      ])
      .where("account_id", "in", accountIds)
      .groupBy("account_id")
      .execute()) as readonly AccountTotalsRow[];
    return {
      accounts,
      accountTotals: new Map(totals.map((row) => [row.accountId, row])),
    };
  }

  private simulateSettlements(
    plan: ApplyTradingPlacementEffectsPlan,
    states: Map<string, MutableReservationState>,
  ): void {
    for (const execution of plan.executions) {
      const buyer = states.get(execution.buyerOrderId);
      const seller = states.get(execution.sellerOrderId);
      if (buyer === undefined || seller === undefined) {
        invariant("TRADING_RESERVATION_NOT_FOUND");
      }
      assertReservationIdentity(buyer, {
        orderId: execution.buyerOrderId,
        ownerId: execution.buyerOwnerId,
        marketCode: plan.market.code,
        side: "buy",
        assetCode: plan.market.quoteAssetCode,
      });
      assertReservationIdentity(seller, {
        orderId: execution.sellerOrderId,
        ownerId: execution.sellerOwnerId,
        marketCode: plan.market.code,
        side: "sell",
        assetCode: plan.market.baseAssetCode,
      });
      consumeReservation(buyer, execution.buyerReservedQuoteReduction.atomicUnits);
      consumeReservation(seller, execution.baseQuantity.atomicUnits);
    }
  }

  private async assertExistingPlacement(
    plan: ApplyTradingPlacementEffectsPlan,
    context: PlacementContext,
    reservationEffectValue: JournalEffect,
    settlements: readonly {
      readonly execution: TradingExecutionIntent;
      readonly journal: JournalEffect;
    }[],
  ): Promise<void> {
    const existingIncoming = context.reservations.get(plan.incoming.orderId);
    if (existingIncoming === undefined) {
      invariant("TRADING_RESERVATION_CONFLICT");
    }
    assertReservationIdentity(existingIncoming, {
      orderId: plan.incoming.orderId,
      ownerId: plan.incoming.ownerId,
      marketCode: plan.market.code,
      side: plan.incoming.side,
      assetCode: plan.incoming.amount.assetCode,
    });
    if (BigInt(existingIncoming.originalAmount) !== plan.incoming.amount.atomicUnits) {
      invariant("TRADING_RESERVATION_CONFLICT");
    }
    const reservationJournal = await this.findJournal(reservationEffectValue);
    if (
      reservationJournal === false ||
      reservationJournal.id !== existingIncoming.reservationJournalId
    ) {
      invariant("TRADING_RESERVATION_CONFLICT");
    }

    let incomingConsumed = 0n;
    for (const { execution, journal } of settlements) {
      const persisted = await this.findJournal(journal);
      if (persisted === false) {
        invariant("TRADING_SETTLEMENT_CONFLICT");
      }
      const movements = await this.database
        .selectFrom("financial.trading_reservation_movements")
        .select(["reservation_order_id as orderId", "amount", "journal_id as journalId"])
        .where("trade_id", "=", execution.tradeId)
        .orderBy("reservation_order_id")
        .execute();
      const buyerMovement = movements.find(({ orderId }) => orderId === execution.buyerOrderId);
      const sellerMovement = movements.find(({ orderId }) => orderId === execution.sellerOrderId);
      if (
        movements.length !== 2 ||
        buyerMovement?.journalId !== persisted.id ||
        sellerMovement?.journalId !== persisted.id ||
        BigInt(buyerMovement.amount) !== execution.buyerReservedQuoteReduction.atomicUnits ||
        BigInt(sellerMovement.amount) !== execution.baseQuantity.atomicUnits
      ) {
        invariant("TRADING_SETTLEMENT_CONFLICT");
      }
      incomingConsumed +=
        plan.incoming.side === "buy"
          ? execution.buyerReservedQuoteReduction.atomicUnits
          : execution.baseQuantity.atomicUnits;
    }

    if (plan.terminalReleaseReason === undefined) {
      const expectedRemaining = plan.incoming.amount.atomicUnits - incomingConsumed;
      const expectedStatus = expectedRemaining === 0n ? "consumed" : "active";
      if (
        BigInt(existingIncoming.remainingAmount) !== expectedRemaining ||
        existingIncoming.status !== expectedStatus
      ) {
        invariant("TRADING_RESERVATION_CONFLICT");
      }
      return;
    }

    const expectedReleaseAmount = plan.incoming.amount.atomicUnits - incomingConsumed;
    const release = releaseEffect(
      {
        orderId: plan.incoming.orderId,
        ownerId: plan.incoming.ownerId,
        marketCode: plan.market.code,
        reason: plan.terminalReleaseReason,
      },
      plan.incoming.amount.assetCode,
      expectedReleaseAmount,
      context.accounts,
    );
    const persistedRelease = await this.findJournal(release);
    const movement = await this.database
      .selectFrom("financial.trading_reservation_movements")
      .select(["amount", "journal_id as journalId"])
      .where("reservation_order_id", "=", plan.incoming.orderId)
      .where("movement_kind", "=", "release")
      .executeTakeFirst();
    if (
      persistedRelease === false ||
      movement === undefined ||
      movement.journalId !== persistedRelease.id ||
      BigInt(movement.amount) !== expectedReleaseAmount ||
      existingIncoming.status !== "released" ||
      BigInt(existingIncoming.remainingAmount) !== 0n
    ) {
      invariant("TRADING_RELEASE_CONFLICT");
    }
  }

  private async findJournalByKey(
    scope: JournalEffect["idempotencyScope"],
    key: string,
  ): Promise<{ readonly id: string; readonly intentHash: string } | undefined> {
    return this.database
      .selectFrom("financial.journal_transactions")
      .select(["id", "intent_hash as intentHash"])
      .where("idempotency_scope", "=", scope)
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
  }

  private async findJournal(effect: JournalEffect): Promise<false | { readonly id: string }> {
    const row = await this.findJournalByKey(effect.idempotencyScope, effect.idempotencyKey);
    if (row === undefined) {
      return false;
    }
    if (row.intentHash !== effect.intentHash) {
      invariant(
        effect.operationType === "trading_trade_settlement"
          ? "TRADING_SETTLEMENT_CONFLICT"
          : effect.operationType === "trading_order_release"
            ? "TRADING_RELEASE_CONFLICT"
            : "TRADING_RESERVATION_CONFLICT",
      );
    }
    return { id: row.id };
  }

  private async persistJournal(
    effect: JournalEffect,
    conflictIssue: FinancialInvariantIssue,
  ): Promise<string> {
    const row = await this.database
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: effect.operationType,
        idempotency_scope: effect.idempotencyScope,
        idempotency_key: effect.idempotencyKey,
        intent_hash: effect.intentHash,
        business_references: effect.businessReferences,
      })
      .onConflict((conflict) =>
        conflict.columns(["idempotency_scope", "idempotency_key"]).doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (row === undefined) {
      invariant(conflictIssue);
    }
    await this.database
      .insertInto("financial.journal_postings")
      .values(
        effect.postings.map((posting, index) => ({
          journal_id: row.id,
          position: index + 1,
          account_id: posting.accountId,
          asset_code: posting.assetCode,
          direction: posting.direction,
          amount: posting.amountAtomicUnits.toString(),
        })),
      )
      .execute();
    return row.id;
  }

  private async persistReservationState(state: MutableReservationState): Promise<void> {
    await this.database
      .updateTable("financial.trading_reservations")
      .set({
        remaining_amount: state.remainingAmount.toString(),
        status: state.status,
      })
      .where("order_id", "=", state.orderId)
      .execute();
  }

  private async persistRelease(
    command: ReleaseTradingOrderReservationCommand,
    state: MutableReservationState,
    accounts: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (state.status !== "active" || state.remainingAmount <= 0n) {
      invariant("TRADING_RELEASE_CONFLICT");
    }
    const effect = releaseEffect(
      command,
      state.assetCode as AssetCode,
      state.remainingAmount,
      accounts,
    );
    const journalId = await this.persistJournal(effect, "TRADING_RELEASE_CONFLICT");
    await this.database
      .insertInto("financial.trading_reservation_movements")
      .values({
        reservation_order_id: state.orderId,
        journal_id: journalId,
        movement_kind: "release",
        amount: state.remainingAmount.toString(),
        trade_id: null,
      })
      .execute();
    state.remainingAmount = 0n;
    state.status = "released";
    await this.persistReservationState(state);
  }
}
