import type { Order, OrderId } from "./order.js";
import { TradingInvariantError } from "./trading-invariant-error.js";

export interface MatchExecution {
  readonly position: number;
  readonly makerOrderId: OrderId;
  readonly takerOrderId: OrderId;
  readonly buyerOrderId: OrderId;
  readonly sellerOrderId: OrderId;
  readonly quantityLots: bigint;
  readonly priceTicks: bigint;
}

export interface MatchResult {
  readonly incomingOrder: Order;
  readonly updatedMakers: readonly Order[];
  readonly executions: readonly MatchExecution[];
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMakerPriority(incoming: Order, left: Order, right: Order): number {
  const priceComparison =
    incoming.side === "buy"
      ? compareBigInt(left.limitPrice.ticks, right.limitPrice.ticks)
      : compareBigInt(right.limitPrice.ticks, left.limitPrice.ticks);
  if (priceComparison !== 0) {
    return priceComparison;
  }

  const priorityComparison = compareBigInt(left.priority, right.priority);
  if (priorityComparison !== 0) {
    return priorityComparison;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function crosses(incoming: Order, maker: Order): boolean {
  return incoming.side === "buy"
    ? incoming.limitPrice.ticks >= maker.limitPrice.ticks
    : incoming.limitPrice.ticks <= maker.limitPrice.ticks;
}

function requireUniqueOrderIds(incoming: Order, restingOrders: readonly Order[]): void {
  const orderIds = new Set<OrderId>([incoming.id]);
  for (const order of restingOrders) {
    if (orderIds.has(order.id)) {
      throw new TradingInvariantError("MATCH_DUPLICATE_ORDER_ID");
    }
    orderIds.add(order.id);
  }
}

function createExecution(
  position: number,
  incoming: Order,
  maker: Order,
  quantityLots: bigint,
): MatchExecution {
  const incomingIsBuyer = incoming.side === "buy";
  return Object.freeze({
    position,
    makerOrderId: maker.id,
    takerOrderId: incoming.id,
    buyerOrderId: incomingIsBuyer ? incoming.id : maker.id,
    sellerOrderId: incomingIsBuyer ? maker.id : incoming.id,
    quantityLots,
    priceTicks: maker.limitPrice.ticks,
  });
}

export function matchIncomingOrder(
  incomingOrder: Order,
  restingOrders: readonly Order[],
): MatchResult {
  if (!incomingOrder.isActive) {
    throw new TradingInvariantError("MATCH_INCOMING_ORDER_NOT_ACTIVE");
  }
  requireUniqueOrderIds(incomingOrder, restingOrders);
  if (restingOrders.some(({ marketCode }) => marketCode !== incomingOrder.marketCode)) {
    throw new TradingInvariantError("ORDER_MARKET_MISMATCH");
  }

  const makers = restingOrders
    .filter(
      (order) =>
        order.isActive && order.side !== incomingOrder.side && crosses(incomingOrder, order),
    )
    .slice()
    .sort((left, right) => compareMakerPriority(incomingOrder, left, right));

  let incoming = incomingOrder;
  const updatedMakers: Order[] = [];
  const executions: MatchExecution[] = [];

  for (const maker of makers) {
    if (!incoming.isActive) {
      break;
    }
    if (maker.ownerId === incoming.ownerId) {
      incoming = incoming.cancel("self_trade_prevention");
      break;
    }

    const quantityLots =
      incoming.remainingLots < maker.remainingLots ? incoming.remainingLots : maker.remainingLots;
    const execution = createExecution(executions.length + 1, incoming, maker, quantityLots);
    incoming = incoming.applyFill(quantityLots);
    updatedMakers.push(maker.applyFill(quantityLots));
    executions.push(execution);
  }

  return Object.freeze({
    incomingOrder: incoming,
    updatedMakers: Object.freeze(updatedMakers),
    executions: Object.freeze(executions),
  });
}
