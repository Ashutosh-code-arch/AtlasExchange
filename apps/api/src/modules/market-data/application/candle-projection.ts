import type {
  MarketCode,
  TradingPublicationFactReader,
  TradingTradeExecutedFact,
} from "../../trading/index.js";
import {
  defaultMarketDataProjectionBatchSize,
  maximumMarketDataProjectionBatchSize,
} from "./level-two-order-book-projection.js";

export const candleProjectionName = "candles" as const;

export const candleIntervalDefinitions = [
  { interval: "1m", durationMilliseconds: 60_000 },
  { interval: "5m", durationMilliseconds: 5 * 60_000 },
  { interval: "15m", durationMilliseconds: 15 * 60_000 },
  { interval: "1h", durationMilliseconds: 60 * 60_000 },
  { interval: "4h", durationMilliseconds: 4 * 60 * 60_000 },
  { interval: "1d", durationMilliseconds: 24 * 60 * 60_000 },
] as const;

export type CandleInterval = (typeof candleIntervalDefinitions)[number]["interval"];

export interface CandleBucket {
  readonly start: Date;
  readonly end: Date;
}

export interface CandleProjectionCheckpoint {
  readonly lastSequence: bigint;
  readonly lastOccurredAt: Date | null;
}

export interface CandleTradeContribution {
  readonly interval: CandleInterval;
  readonly bucketStart: Date;
  readonly bucketEnd: Date;
  readonly marketSequence: bigint;
  readonly executionSequence: bigint;
  readonly priceTicks: bigint;
  readonly quantityLots: bigint;
  readonly quoteVolumeTickLots: bigint;
  readonly executedAt: Date;
}

export interface CandleProjectionCheckpointReader {
  getCheckpoint(marketCode: MarketCode): Promise<CandleProjectionCheckpoint>;
}

export interface CandleProjectionTransaction {
  getCheckpoint(): Promise<CandleProjectionCheckpoint>;
  applyTrade(contributions: readonly CandleTradeContribution[]): Promise<void>;
  advanceCheckpoint(input: {
    readonly expectedPreviousSequence: bigint;
    readonly lastSequence: bigint;
    readonly lastOccurredAt: Date;
  }): Promise<void>;
}

export interface CandleProjectionTransactionRunner {
  run<T>(
    marketCode: MarketCode,
    operation: (transaction: CandleProjectionTransaction) => Promise<T>,
  ): Promise<T>;
}

export type CandleProjectionIssue = "CHECKPOINT_CONFLICT" | "FACT_MARKET_MISMATCH" | "SEQUENCE_GAP";

export class CandleProjectionError extends Error {
  public constructor(
    public readonly issue: CandleProjectionIssue,
    message: string,
  ) {
    super(message);
    this.name = "CandleProjectionError";
  }
}

export interface ProjectCandlesInput {
  readonly marketCode: MarketCode;
  readonly limit?: number;
}

export interface ProjectCandlesResult {
  readonly readCount: number;
  readonly appliedCount: number;
  readonly appliedTradeCount: number;
  readonly updatedCandleCount: number;
  readonly lastSequence: bigint;
  readonly caughtUp: boolean;
}

export function getCandleBucket(executedAt: Date, interval: CandleInterval): CandleBucket {
  const timestamp = executedAt.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("Candle execution time is invalid.");
  }
  const definition = candleIntervalDefinitions.find((candidate) => candidate.interval === interval);
  if (definition === undefined) {
    throw new RangeError("Candle interval is unsupported.");
  }
  const start =
    Math.floor(timestamp / definition.durationMilliseconds) * definition.durationMilliseconds;
  return {
    start: new Date(start),
    end: new Date(start + definition.durationMilliseconds),
  };
}

function toContributions(fact: TradingTradeExecutedFact): readonly CandleTradeContribution[] {
  const priceTicks = BigInt(fact.payload.priceTicks);
  const quantityLots = BigInt(fact.payload.quantityLots);
  const common = {
    marketSequence: fact.marketSequence,
    executionSequence: BigInt(fact.payload.executionSequence),
    priceTicks,
    quantityLots,
    quoteVolumeTickLots: priceTicks * quantityLots,
    executedAt: fact.occurredAt,
  };
  return candleIntervalDefinitions.map(({ interval }) => {
    const bucket = getCandleBucket(fact.occurredAt, interval);
    return {
      ...common,
      interval,
      bucketStart: bucket.start,
      bucketEnd: bucket.end,
    };
  });
}

function validateBatchSize(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumMarketDataProjectionBatchSize) {
    throw new RangeError("Candle projection batch size is invalid.");
  }
}

export class ProjectCandles {
  public constructor(
    private readonly facts: TradingPublicationFactReader,
    private readonly checkpoints: CandleProjectionCheckpointReader,
    private readonly transactions: CandleProjectionTransactionRunner,
  ) {}

  public async execute(input: ProjectCandlesInput): Promise<ProjectCandlesResult> {
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
        appliedTradeCount: 0,
        updatedCandleCount: 0,
        lastSequence: observedCheckpoint.lastSequence,
        caughtUp: true,
      };
    }

    return this.transactions.run(input.marketCode, async (transaction) => {
      const checkpoint = await transaction.getCheckpoint();
      let lastSequence = checkpoint.lastSequence;
      let lastOccurredAt = checkpoint.lastOccurredAt;
      let appliedCount = 0;
      let appliedTradeCount = 0;
      let updatedCandleCount = 0;

      for (const fact of facts) {
        if (fact.marketCode !== input.marketCode) {
          throw new CandleProjectionError(
            "FACT_MARKET_MISMATCH",
            `Fact market ${fact.marketCode} does not match candle market ${input.marketCode}.`,
          );
        }
        if (fact.marketSequence <= lastSequence) continue;
        const expectedSequence = lastSequence + 1n;
        if (fact.marketSequence !== expectedSequence) {
          throw new CandleProjectionError(
            "SEQUENCE_GAP",
            `Expected candle sequence ${expectedSequence}, received ${fact.marketSequence}.`,
          );
        }
        if (fact.kind === "trade_executed") {
          const contributions = toContributions(fact);
          await transaction.applyTrade(contributions);
          appliedTradeCount += 1;
          updatedCandleCount += contributions.length;
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
        appliedTradeCount,
        updatedCandleCount,
        lastSequence,
        caughtUp: facts.length < limit,
      };
    });
  }
}
