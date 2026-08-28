import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { marketDataCandleIntervals } from "@atlas/contracts";

import {
  candleIntervalDefinitions,
  getCandleBucket,
  ProjectCandles,
  type CandleInterval,
  type CandleProjectionCheckpoint,
  type CandleProjectionCheckpointReader,
  type CandleProjectionTransaction,
  type CandleProjectionTransactionRunner,
  type CandleTradeContribution,
} from "../src/modules/market-data/index.js";
import {
  parseMarketCode,
  type MarketCode,
  type TradingOrderStateFact,
  type TradingPublicationFact,
  type TradingPublicationFactPageInput,
  type TradingPublicationFactReader,
  type TradingTradeExecutedFact,
} from "../src/modules/trading/index.js";

interface AggregateCandle {
  interval: CandleInterval;
  bucketStart: Date;
  bucketEnd: Date;
  openExecutionSequence: bigint;
  closeExecutionSequence: bigint;
  openPriceTicks: bigint;
  highPriceTicks: bigint;
  lowPriceTicks: bigint;
  closePriceTicks: bigint;
  baseVolumeLots: bigint;
  quoteVolumeTickLots: bigint;
  tradeCount: bigint;
  lastSequence: bigint;
}

interface CandleState {
  checkpoint: CandleProjectionCheckpoint;
  candles: Map<string, AggregateCandle>;
}

function candleKey(contribution: CandleTradeContribution): string {
  return `${contribution.interval}:${contribution.bucketStart.toISOString()}`;
}

function cloneState(state: CandleState): CandleState {
  return {
    checkpoint: { ...state.checkpoint },
    candles: new Map(
      [...state.candles].map(([key, candle]) => [
        key,
        {
          ...candle,
          bucketStart: new Date(candle.bucketStart),
          bucketEnd: new Date(candle.bucketEnd),
        },
      ]),
    ),
  };
}

class InMemoryCandleTransaction implements CandleProjectionTransaction {
  public constructor(private readonly state: CandleState) {}

  public getCheckpoint(): Promise<CandleProjectionCheckpoint> {
    return Promise.resolve(this.state.checkpoint);
  }

  public applyTrade(contributions: readonly CandleTradeContribution[]): Promise<void> {
    for (const contribution of contributions) {
      const key = candleKey(contribution);
      const current = this.state.candles.get(key);
      if (current === undefined) {
        this.state.candles.set(key, {
          interval: contribution.interval,
          bucketStart: contribution.bucketStart,
          bucketEnd: contribution.bucketEnd,
          openExecutionSequence: contribution.executionSequence,
          closeExecutionSequence: contribution.executionSequence,
          openPriceTicks: contribution.priceTicks,
          highPriceTicks: contribution.priceTicks,
          lowPriceTicks: contribution.priceTicks,
          closePriceTicks: contribution.priceTicks,
          baseVolumeLots: contribution.quantityLots,
          quoteVolumeTickLots: contribution.quoteVolumeTickLots,
          tradeCount: 1n,
          lastSequence: contribution.marketSequence,
        });
        continue;
      }
      this.state.candles.set(key, {
        ...current,
        openExecutionSequence:
          contribution.executionSequence < current.openExecutionSequence
            ? contribution.executionSequence
            : current.openExecutionSequence,
        closeExecutionSequence:
          contribution.executionSequence > current.closeExecutionSequence
            ? contribution.executionSequence
            : current.closeExecutionSequence,
        openPriceTicks:
          contribution.executionSequence < current.openExecutionSequence
            ? contribution.priceTicks
            : current.openPriceTicks,
        highPriceTicks:
          contribution.priceTicks > current.highPriceTicks
            ? contribution.priceTicks
            : current.highPriceTicks,
        lowPriceTicks:
          contribution.priceTicks < current.lowPriceTicks
            ? contribution.priceTicks
            : current.lowPriceTicks,
        closePriceTicks:
          contribution.executionSequence > current.closeExecutionSequence
            ? contribution.priceTicks
            : current.closePriceTicks,
        baseVolumeLots: current.baseVolumeLots + contribution.quantityLots,
        quoteVolumeTickLots: current.quoteVolumeTickLots + contribution.quoteVolumeTickLots,
        tradeCount: current.tradeCount + 1n,
        lastSequence:
          contribution.marketSequence > current.lastSequence
            ? contribution.marketSequence
            : current.lastSequence,
      });
    }
    return Promise.resolve();
  }

  public advanceCheckpoint(input: {
    readonly expectedPreviousSequence: bigint;
    readonly lastSequence: bigint;
    readonly lastOccurredAt: Date;
  }): Promise<void> {
    if (this.state.checkpoint.lastSequence !== input.expectedPreviousSequence) {
      throw new Error("Checkpoint comparison failed");
    }
    this.state.checkpoint = {
      lastSequence: input.lastSequence,
      lastOccurredAt: input.lastOccurredAt,
    };
    return Promise.resolve();
  }
}

class InMemoryCandleStore
  implements CandleProjectionCheckpointReader, CandleProjectionTransactionRunner
{
  public state: CandleState = {
    checkpoint: { lastSequence: 0n, lastOccurredAt: null },
    candles: new Map(),
  };

  public getCheckpoint(_marketCode: MarketCode): Promise<CandleProjectionCheckpoint> {
    return Promise.resolve(this.state.checkpoint);
  }

  public async run<T>(
    _marketCode: MarketCode,
    operation: (transaction: CandleProjectionTransaction) => Promise<T>,
  ): Promise<T> {
    const candidate = cloneState(this.state);
    const result = await operation(new InMemoryCandleTransaction(candidate));
    this.state = candidate;
    return result;
  }
}

class StubFactReader implements TradingPublicationFactReader {
  public constructor(
    private readonly facts: readonly TradingPublicationFact[],
    private readonly replayAll = false,
  ) {}

  public listAfter(
    input: TradingPublicationFactPageInput,
  ): Promise<readonly TradingPublicationFact[]> {
    return Promise.resolve(
      this.facts
        .filter((fact) => this.replayAll || fact.marketSequence > input.afterSequence)
        .slice(0, input.limit),
    );
  }
}

const btcUsd = parseMarketCode("BTC-USD");
const ethUsd = parseMarketCode("ETH-USD");
const baseTime = new Date("2026-08-28T12:00:00.000Z");

function orderFact(sequence: bigint, marketCode = btcUsd): TradingOrderStateFact {
  return {
    id: randomUUID(),
    marketCode,
    marketSequence: sequence,
    kind: "order_state",
    schemaVersion: 1,
    payload: {
      orderId: randomUUID(),
      side: "buy",
      limitPriceTicks: "100",
      remainingLots: "2",
      status: "open",
      terminalReason: null,
    },
    occurredAt: new Date(baseTime.getTime() + Number(sequence) * 1_000),
    createdAt: baseTime,
  };
}

function tradeFact(
  sequence: bigint,
  input: {
    readonly marketCode?: MarketCode;
    readonly executionSequence?: bigint;
    readonly priceTicks?: bigint;
    readonly quantityLots?: bigint;
    readonly occurredAt?: Date;
  } = {},
): TradingTradeExecutedFact {
  return {
    id: randomUUID(),
    marketCode: input.marketCode ?? btcUsd,
    marketSequence: sequence,
    kind: "trade_executed",
    schemaVersion: 1,
    payload: {
      tradeId: randomUUID(),
      executionSequence: (input.executionSequence ?? sequence).toString(),
      priceTicks: (input.priceTicks ?? 100n).toString(),
      quantityLots: (input.quantityLots ?? 1n).toString(),
    },
    occurredAt: input.occurredAt ?? new Date(baseTime.getTime() + Number(sequence) * 1_000),
    createdAt: baseTime,
  };
}

describe("Candle projection", () => {
  it("aligns every supported interval to the Unix UTC epoch", () => {
    expect(candleIntervalDefinitions.map(({ interval }) => interval)).toEqual(
      marketDataCandleIntervals,
    );
    const executedAt = new Date("2026-08-28T13:37:42.123Z");
    expect(
      candleIntervalDefinitions.map(({ interval }) => {
        const bucket = getCandleBucket(executedAt, interval);
        return {
          interval,
          start: bucket.start.toISOString(),
          end: bucket.end.toISOString(),
        };
      }),
    ).toEqual([
      { interval: "1m", start: "2026-08-28T13:37:00.000Z", end: "2026-08-28T13:38:00.000Z" },
      { interval: "5m", start: "2026-08-28T13:35:00.000Z", end: "2026-08-28T13:40:00.000Z" },
      { interval: "15m", start: "2026-08-28T13:30:00.000Z", end: "2026-08-28T13:45:00.000Z" },
      { interval: "1h", start: "2026-08-28T13:00:00.000Z", end: "2026-08-28T14:00:00.000Z" },
      { interval: "4h", start: "2026-08-28T12:00:00.000Z", end: "2026-08-28T16:00:00.000Z" },
      { interval: "1d", start: "2026-08-28T00:00:00.000Z", end: "2026-08-29T00:00:00.000Z" },
    ]);
    expect(() => getCandleBucket(new Date(Number.NaN), "1m")).toThrow(RangeError);
  });

  it("builds exact sparse OHLCV candles and checkpoints non-trade facts", async () => {
    const facts = [
      orderFact(1n),
      tradeFact(2n, {
        executionSequence: 20n,
        priceTicks: 100n,
        quantityLots: 2n,
        occurredAt: new Date("2026-08-28T12:00:50.000Z"),
      }),
      tradeFact(3n, {
        executionSequence: 10n,
        priceTicks: 90n,
        quantityLots: 3n,
        occurredAt: new Date("2026-08-28T12:00:10.000Z"),
      }),
      tradeFact(4n, {
        executionSequence: 30n,
        priceTicks: 110n,
        quantityLots: 1n,
        occurredAt: new Date("2026-08-28T12:00:20.000Z"),
      }),
      tradeFact(5n, {
        executionSequence: 40n,
        priceTicks: 120n,
        quantityLots: 2n,
        occurredAt: new Date("2026-08-28T12:02:00.000Z"),
      }),
    ];
    const store = new InMemoryCandleStore();
    const projector = new ProjectCandles(new StubFactReader(facts, true), store, store);

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 5,
      appliedCount: 5,
      appliedTradeCount: 4,
      updatedCandleCount: 24,
      lastSequence: 5n,
      caughtUp: true,
    });
    expect(store.state.candles.size).toBe(7);
    expect(store.state.candles.has("1m:2026-08-28T12:01:00.000Z")).toBe(false);
    expect(store.state.candles.get("1m:2026-08-28T12:00:00.000Z")).toMatchObject({
      openExecutionSequence: 10n,
      closeExecutionSequence: 30n,
      openPriceTicks: 90n,
      highPriceTicks: 110n,
      lowPriceTicks: 90n,
      closePriceTicks: 110n,
      baseVolumeLots: 6n,
      quoteVolumeTickLots: 580n,
      tradeCount: 3n,
      lastSequence: 4n,
    });
    expect(store.state.checkpoint).toEqual({
      lastSequence: 5n,
      lastOccurredAt: new Date("2026-08-28T12:02:00.000Z"),
    });

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 5,
      appliedCount: 0,
      appliedTradeCount: 0,
      updatedCandleCount: 0,
      lastSequence: 5n,
      caughtUp: true,
    });
    expect(store.state.candles.size).toBe(7);
  });

  it("rolls back candle changes and checkpoint together on a sequence gap", async () => {
    const store = new InMemoryCandleStore();
    const projector = new ProjectCandles(
      new StubFactReader([tradeFact(1n), tradeFact(3n)]),
      store,
      store,
    );
    await expect(projector.execute({ marketCode: btcUsd })).rejects.toMatchObject({
      issue: "SEQUENCE_GAP",
    });
    expect(store.state).toEqual({
      checkpoint: { lastSequence: 0n, lastOccurredAt: null },
      candles: new Map(),
    });
  });

  it("rejects cross-market facts and invalid batch boundaries", async () => {
    const store = new InMemoryCandleStore();
    const projector = new ProjectCandles(
      new StubFactReader([orderFact(1n), tradeFact(2n, { marketCode: ethUsd })]),
      store,
      store,
    );
    await expect(projector.execute({ marketCode: btcUsd })).rejects.toMatchObject({
      issue: "FACT_MARKET_MISMATCH",
    });
    await expect(projector.execute({ marketCode: btcUsd, limit: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(store.state.candles.size).toBe(0);
  });
});
