import { parseOrderId, parseOrderOwnerId, type OrderStatus } from "../domain/order.js";
import { TradingInvariantError } from "../domain/trading-invariant-error.js";
import type {
  PersistedTradingOrder,
  TradingPersistenceTransaction,
  TradingTransactionRunner,
} from "./trading-transaction.js";

export interface CancelOrderCommand {
  readonly ownerId: string;
  readonly orderId: string;
}

export type CancelOrderResult =
  | {
      readonly status: "cancelled" | "existing";
      readonly order: PersistedTradingOrder;
    }
  | { readonly status: "order_not_found" }
  | { readonly status: "not_owner" }
  | {
      readonly status: "order_not_cancellable";
      readonly orderStatus: OrderStatus;
    };

async function persistOwnerCancellation(
  trading: TradingPersistenceTransaction,
  order: PersistedTradingOrder,
): Promise<PersistedTradingOrder> {
  const persisted = await trading.persistOrderState({
    orderId: order.id,
    expectedVersion: order.version,
    filledLots: order.filledLots,
    remainingLots: order.remainingLots,
    status: "cancelled",
    terminalReason: "owner_cancelled",
    version: order.version + 1n,
  });
  if (!persisted) {
    throw new TradingInvariantError("CANCELLATION_STATE_INVALID");
  }
  const cancelled = await trading.lockOrder(order.id);
  if (
    cancelled === undefined ||
    cancelled.status !== "cancelled" ||
    cancelled.terminalReason !== "owner_cancelled" ||
    cancelled.version !== order.version + 1n
  ) {
    throw new TradingInvariantError("CANCELLATION_STATE_INVALID");
  }
  return cancelled;
}

export class CancelOrder {
  public constructor(private readonly transactionRunner: TradingTransactionRunner) {}

  public execute(command: CancelOrderCommand): Promise<CancelOrderResult> {
    const ownerId = parseOrderOwnerId(command.ownerId.toLowerCase());
    const orderId = parseOrderId(command.orderId.toLowerCase());

    return this.transactionRunner.execute(async ({ trading, financial }) => {
      const discovered = await trading.findOrder(orderId);
      if (discovered === undefined) {
        return { status: "order_not_found" };
      }
      const market = await trading.lockMarket(discovered.marketCode);
      if (market === undefined) {
        throw new TradingInvariantError("CANCELLATION_STATE_INVALID");
      }
      const order = await trading.lockOrder(orderId);
      if (order === undefined || order.marketCode !== market.code) {
        throw new TradingInvariantError("CANCELLATION_STATE_INVALID");
      }
      if (order.ownerId !== ownerId) {
        return { status: "not_owner" };
      }

      if (order.status === "cancelled" && order.terminalReason === "owner_cancelled") {
        const release = await financial.releaseOrderReservation({
          orderId: order.id,
          ownerId: order.ownerId,
          marketCode: order.marketCode,
          reason: "owner_cancelled",
        });
        if (release.status !== "existing") {
          throw new TradingInvariantError("CANCELLATION_RELEASE_CONFLICT");
        }
        return { status: "existing", order };
      }
      if (order.status !== "open" && order.status !== "partially_filled") {
        return { status: "order_not_cancellable", orderStatus: order.status };
      }
      if (order.remainingLots <= 0n) {
        throw new TradingInvariantError("CANCELLATION_STATE_INVALID");
      }

      const cancelled = await persistOwnerCancellation(trading, order);
      const release = await financial.releaseOrderReservation({
        orderId: order.id,
        ownerId: order.ownerId,
        marketCode: order.marketCode,
        reason: "owner_cancelled",
      });
      if (release.status !== "released") {
        throw new TradingInvariantError("CANCELLATION_RELEASE_CONFLICT");
      }
      return { status: "cancelled", order: cancelled };
    });
  }
}
