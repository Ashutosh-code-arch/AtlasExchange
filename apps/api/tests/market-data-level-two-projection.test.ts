import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ProjectLevelTwoOrderBook,
  type LevelTwoOrderBookLevel,
  type LevelTwoProjectedOrder,
  type LevelTwoProjectionCheckpoint,
  type LevelTwoProjectionTransaction,
  type LevelTwoProjectionTransactionRunner,
  type MarketDataProjectionCheckpointReader,
  type MarketDataProjectionError,
} from "../src/modules/market-data/index.js";
import {
  parseMarketCode,
  type MarketCode,
  type TradingOrderStateFact,
  type TradingPublicationFact,
  type TradingPublicationFactPageInput,
  type TradingPublicationFactReader,
} from "../src/modules/trading/index.js";

interface ProjectionState {
  checkpoint: LevelTwoProjectionCheckpoint;
  levels: Map<string, LevelTwoOrderBookLevel>;
  orders: Map<string, LevelTwoProjectedOrder>;
}

function cloneState(state: ProjectionState): ProjectionState {
  return {
    checkpoint: { ...state.checkpoint },
    levels: new Map([...state.levels].map(([key, level]) => [key, { ...level }])),
    orders: new Map([...state.orders].map(([key, order]) => [key, { ...order }])),
  };
}

function levelKey(side: "buy" | "sell", priceTicks: bigint): string {
  return `${side}:${priceTicks}`;
}

class InMemoryProjectionTransaction implements LevelTwoProjectionTransaction {
  public constructor(private readonly state: ProjectionState) {}

  public getCheckpoint(): Promise<LevelTwoProjectionCheckpoint> {
    return Promise.resolve(this.state.checkpoint);
  }

  public getProjectedOrder(orderId: string): Promise<LevelTwoProjectedOrder | undefined> {
    return Promise.resolve(this.state.orders.get(orderId));
  }

  public getLevel(
    side: "buy" | "sell",
    priceTicks: bigint,
  ): Promise<LevelTwoOrderBookLevel | undefined> {
    return Promise.resolve(this.state.levels.get(levelKey(side, priceTicks)));
  }

  public saveProjectedOrder(order: LevelTwoProjectedOrder): Promise<void> {
    this.state.orders.set(order.orderId, order);
    return Promise.resolve();
  }

  public deleteProjectedOrder(orderId: string): Promise<void> {
    this.state.orders.delete(orderId);
    return Promise.resolve();
  }

  public saveLevel(level: LevelTwoOrderBookLevel): Promise<void> {
    this.state.levels.set(levelKey(level.side, level.priceTicks), level);
    return Promise.resolve();
  }

  public deleteLevel(side: "buy" | "sell", priceTicks: bigint): Promise<void> {
    this.state.levels.delete(levelKey(side, priceTicks));
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

class InMemoryProjectionStore
  implements LevelTwoProjectionTransactionRunner, MarketDataProjectionCheckpointReader
{
  public state: ProjectionState = {
    checkpoint: { lastSequence: 0n, lastOccurredAt: null },
    levels: new Map(),
    orders: new Map(),
  };

  public getCheckpoint(_marketCode: MarketCode): Promise<LevelTwoProjectionCheckpoint> {
    return Promise.resolve(this.state.checkpoint);
  }

  public async run<T>(
    _marketCode: MarketCode,
    operation: (transaction: LevelTwoProjectionTransaction) => Promise<T>,
  ): Promise<T> {
    const candidate = cloneState(this.state);
    const result = await operation(new InMemoryProjectionTransaction(candidate));
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
const occurredAt = new Date("2026-08-28T10:00:00.000Z");

function orderFact(
  sequence: bigint,
  input: {
    readonly marketCode?: MarketCode;
    readonly orderId: string;
    readonly side: "buy" | "sell";
    readonly priceTicks: bigint;
    readonly remainingLots: bigint;
    readonly status?: "cancelled" | "filled" | "open" | "partially_filled";
  },
): TradingOrderStateFact {
  const status = input.status ?? "open";
  return {
    id: randomUUID(),
    marketCode: input.marketCode ?? btcUsd,
    marketSequence: sequence,
    kind: "order_state",
    schemaVersion: 1,
    payload: {
      orderId: input.orderId,
      side: input.side,
      limitPriceTicks: input.priceTicks.toString(),
      remainingLots: input.remainingLots.toString(),
      status,
      terminalReason: status === "cancelled" ? "owner_cancelled" : null,
    },
    occurredAt: new Date(occurredAt.getTime() + Number(sequence) * 1_000),
    createdAt: occurredAt,
  };
}

function tradeFact(sequence: bigint): TradingPublicationFact {
  return {
    id: randomUUID(),
    marketCode: btcUsd,
    marketSequence: sequence,
    kind: "trade_executed",
    schemaVersion: 1,
    payload: {
      tradeId: randomUUID(),
      quantityLots: "3",
      priceTicks: "100",
      executionSequence: "1",
    },
    occurredAt: new Date(occurredAt.getTime() + Number(sequence) * 1_000),
    createdAt: occurredAt,
  };
}

describe("Level-two order-book projection", () => {
  it("aggregates, replaces, removes, and checkpoints exact final order state", async () => {
    const firstOrderId = randomUUID();
    const secondOrderId = randomUUID();
    const askOrderId = randomUUID();
    const facts = [
      orderFact(1n, {
        orderId: firstOrderId,
        side: "buy",
        priceTicks: 100n,
        remainingLots: 5n,
      }),
      orderFact(2n, {
        orderId: secondOrderId,
        side: "buy",
        priceTicks: 100n,
        remainingLots: 3n,
      }),
      orderFact(3n, {
        orderId: askOrderId,
        side: "sell",
        priceTicks: 110n,
        remainingLots: 4n,
      }),
      orderFact(4n, {
        orderId: firstOrderId,
        side: "buy",
        priceTicks: 100n,
        remainingLots: 2n,
        status: "partially_filled",
      }),
      orderFact(5n, {
        orderId: secondOrderId,
        side: "buy",
        priceTicks: 100n,
        remainingLots: 3n,
        status: "cancelled",
      }),
      tradeFact(6n),
    ];
    const store = new InMemoryProjectionStore();
    const projector = new ProjectLevelTwoOrderBook(new StubFactReader(facts, true), store, store);

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 6,
      appliedCount: 6,
      lastSequence: 6n,
      caughtUp: true,
    });
    expect(store.state.levels.get("sell:110")).toEqual(
      expect.objectContaining({
        side: "sell",
        priceTicks: 110n,
        aggregateRemainingLots: 4n,
        orderCount: 1n,
      }),
    );
    expect(store.state.levels.get("buy:100")).toEqual(
      expect.objectContaining({
        side: "buy",
        priceTicks: 100n,
        aggregateRemainingLots: 2n,
        orderCount: 1n,
      }),
    );
    expect(store.state.orders.has(secondOrderId)).toBe(false);
    expect(store.state.checkpoint).toEqual({
      lastSequence: 6n,
      lastOccurredAt: new Date("2026-08-28T10:00:06.000Z"),
    });

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 6,
      appliedCount: 0,
      lastSequence: 6n,
      caughtUp: true,
    });
    expect(store.state.levels.get("buy:100")?.aggregateRemainingLots).toBe(2n);
  });

  it("rolls back the complete batch and stops at a sequence gap", async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ProjectLevelTwoOrderBook(
      new StubFactReader([
        orderFact(1n, {
          orderId: randomUUID(),
          side: "buy",
          priceTicks: 100n,
          remainingLots: 2n,
        }),
        orderFact(3n, {
          orderId: randomUUID(),
          side: "sell",
          priceTicks: 110n,
          remainingLots: 1n,
        }),
      ]),
      store,
      store,
    );

    await expect(projector.execute({ marketCode: btcUsd })).rejects.toMatchObject({
      issue: "SEQUENCE_GAP",
    });
    expect(store.state).toEqual({
      checkpoint: { lastSequence: 0n, lastOccurredAt: null },
      levels: new Map(),
      orders: new Map(),
    });
  });

  it("rejects a fact from another market and invalid batch boundaries", async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ProjectLevelTwoOrderBook(
      new StubFactReader([
        orderFact(1n, {
          marketCode: ethUsd,
          orderId: randomUUID(),
          side: "buy",
          priceTicks: 100n,
          remainingLots: 1n,
        }),
      ]),
      store,
      store,
    );

    await expect(projector.execute({ marketCode: btcUsd })).rejects.toEqual(
      expect.objectContaining<Partial<MarketDataProjectionError>>({
        issue: "FACT_MARKET_MISMATCH",
      }),
    );
    await expect(projector.execute({ marketCode: btcUsd, limit: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
