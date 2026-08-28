import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ProjectTradeTicker,
  type TradeTickerObservation,
  type TradeTickerProjectionCheckpoint,
  type TradeTickerProjectionCheckpointReader,
  type TradeTickerProjectionTransaction,
  type TradeTickerProjectionTransactionRunner,
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

interface TickerState {
  checkpoint: TradeTickerProjectionCheckpoint;
  trades: Map<string, TradeTickerObservation>;
}

function cloneState(state: TickerState): TickerState {
  return {
    checkpoint: { ...state.checkpoint },
    trades: new Map([...state.trades].map(([key, trade]) => [key, { ...trade }])),
  };
}

class InMemoryTickerTransaction implements TradeTickerProjectionTransaction {
  public constructor(private readonly state: TickerState) {}

  public getCheckpoint(): Promise<TradeTickerProjectionCheckpoint> {
    return Promise.resolve(this.state.checkpoint);
  }

  public saveTrade(trade: TradeTickerObservation): Promise<void> {
    if (this.state.trades.has(trade.tradeId)) throw new Error("Duplicate ticker trade");
    this.state.trades.set(trade.tradeId, trade);
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

class InMemoryTickerStore
  implements TradeTickerProjectionCheckpointReader, TradeTickerProjectionTransactionRunner
{
  public state: TickerState = {
    checkpoint: { lastSequence: 0n, lastOccurredAt: null },
    trades: new Map(),
  };

  public getCheckpoint(_marketCode: MarketCode): Promise<TradeTickerProjectionCheckpoint> {
    return Promise.resolve(this.state.checkpoint);
  }

  public async run<T>(
    _marketCode: MarketCode,
    operation: (transaction: TradeTickerProjectionTransaction) => Promise<T>,
  ): Promise<T> {
    const candidate = cloneState(this.state);
    const result = await operation(new InMemoryTickerTransaction(candidate));
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
const baseTime = new Date("2026-08-28T10:00:00.000Z");

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
    readonly tradeId?: string;
    readonly executionSequence?: bigint;
    readonly priceTicks?: bigint;
    readonly quantityLots?: bigint;
  } = {},
): TradingTradeExecutedFact {
  return {
    id: randomUUID(),
    marketCode: input.marketCode ?? btcUsd,
    marketSequence: sequence,
    kind: "trade_executed",
    schemaVersion: 1,
    payload: {
      tradeId: input.tradeId ?? randomUUID(),
      executionSequence: (input.executionSequence ?? sequence).toString(),
      priceTicks: (input.priceTicks ?? 100n).toString(),
      quantityLots: (input.quantityLots ?? 3n).toString(),
    },
    occurredAt: new Date(baseTime.getTime() + Number(sequence) * 1_000),
    createdAt: baseTime,
  };
}

describe("Trade ticker projection", () => {
  it("stores exact trades while checkpointing every contiguous market fact", async () => {
    const firstTrade = tradeFact(2n, {
      executionSequence: 10n,
      priceTicks: 5_000n,
      quantityLots: 4n,
    });
    const secondTrade = tradeFact(4n, {
      executionSequence: 11n,
      priceTicks: 5_010n,
      quantityLots: 2n,
    });
    const facts = [orderFact(1n), firstTrade, orderFact(3n), secondTrade];
    const store = new InMemoryTickerStore();
    const projector = new ProjectTradeTicker(new StubFactReader(facts, true), store, store);

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 4,
      appliedCount: 4,
      storedTradeCount: 2,
      lastSequence: 4n,
      caughtUp: true,
    });
    expect([...store.state.trades.values()]).toEqual([
      {
        tradeId: firstTrade.payload.tradeId,
        marketSequence: 2n,
        executionSequence: 10n,
        priceTicks: 5_000n,
        quantityLots: 4n,
        executedAt: new Date("2026-08-28T10:00:02.000Z"),
      },
      {
        tradeId: secondTrade.payload.tradeId,
        marketSequence: 4n,
        executionSequence: 11n,
        priceTicks: 5_010n,
        quantityLots: 2n,
        executedAt: new Date("2026-08-28T10:00:04.000Z"),
      },
    ]);
    expect(store.state.checkpoint).toEqual({
      lastSequence: 4n,
      lastOccurredAt: new Date("2026-08-28T10:00:04.000Z"),
    });

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 4,
      appliedCount: 0,
      storedTradeCount: 0,
      lastSequence: 4n,
      caughtUp: true,
    });
    expect(store.state.trades.size).toBe(2);
  });

  it("rolls back trades and checkpoint together on a sequence gap", async () => {
    const store = new InMemoryTickerStore();
    const projector = new ProjectTradeTicker(
      new StubFactReader([tradeFact(1n), tradeFact(3n)]),
      store,
      store,
    );
    await expect(projector.execute({ marketCode: btcUsd })).rejects.toMatchObject({
      issue: "SEQUENCE_GAP",
    });
    expect(store.state).toEqual({
      checkpoint: { lastSequence: 0n, lastOccurredAt: null },
      trades: new Map(),
    });
  });

  it("rejects cross-market facts and invalid batch boundaries", async () => {
    const store = new InMemoryTickerStore();
    const projector = new ProjectTradeTicker(
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
    expect(store.state.trades.size).toBe(0);
  });
});
