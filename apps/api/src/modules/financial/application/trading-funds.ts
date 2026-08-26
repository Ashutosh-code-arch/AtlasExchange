import type { AssetCode } from "../domain/asset-code.js";
import { AssetQuantity } from "../domain/asset-quantity.js";
import { FinancialInvariantError } from "../domain/financial-invariant-error.js";
import { isUuid } from "../domain/uuid.js";

export type TradingOrderSide = "buy" | "sell";
export type TradingReservationReleaseReason = "owner_cancelled" | "self_trade_prevention";

export interface TradingMarketReference {
  readonly code: string;
  readonly baseAssetCode: AssetCode;
  readonly quoteAssetCode: AssetCode;
}

export interface TradingIncomingReservationIntent {
  readonly orderId: string;
  readonly ownerId: string;
  readonly side: TradingOrderSide;
  readonly amount: AssetQuantity;
}

export interface TradingExecutionIntent {
  readonly tradeId: string;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly buyerOrderId: string;
  readonly buyerOwnerId: string;
  readonly sellerOrderId: string;
  readonly sellerOwnerId: string;
  readonly baseQuantity: AssetQuantity;
  readonly executionQuote: AssetQuantity;
  readonly buyerReservedQuoteReduction: AssetQuantity;
}

export interface ApplyTradingPlacementEffectsPlan {
  readonly market: TradingMarketReference;
  readonly incoming: TradingIncomingReservationIntent;
  readonly executions: readonly TradingExecutionIntent[];
  readonly terminalReleaseReason?: TradingReservationReleaseReason;
}

export type ApplyTradingPlacementEffectsResult =
  | { readonly status: "applied" }
  | { readonly status: "existing" }
  | { readonly status: "asset_disabled"; readonly assetCode: AssetCode }
  | {
      readonly status: "wallet_not_found";
      readonly ownerId: string;
      readonly assetCode: AssetCode;
    }
  | {
      readonly status: "insufficient_available";
      readonly ownerId: string;
      readonly assetCode: AssetCode;
    };

export interface ReleaseTradingOrderReservationCommand {
  readonly orderId: string;
  readonly ownerId: string;
  readonly marketCode: string;
  readonly reason: TradingReservationReleaseReason;
}

export type ReleaseTradingOrderReservationResult =
  { readonly status: "released" } | { readonly status: "existing" };

export interface TradingFundsCapability {
  applyPlacementEffects(
    plan: ApplyTradingPlacementEffectsPlan,
  ): Promise<ApplyTradingPlacementEffectsResult>;
  releaseOrderReservation(
    command: ReleaseTradingOrderReservationCommand,
  ): Promise<ReleaseTradingOrderReservationResult>;
}

export type TradingFundsTransaction = TradingFundsCapability;

function invalidPlan(): never {
  throw new FinancialInvariantError("TRADING_FUNDS_PLAN_INVALID");
}

function assertUuid(value: string): void {
  if (!isUuid(value)) {
    invalidPlan();
  }
}

function assertPositiveQuantity(quantity: AssetQuantity, assetCode: AssetCode): void {
  if (!(quantity instanceof AssetQuantity) || quantity.assetCode !== assetCode) {
    invalidPlan();
  }
  if (quantity.atomicUnits <= 0n) {
    invalidPlan();
  }
}

function assertPlan(plan: ApplyTradingPlacementEffectsPlan): void {
  const { market, incoming } = plan;
  if (
    market.baseAssetCode === market.quoteAssetCode ||
    market.code !== `${market.baseAssetCode}-${market.quoteAssetCode}`
  ) {
    invalidPlan();
  }

  assertUuid(incoming.orderId);
  assertUuid(incoming.ownerId);
  const reservationAsset = incoming.side === "buy" ? market.quoteAssetCode : market.baseAssetCode;
  assertPositiveQuantity(incoming.amount, reservationAsset);

  const tradeIds = new Set<string>();
  for (const execution of plan.executions) {
    for (const id of [
      execution.tradeId,
      execution.makerOrderId,
      execution.takerOrderId,
      execution.buyerOrderId,
      execution.buyerOwnerId,
      execution.sellerOrderId,
      execution.sellerOwnerId,
    ]) {
      assertUuid(id);
    }
    if (
      tradeIds.has(execution.tradeId) ||
      execution.takerOrderId !== incoming.orderId ||
      execution.makerOrderId === execution.takerOrderId ||
      execution.buyerOrderId === execution.sellerOrderId ||
      execution.buyerOwnerId === execution.sellerOwnerId ||
      ![execution.buyerOrderId, execution.sellerOrderId].includes(execution.makerOrderId) ||
      ![execution.buyerOrderId, execution.sellerOrderId].includes(execution.takerOrderId)
    ) {
      invalidPlan();
    }
    if (
      (incoming.side === "buy" &&
        (execution.buyerOrderId !== incoming.orderId ||
          execution.buyerOwnerId !== incoming.ownerId)) ||
      (incoming.side === "sell" &&
        (execution.sellerOrderId !== incoming.orderId ||
          execution.sellerOwnerId !== incoming.ownerId))
    ) {
      invalidPlan();
    }

    assertPositiveQuantity(execution.baseQuantity, market.baseAssetCode);
    assertPositiveQuantity(execution.executionQuote, market.quoteAssetCode);
    assertPositiveQuantity(execution.buyerReservedQuoteReduction, market.quoteAssetCode);
    if (execution.buyerReservedQuoteReduction.atomicUnits < execution.executionQuote.atomicUnits) {
      invalidPlan();
    }
    tradeIds.add(execution.tradeId);
  }

  if (plan.terminalReleaseReason !== undefined) {
    const executedReservation = plan.executions.reduce(
      (total, execution) =>
        total +
        (incoming.side === "buy"
          ? execution.buyerReservedQuoteReduction.atomicUnits
          : execution.baseQuantity.atomicUnits),
      0n,
    );
    if (executedReservation >= incoming.amount.atomicUnits) {
      invalidPlan();
    }
  }
}

function assertReleaseCommand(command: ReleaseTradingOrderReservationCommand): void {
  assertUuid(command.orderId);
  assertUuid(command.ownerId);
  if (!/^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$/.test(command.marketCode)) {
    invalidPlan();
  }
}

export class FinancialTradingFunds implements TradingFundsCapability {
  public constructor(private readonly transaction: TradingFundsTransaction) {}

  public applyPlacementEffects(
    plan: ApplyTradingPlacementEffectsPlan,
  ): Promise<ApplyTradingPlacementEffectsResult> {
    assertPlan(plan);
    return this.transaction.applyPlacementEffects(plan);
  }

  public releaseOrderReservation(
    command: ReleaseTradingOrderReservationCommand,
  ): Promise<ReleaseTradingOrderReservationResult> {
    assertReleaseCommand(command);
    return this.transaction.releaseOrderReservation(command);
  }
}
