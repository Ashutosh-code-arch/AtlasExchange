import type {
  MarketDataCandlesResponse,
  MarketDataOrderBookResponse,
  MarketDataTickerResponse,
} from "@atlas/contracts";

import type {
  MarketDataStreamObserver,
  MarketDataStreamSubscriptionHandle,
  MarketDataStreamSubscriptionInput,
  MarketDataSubscriptionClient,
} from "../../src/features/market-data";

interface InitialSnapshots {
  readonly candles?: MarketDataCandlesResponse["data"];
  readonly orderBook?: MarketDataOrderBookResponse["data"];
  readonly ticker?: MarketDataTickerResponse["data"];
}

interface Record {
  readonly id: string;
  readonly subscription: MarketDataStreamSubscriptionInput;
  readonly observer: MarketDataStreamObserver;
  active: boolean;
}

export class ControlledMarketDataStream implements MarketDataSubscriptionClient {
  private readonly records: Record[] = [];
  private sequence = 0;
  public retryCount = 0;
  public disposed = false;

  public constructor(private readonly initial: InitialSnapshots = {}) {}

  public get activeSubscriptions(): readonly MarketDataStreamSubscriptionInput[] {
    return this.records.filter(({ active }) => active).map(({ subscription }) => subscription);
  }

  public subscribe(
    subscription: MarketDataStreamSubscriptionInput,
    observer: MarketDataStreamObserver,
  ): MarketDataStreamSubscriptionHandle {
    this.sequence += 1;
    const record: Record = {
      id: `test_${this.sequence}`,
      subscription,
      observer,
      active: true,
    };
    this.records.push(record);
    void Promise.resolve().then(() => {
      if (record.active) this.emitInitial(record);
    });
    return {
      retry: () => {
        if (!record.active) return;
        this.retryCount += 1;
        record.observer.onUnavailable();
        void Promise.resolve().then(() => {
          if (record.active) this.emitInitial(record);
        });
      },
      unsubscribe: () => {
        record.active = false;
      },
    };
  }

  public dispose(): void {
    this.disposed = true;
    for (const record of this.records) record.active = false;
  }

  public emitOrderBook(data: MarketDataOrderBookResponse["data"]): void {
    for (const record of this.records) {
      if (
        record.active &&
        record.subscription.topic === "order_book" &&
        record.subscription.marketCode === data.marketCode &&
        record.subscription.depth === data.depth
      ) {
        record.observer.onSnapshot({
          type: "snapshot",
          subscriptionId: record.id,
          topic: "order_book",
          data,
        });
      }
    }
  }

  public emitTicker(data: MarketDataTickerResponse["data"]): void {
    for (const record of this.records) {
      if (
        record.active &&
        record.subscription.topic === "ticker" &&
        record.subscription.marketCode === data.marketCode
      ) {
        record.observer.onSnapshot({
          type: "snapshot",
          subscriptionId: record.id,
          topic: "ticker",
          data,
        });
      }
    }
  }

  public emitCandles(data: MarketDataCandlesResponse["data"]): void {
    for (const record of this.records) {
      if (
        record.active &&
        record.subscription.topic === "candles" &&
        record.subscription.marketCode === data.marketCode &&
        record.subscription.interval === data.interval &&
        record.subscription.limit === data.limit
      ) {
        record.observer.onSnapshot({
          type: "snapshot",
          subscriptionId: record.id,
          topic: "candles",
          data,
        });
      }
    }
  }

  public makeUnavailable(topic?: MarketDataStreamSubscriptionInput["topic"]): void {
    for (const record of this.records) {
      if (record.active && (topic === undefined || record.subscription.topic === topic)) {
        record.observer.onUnavailable();
      }
    }
  }

  public historicalObserver(
    topic: MarketDataStreamSubscriptionInput["topic"],
    marketCode: string,
  ): MarketDataStreamObserver | undefined {
    return this.records.find(
      ({ subscription }) => subscription.topic === topic && subscription.marketCode === marketCode,
    )?.observer;
  }

  private emitInitial(record: Record): void {
    switch (record.subscription.topic) {
      case "order_book":
        if (this.initial.orderBook !== undefined) this.emitOrderBook(this.initial.orderBook);
        return;
      case "ticker":
        if (this.initial.ticker !== undefined) this.emitTicker(this.initial.ticker);
        return;
      case "candles":
        if (this.initial.candles !== undefined) this.emitCandles(this.initial.candles);
        return;
    }
  }
}
