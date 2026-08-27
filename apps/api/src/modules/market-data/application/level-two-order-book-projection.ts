import type {
  MarketCode,
  TradingOrderStateFact,
  TradingPublicationFact,
  TradingPublicationFactReader,
} from "../../trading/index.js";

export const levelTwoOrderBookProjectionName = "level_two_order_book" as const;
export const defaultMarketDataProjectionBatchSize = 250;
export const maximumMarketDataProjectionBatchSize = 1_000;

export type LevelTwoOrderBookSide = "buy" | "sell";

export interface LevelTwoProjectionCheckpoint {
  readonly lastSequence: bigint;
  readonly lastOccurredAt: Date | null;
}

export interface LevelTwoProjectedOrder {
  readonly orderId: string;
  readonly side: LevelTwoOrderBookSide;
  readonly priceTicks: bigint;
  readonly remainingLots: bigint;
  readonly lastSequence: bigint;
  readonly updatedAt: Date;
}

export interface LevelTwoOrderBookLevel {
  readonly side: LevelTwoOrderBookSide;
  readonly priceTicks: bigint;
  readonly aggregateRemainingLots: bigint;
  readonly orderCount: bigint;
  readonly lastSequence: bigint;
  readonly updatedAt: Date;
}

export interface LevelTwoOrderBookSnapshot {
  readonly marketCode: MarketCode;
  readonly sequence: bigint;
  readonly asOf: Date | null;
  readonly bids: readonly LevelTwoOrderBookLevel[];
  readonly asks: readonly LevelTwoOrderBookLevel[];
}

export interface MarketDataProjectionCheckpointReader {
  getCheckpoint(marketCode: MarketCode): Promise<LevelTwoProjectionCheckpoint>;
}

export interface LevelTwoOrderBookReader {
  getSnapshot(marketCode: MarketCode, depth?: number): Promise<LevelTwoOrderBookSnapshot>;
}

export interface LevelTwoProjectionTransaction {
  getCheckpoint(): Promise<LevelTwoProjectionCheckpoint>;
  getProjectedOrder(orderId: string): Promise<LevelTwoProjectedOrder | undefined>;
  getLevel(
    side: LevelTwoOrderBookSide,
    priceTicks: bigint,
  ): Promise<LevelTwoOrderBookLevel | undefined>;
  saveProjectedOrder(order: LevelTwoProjectedOrder): Promise<void>;
  deleteProjectedOrder(orderId: string): Promise<void>;
  saveLevel(level: LevelTwoOrderBookLevel): Promise<void>;
  deleteLevel(side: LevelTwoOrderBookSide, priceTicks: bigint): Promise<void>;
  advanceCheckpoint(input: {
    readonly expectedPreviousSequence: bigint;
    readonly lastSequence: bigint;
    readonly lastOccurredAt: Date;
  }): Promise<void>;
}

export interface LevelTwoProjectionTransactionRunner {
  run<T>(
    marketCode: MarketCode,
    operation: (transaction: LevelTwoProjectionTransaction) => Promise<T>,
  ): Promise<T>;
}

export type MarketDataProjectionIssue =
  "BOOK_INVARIANT_VIOLATION" | "FACT_MARKET_MISMATCH" | "SEQUENCE_GAP";

export class MarketDataProjectionError extends Error {
  public constructor(
    public readonly issue: MarketDataProjectionIssue,
    message: string,
  ) {
    super(message);
    this.name = "MarketDataProjectionError";
  }
}

export interface ProjectLevelTwoOrderBookInput {
  readonly marketCode: MarketCode;
  readonly limit?: number;
}

export interface ProjectLevelTwoOrderBookResult {
  readonly readCount: number;
  readonly appliedCount: number;
  readonly lastSequence: bigint;
  readonly caughtUp: boolean;
}

function isActiveOrder(fact: TradingOrderStateFact): boolean {
  return fact.payload.status === "open" || fact.payload.status === "partially_filled";
}

function bookInvariant(message: string): never {
  throw new MarketDataProjectionError("BOOK_INVARIANT_VIOLATION", message);
}

async function applyLevelDelta(
  transaction: LevelTwoProjectionTransaction,
  input: {
    readonly side: LevelTwoOrderBookSide;
    readonly priceTicks: bigint;
    readonly quantityDelta: bigint;
    readonly orderCountDelta: bigint;
    readonly sequence: bigint;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const current = await transaction.getLevel(input.side, input.priceTicks);
  const aggregateRemainingLots = (current?.aggregateRemainingLots ?? 0n) + input.quantityDelta;
  const orderCount = (current?.orderCount ?? 0n) + input.orderCountDelta;
  if (aggregateRemainingLots < 0n || orderCount < 0n) {
    bookInvariant("A level-two aggregate cannot become negative.");
  }
  if ((aggregateRemainingLots === 0n) !== (orderCount === 0n)) {
    bookInvariant("A level-two aggregate quantity and order count must become empty together.");
  }
  if (aggregateRemainingLots === 0n) {
    await transaction.deleteLevel(input.side, input.priceTicks);
    return;
  }
  await transaction.saveLevel({
    side: input.side,
    priceTicks: input.priceTicks,
    aggregateRemainingLots,
    orderCount,
    lastSequence: input.sequence,
    updatedAt: input.occurredAt,
  });
}

async function applyOrderState(
  transaction: LevelTwoProjectionTransaction,
  fact: TradingOrderStateFact,
): Promise<void> {
  const current = await transaction.getProjectedOrder(fact.payload.orderId);
  if (current !== undefined) {
    await applyLevelDelta(transaction, {
      side: current.side,
      priceTicks: current.priceTicks,
      quantityDelta: -current.remainingLots,
      orderCountDelta: -1n,
      sequence: fact.marketSequence,
      occurredAt: fact.occurredAt,
    });
    await transaction.deleteProjectedOrder(current.orderId);
  }
  if (!isActiveOrder(fact)) {
    return;
  }
  const projectedOrder: LevelTwoProjectedOrder = {
    orderId: fact.payload.orderId,
    side: fact.payload.side,
    priceTicks: BigInt(fact.payload.limitPriceTicks),
    remainingLots: BigInt(fact.payload.remainingLots),
    lastSequence: fact.marketSequence,
    updatedAt: fact.occurredAt,
  };
  await applyLevelDelta(transaction, {
    side: projectedOrder.side,
    priceTicks: projectedOrder.priceTicks,
    quantityDelta: projectedOrder.remainingLots,
    orderCountDelta: 1n,
    sequence: fact.marketSequence,
    occurredAt: fact.occurredAt,
  });
  await transaction.saveProjectedOrder(projectedOrder);
}

async function applyFact(
  transaction: LevelTwoProjectionTransaction,
  fact: TradingPublicationFact,
): Promise<void> {
  if (fact.kind === "order_state") {
    await applyOrderState(transaction, fact);
  }
}

function validateBatchSize(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumMarketDataProjectionBatchSize) {
    throw new RangeError("Market Data projection batch size is invalid.");
  }
}

export class ProjectLevelTwoOrderBook {
  public constructor(
    private readonly facts: TradingPublicationFactReader,
    private readonly checkpoints: MarketDataProjectionCheckpointReader,
    private readonly transactions: LevelTwoProjectionTransactionRunner,
  ) {}

  public async execute(
    input: ProjectLevelTwoOrderBookInput,
  ): Promise<ProjectLevelTwoOrderBookResult> {
    const limit = input.limit ?? defaultMarketDataProjectionBatchSize;
    validateBatchSize(limit);
    const observedCheckpoint = await this.checkpoints.getCheckpoint(input.marketCode);
    const facts = await this.facts.listAfter({
      marketCode: input.marketCode,
      afterSequence: observedCheckpoint.lastSequence,
      limit,
    });
    if (facts.length === 0) {
      return {
        readCount: 0,
        appliedCount: 0,
        lastSequence: observedCheckpoint.lastSequence,
        caughtUp: true,
      };
    }

    return this.transactions.run(input.marketCode, async (transaction) => {
      const durableCheckpoint = await transaction.getCheckpoint();
      let lastSequence = durableCheckpoint.lastSequence;
      let lastOccurredAt = durableCheckpoint.lastOccurredAt;
      let appliedCount = 0;
      for (const fact of facts) {
        if (fact.marketCode !== input.marketCode) {
          throw new MarketDataProjectionError(
            "FACT_MARKET_MISMATCH",
            `Fact market ${fact.marketCode} does not match projection market ${input.marketCode}.`,
          );
        }
        if (fact.marketSequence <= lastSequence) {
          continue;
        }
        const expectedSequence = lastSequence + 1n;
        if (fact.marketSequence !== expectedSequence) {
          throw new MarketDataProjectionError(
            "SEQUENCE_GAP",
            `Expected Market Data sequence ${expectedSequence}, received ${fact.marketSequence}.`,
          );
        }
        await applyFact(transaction, fact);
        lastSequence = fact.marketSequence;
        lastOccurredAt = fact.occurredAt;
        appliedCount += 1;
      }
      if (appliedCount > 0 && lastOccurredAt !== null) {
        await transaction.advanceCheckpoint({
          expectedPreviousSequence: durableCheckpoint.lastSequence,
          lastSequence,
          lastOccurredAt,
        });
      }
      return {
        readCount: facts.length,
        appliedCount,
        lastSequence,
        caughtUp: facts.length < limit,
      };
    });
  }
}
