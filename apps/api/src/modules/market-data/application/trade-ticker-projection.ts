import type {
  MarketCode,
  TradingPublicationFactReader,
  TradingTradeExecutedFact,
} from "../../trading/index.js";
import {
  defaultMarketDataProjectionBatchSize,
  maximumMarketDataProjectionBatchSize,
} from "./level-two-order-book-projection.js";

export const tradeTickerProjectionName = "trade_ticker" as const;

export interface TradeTickerProjectionCheckpoint {
  readonly lastSequence: bigint;
  readonly lastOccurredAt: Date | null;
}

export interface TradeTickerObservation {
  readonly tradeId: string;
  readonly marketSequence: bigint;
  readonly executionSequence: bigint;
  readonly priceTicks: bigint;
  readonly quantityLots: bigint;
  readonly executedAt: Date;
}

export interface TradeTickerProjectionCheckpointReader {
  getCheckpoint(marketCode: MarketCode): Promise<TradeTickerProjectionCheckpoint>;
}

export interface TradeTickerProjectionTransaction {
  getCheckpoint(): Promise<TradeTickerProjectionCheckpoint>;
  saveTrade(trade: TradeTickerObservation): Promise<void>;
  advanceCheckpoint(input: {
    readonly expectedPreviousSequence: bigint;
    readonly lastSequence: bigint;
    readonly lastOccurredAt: Date;
  }): Promise<void>;
}

export interface TradeTickerProjectionTransactionRunner {
  run<T>(
    marketCode: MarketCode,
    operation: (transaction: TradeTickerProjectionTransaction) => Promise<T>,
  ): Promise<T>;
}

export type TradeTickerProjectionIssue =
  "CHECKPOINT_CONFLICT" | "FACT_MARKET_MISMATCH" | "SEQUENCE_GAP";

export class TradeTickerProjectionError extends Error {
  public constructor(
    public readonly issue: TradeTickerProjectionIssue,
    message: string,
  ) {
    super(message);
    this.name = "TradeTickerProjectionError";
  }
}

export interface ProjectTradeTickerInput {
  readonly marketCode: MarketCode;
  readonly limit?: number;
}

export interface ProjectTradeTickerResult {
  readonly readCount: number;
  readonly appliedCount: number;
  readonly storedTradeCount: number;
  readonly lastSequence: bigint;
  readonly caughtUp: boolean;
}

function toObservation(fact: TradingTradeExecutedFact): TradeTickerObservation {
  return {
    tradeId: fact.payload.tradeId,
    marketSequence: fact.marketSequence,
    executionSequence: BigInt(fact.payload.executionSequence),
    priceTicks: BigInt(fact.payload.priceTicks),
    quantityLots: BigInt(fact.payload.quantityLots),
    executedAt: fact.occurredAt,
  };
}

function validateBatchSize(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumMarketDataProjectionBatchSize) {
    throw new RangeError("Trade ticker projection batch size is invalid.");
  }
}

export class ProjectTradeTicker {
  public constructor(
    private readonly facts: TradingPublicationFactReader,
    private readonly checkpoints: TradeTickerProjectionCheckpointReader,
    private readonly transactions: TradeTickerProjectionTransactionRunner,
  ) {}

  public async execute(input: ProjectTradeTickerInput): Promise<ProjectTradeTickerResult> {
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
        storedTradeCount: 0,
        lastSequence: observedCheckpoint.lastSequence,
        caughtUp: true,
      };
    }

    return this.transactions.run(input.marketCode, async (transaction) => {
      const checkpoint = await transaction.getCheckpoint();
      let lastSequence = checkpoint.lastSequence;
      let lastOccurredAt = checkpoint.lastOccurredAt;
      let appliedCount = 0;
      let storedTradeCount = 0;
      for (const fact of facts) {
        if (fact.marketCode !== input.marketCode) {
          throw new TradeTickerProjectionError(
            "FACT_MARKET_MISMATCH",
            `Fact market ${fact.marketCode} does not match ticker market ${input.marketCode}.`,
          );
        }
        if (fact.marketSequence <= lastSequence) continue;
        const expectedSequence = lastSequence + 1n;
        if (fact.marketSequence !== expectedSequence) {
          throw new TradeTickerProjectionError(
            "SEQUENCE_GAP",
            `Expected ticker sequence ${expectedSequence}, received ${fact.marketSequence}.`,
          );
        }
        if (fact.kind === "trade_executed") {
          await transaction.saveTrade(toObservation(fact));
          storedTradeCount += 1;
        }
        lastSequence = fact.marketSequence;
        lastOccurredAt = fact.occurredAt;
        appliedCount += 1;
      }
      if (appliedCount > 0 && lastOccurredAt !== null) {
        await transaction.advanceCheckpoint({
          expectedPreviousSequence: checkpoint.lastSequence,
          lastSequence,
          lastOccurredAt,
        });
      }
      return {
        readCount: facts.length,
        appliedCount,
        storedTradeCount,
        lastSequence,
        caughtUp: facts.length < limit,
      };
    });
  }
}
