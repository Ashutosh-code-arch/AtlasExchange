import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  CoinbaseReferenceMarketDataFeed,
  parseCoinbaseReferenceMessage,
  type CoinbaseWebSocketConnection,
} from "../src/modules/market-data/index.js";

class FakeWebSocket extends EventEmitter implements CoinbaseWebSocketConnection {
  public readonly sent: string[] = [];
  public closeCalls = 0;
  public terminateCalls = 0;

  public override on(event: string, listener: (...arguments_: readonly unknown[]) => void): this {
    return super.on(event, listener);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closeCalls += 1;
  }

  public terminate(): void {
    this.terminateCalls += 1;
  }
}

const tickerMessage = {
  channel: "ticker_batch",
  timestamp: "2026-08-31T12:00:01.123456789Z",
  sequence_num: 7,
  events: [
    {
      type: "update",
      tickers: [
        {
          type: "ticker",
          product_id: "BTC-USD",
          price: "0108500.2500",
          volume_24_h: "1250.1200",
          low_24_h: "107900.5000",
          high_24_h: "110000.0000",
          price_percent_chg_24_h: "-1.2500",
        },
      ],
    },
  ],
};

describe("Coinbase reference Market Data validation", () => {
  it("accepts supported messages, ignores future channels, and rejects malformed recognized data", () => {
    expect(parseCoinbaseReferenceMessage(JSON.stringify(tickerMessage)).status).toBe("accepted");
    expect(
      parseCoinbaseReferenceMessage(JSON.stringify({ channel: "future_channel", events: [] }))
        .status,
    ).toBe("ignored");
    expect(parseCoinbaseReferenceMessage("not-json").status).toBe("invalid");
    expect(
      parseCoinbaseReferenceMessage(
        JSON.stringify({
          ...tickerMessage,
          events: [{ type: "update", tickers: [] }],
          sequence_num: -1,
        }),
      ).status,
    ).toBe("invalid");
  });
});

describe("Coinbase reference Market Data feed", () => {
  it("subscribes without credentials, normalizes bounded snapshots, and marks old data stale", async () => {
    let now = new Date("2026-08-31T12:00:02.000Z");
    const socket = new FakeWebSocket();
    const warn = vi.fn();
    const feed = new CoinbaseReferenceMarketDataFeed({
      logger: { info: vi.fn(), warn },
      now: () => now,
      staleAfterMs: 15_000,
      webSocketFactory: () => socket,
    });

    await feed.start();
    socket.emit("open");
    expect(socket.sent.map((message) => JSON.parse(message) as unknown)).toEqual([
      {
        type: "subscribe",
        product_ids: ["BTC-USD", "ETH-USD"],
        channel: "ticker_batch",
      },
      {
        type: "subscribe",
        product_ids: ["BTC-USD", "ETH-USD"],
        channel: "candles",
      },
      { type: "subscribe", channel: "heartbeats" },
    ]);
    expect(socket.sent.join(" ")).not.toContain("jwt");

    socket.emit("message", JSON.stringify(tickerMessage));
    const start = Date.parse("2026-08-31T12:00:00.000Z") / 1_000;
    socket.emit(
      "message",
      JSON.stringify({
        channel: "candles",
        timestamp: "2026-08-31T12:00:02.000Z",
        sequence_num: 8,
        events: [
          {
            type: "update",
            candles: [
              {
                start: String(start),
                high: "108700.000",
                low: "108400.000",
                open: "108500.000",
                close: "108650.5000",
                volume: "3.2500",
                product_id: "BTC-USD",
              },
            ],
          },
        ],
      }),
    );

    expect(feed.getTicker("BTC-USD")).toEqual({
      marketCode: "BTC-USD",
      source: "coinbase",
      freshness: "live",
      price: "108500.25",
      priceChange24hPercent: "-1.25",
      highPrice24h: "110000",
      lowPrice24h: "107900.5",
      baseVolume24h: "1250.12",
      observedAt: "2026-08-31T12:00:01.123Z",
      receivedAt: "2026-08-31T12:00:02.000Z",
    });
    expect(feed.getCandles("BTC-USD", 1)?.candles).toEqual([
      {
        start: "2026-08-31T12:00:00.000Z",
        end: "2026-08-31T12:05:00.000Z",
        openPrice: "108500",
        highPrice: "108700",
        lowPrice: "108400",
        closePrice: "108650.5",
        baseVolume: "3.25",
      },
    ]);

    now = new Date("2026-08-31T12:00:18.000Z");
    expect(feed.getTicker("BTC-USD")?.freshness).toBe("stale");
    expect(feed.getCandles("BTC-USD", 1)?.freshness).toBe("stale");
    expect(feed.getTicker("ETH-USD")).toBeUndefined();

    socket.emit("message", JSON.stringify({ ...tickerMessage, sequence_num: -1 }));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "reference_market_data.message_rejected" }),
      expect.any(String),
    );
    await feed.stop();
    expect(socket.closeCalls).toBe(1);
  });

  it("uses capped reconnect delay and terminates a connection with no heartbeat", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const feed = new CoinbaseReferenceMarketDataFeed({
      logger: { info: vi.fn(), warn: vi.fn() },
      heartbeatTimeoutMs: 2_000,
      reconnectInitialDelayMs: 100,
      reconnectMaximumDelayMs: 200,
      now: () => new Date(Date.now()),
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await feed.start();
    expect(sockets).toHaveLength(1);
    sockets[0]?.emit("close");
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1]?.emit("close");
    await vi.advanceTimersByTimeAsync(199);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    sockets[2]?.emit("open");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets[2]?.terminateCalls).toBe(1);

    await feed.stop();
    vi.useRealTimers();
  });
});
