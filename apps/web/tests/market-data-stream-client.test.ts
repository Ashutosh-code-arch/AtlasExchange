import { afterEach, describe, expect, it, vi } from "vitest";
import {
  marketDataStreamProtocol,
  type MarketDataStreamClientMessage,
  type MarketDataStreamServerMessage,
} from "@atlas/contracts";

import {
  BrowserMarketDataStreamClient,
  marketDataStreamUrl,
  type MarketDataStreamObserver,
} from "../src/features/market-data";

class FakeVisibilityDocument {
  public visibilityState: DocumentVisibilityState = "visible";
  private listener: (() => void) | undefined;

  public addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listener = listener;
  }

  public removeEventListener(_type: "visibilitychange", listener: () => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  public setVisibility(value: DocumentVisibilityState): void {
    this.visibilityState = value;
    this.listener?.();
  }
}

class FakeWebSocket {
  public readyState = 0;
  public onopen: WebSocket["onopen"] = null;
  public onmessage: WebSocket["onmessage"] = null;
  public onerror: WebSocket["onerror"] = null;
  public onclose: WebSocket["onclose"] = null;
  public readonly sent: string[] = [];
  public readonly closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];

  public constructor(
    public readonly url: string,
    public readonly protocol: string,
  ) {}

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 2;
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }

  public serverMessage(message: MarketDataStreamServerMessage | Record<string, unknown>): void {
    this.onmessage?.call(
      this as unknown as WebSocket,
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  public serverText(data: string): void {
    this.onmessage?.call(this as unknown as WebSocket, new MessageEvent("message", { data }));
  }

  public serverClose(): void {
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, new Event("close") as CloseEvent);
  }

  public messages(): MarketDataStreamClientMessage[] {
    return this.sent.map((value) => JSON.parse(value) as MarketDataStreamClientMessage);
  }
}

function welcome(heartbeatIntervalMs = 15_000): MarketDataStreamServerMessage {
  return {
    type: "welcome",
    protocol: marketDataStreamProtocol,
    serverTime: "2026-08-28T12:00:00.000Z",
    heartbeatIntervalMs,
    maximumSubscriptions: 12,
  };
}

function tickerSnapshot(subscriptionId: string, sequence: string): MarketDataStreamServerMessage {
  return {
    type: "snapshot",
    subscriptionId,
    topic: "ticker",
    data: {
      marketCode: "BTC-USD",
      sequence,
      publishedSequence: sequence,
      lag: "0",
      freshness: "current",
      asOf: "2026-08-28T12:00:01.000Z",
      generatedAt: "2026-08-28T12:00:01.250Z",
      windowStart: "2026-08-27T12:00:01.250Z",
      windowEnd: "2026-08-28T12:00:01.250Z",
      lastPrice: "50000",
      lastQuantity: "0.003",
      lastExecutedAt: "2026-08-28T12:00:01.000Z",
      highPrice: "50100",
      lowPrice: "49900",
      baseVolume: "0.01",
      quoteVolume: "500",
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserMarketDataStreamClient", () => {
  it("builds ws and wss endpoints only from HTTP API origins", () => {
    expect(marketDataStreamUrl("http://localhost:3000")).toBe(
      "ws://localhost:3000/api/v1/market-data/stream",
    );
    expect(marketDataStreamUrl("https://api.atlas.test/")).toBe(
      "wss://api.atlas.test/api/v1/market-data/stream",
    );
    expect(() => marketDataStreamUrl("file:///atlas")).toThrow(TypeError);
  });

  it("multiplexes subscriptions after welcome and routes only monotonic matching snapshots", () => {
    const sockets: FakeWebSocket[] = [];
    const stream = new BrowserMarketDataStreamClient({
      apiBaseUrl: "https://api.atlas.test",
      webSocketFactory: (url, protocol) => {
        const socket = new FakeWebSocket(url, protocol);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      visibilityDocument: new FakeVisibilityDocument(),
    });
    const tickerObserver = {
      onSnapshot: vi.fn<MarketDataStreamObserver["onSnapshot"]>(),
      onUnavailable: vi.fn<MarketDataStreamObserver["onUnavailable"]>(),
    };
    stream.subscribe({ topic: "ticker", marketCode: "BTC-USD" }, tickerObserver);
    stream.subscribe(
      { topic: "order_book", marketCode: "BTC-USD", depth: 15 },
      { onSnapshot: vi.fn(), onUnavailable: vi.fn() },
    );
    stream.subscribe(
      { topic: "candles", marketCode: "BTC-USD", interval: "5m", limit: 120 },
      { onSnapshot: vi.fn(), onUnavailable: vi.fn() },
    );

    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toMatchObject({
      url: "wss://api.atlas.test/api/v1/market-data/stream",
      protocol: marketDataStreamProtocol,
      sent: [],
    });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.serverMessage(welcome());

    const subscribeMessages = sockets[0]!
      .messages()
      .filter((message) => message.type === "subscribe");
    expect(subscribeMessages).toHaveLength(3);
    const tickerSubscription = subscribeMessages.find(
      (message) => message.subscription.topic === "ticker",
    );
    if (tickerSubscription?.type !== "subscribe") throw new Error("Ticker subscription missing.");
    sockets[0]!.serverMessage(tickerSnapshot(tickerSubscription.subscription.id, "3"));
    sockets[0]!.serverMessage(tickerSnapshot(tickerSubscription.subscription.id, "2"));

    expect(tickerObserver.onSnapshot).toHaveBeenCalledTimes(1);
    expect(tickerObserver.onSnapshot.mock.calls[0]?.[0]).toMatchObject({
      topic: "ticker",
      data: { sequence: "3" },
    });
    stream.dispose();
  });

  it("sends a subscription added after the connection is welcomed", () => {
    const sockets: FakeWebSocket[] = [];
    const stream = new BrowserMarketDataStreamClient({
      apiBaseUrl: "https://api.atlas.test",
      webSocketFactory: (url, protocol) => {
        const socket = new FakeWebSocket(url, protocol);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      visibilityDocument: new FakeVisibilityDocument(),
    });
    stream.subscribe(
      { topic: "order_book", marketCode: "BTC-USD", depth: 15 },
      { onSnapshot: vi.fn(), onUnavailable: vi.fn() },
    );
    sockets[0]!.open();
    sockets[0]!.serverMessage(welcome());
    expect(sockets[0]!.messages()).toHaveLength(1);

    stream.subscribe(
      { topic: "candles", marketCode: "BTC-USD", interval: "1m", limit: 120 },
      { onSnapshot: vi.fn(), onUnavailable: vi.fn() },
    );

    expect(sockets[0]!.messages()).toHaveLength(2);
    expect(sockets[0]!.messages()[1]).toMatchObject({
      type: "subscribe",
      subscription: { topic: "candles", interval: "1m" },
    });
    stream.dispose();
  });

  it("reconnects with bounded delay, resubscribes, and retains the subscription identity", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const observer = { onSnapshot: vi.fn(), onUnavailable: vi.fn() };
    const stream = new BrowserMarketDataStreamClient({
      apiBaseUrl: "http://api.test",
      webSocketFactory: (url, protocol) => {
        const socket = new FakeWebSocket(url, protocol);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      visibilityDocument: new FakeVisibilityDocument(),
      initialReconnectDelayMs: 250,
      maximumReconnectDelayMs: 1_000,
    });
    stream.subscribe({ topic: "ticker", marketCode: "BTC-USD" }, observer);
    sockets[0]!.open();
    sockets[0]!.serverMessage(welcome());
    const first = sockets[0]!.messages().find((message) => message.type === "subscribe");
    if (first?.type !== "subscribe") throw new Error("Initial subscription missing.");
    sockets[0]!.serverMessage(tickerSnapshot(first.subscription.id, "1"));

    sockets[0]!.serverClose();
    expect(observer.onUnavailable).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.serverMessage(welcome());
    const second = sockets[1]!.messages().find((message) => message.type === "subscribe");
    if (second?.type !== "subscribe") throw new Error("Recovered subscription missing.");

    expect(second.subscription).toEqual(first.subscription);
    sockets[1]!.serverMessage(tickerSnapshot(second.subscription.id, "2"));
    expect(observer.onSnapshot).toHaveBeenCalledTimes(2);
    stream.dispose();
  });

  it("pauses the socket while hidden and reconnects immediately when visible", () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibilityDocument();
    const sockets: FakeWebSocket[] = [];
    const observer = { onSnapshot: vi.fn(), onUnavailable: vi.fn() };
    const stream = new BrowserMarketDataStreamClient({
      apiBaseUrl: "http://api.test",
      webSocketFactory: (url, protocol) => {
        const socket = new FakeWebSocket(url, protocol);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      visibilityDocument: visibility,
    });
    stream.subscribe({ topic: "ticker", marketCode: "BTC-USD" }, observer);
    sockets[0]!.open();
    sockets[0]!.serverMessage(welcome());

    visibility.setVisibility("hidden");
    expect(sockets[0]!.closeCalls).toContainEqual({
      code: 1000,
      reason: "Market Data paused while hidden.",
    });
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    visibility.setVisibility("visible");

    expect(observer.onUnavailable).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    stream.dispose();
  });

  it("releases an idle socket and reacquires one after a Strict Mode-style resubscribe", () => {
    const sockets: FakeWebSocket[] = [];
    const visibility = new FakeVisibilityDocument();
    const stream = new BrowserMarketDataStreamClient({
      apiBaseUrl: "http://api.test",
      webSocketFactory: (url, protocol) => {
        const socket = new FakeWebSocket(url, protocol);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      visibilityDocument: visibility,
    });
    const first = stream.subscribe(
      { topic: "ticker", marketCode: "BTC-USD" },
      { onSnapshot: vi.fn(), onUnavailable: vi.fn() },
    );
    first.unsubscribe();
    expect(sockets[0]!.closeCalls.at(-1)).toEqual({
      code: 1000,
      reason: "No active Market Data subscriptions.",
    });

    stream.subscribe(
      { topic: "ticker", marketCode: "BTC-USD" },
      { onSnapshot: vi.fn(), onUnavailable: vi.fn() },
    );

    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.serverMessage(welcome());
    expect(sockets[1]!.messages().filter(({ type }) => type === "subscribe")).toHaveLength(1);
    stream.dispose();
  });

  it("closes malformed server messages and connections that miss the heartbeat window", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const stream = new BrowserMarketDataStreamClient({
      apiBaseUrl: "http://api.test",
      webSocketFactory: (url, protocol) => {
        const socket = new FakeWebSocket(url, protocol);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      visibilityDocument: new FakeVisibilityDocument(),
    });
    stream.subscribe(
      { topic: "ticker", marketCode: "BTC-USD" },
      { onSnapshot: vi.fn(), onUnavailable: vi.fn() },
    );
    sockets[0]!.open();
    sockets[0]!.serverText("not-json");
    expect(sockets[0]!.closeCalls.at(-1)).toEqual({
      code: 1002,
      reason: "Market Data protocol violation.",
    });

    sockets[0]!.serverClose();
    vi.advanceTimersByTime(250);
    sockets[1]!.open();
    sockets[1]!.serverMessage(welcome(1_000));
    vi.advanceTimersByTime(2_500);
    expect(sockets[1]!.closeCalls.at(-1)).toEqual({
      code: 4000,
      reason: "Market Data heartbeat timed out.",
    });
    stream.dispose();
  });
});
