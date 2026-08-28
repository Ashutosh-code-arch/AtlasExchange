import { once } from "node:events";
import { createServer, type Server } from "node:http";

import {
  marketDataStreamProtocol,
  marketDataStreamServerMessageSchema,
  type MarketDataStreamServerMessage,
} from "@atlas/contracts";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import WebSocket, { type RawData } from "ws";

import type { GetLevelTwoOrderBook } from "../src/modules/market-data/application/get-level-two-order-book.js";
import type { GetPublicCandles } from "../src/modules/market-data/application/get-public-candles.js";
import type { GetPublicTradeTicker } from "../src/modules/market-data/application/get-public-trade-ticker.js";
import {
  MarketDataStreamGateway,
  type MarketDataStreamGatewayOptions,
} from "../src/modules/market-data/index.js";

const orderBook = {
  marketCode: "BTC-USD",
  depth: 20,
  sequence: "12",
  publishedSequence: "12",
  lag: "0",
  freshness: "current",
  asOf: "2026-08-28T12:00:00.000Z",
  generatedAt: "2026-08-28T12:00:00.250Z",
  bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
  asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
} as const;

const ticker = {
  marketCode: "BTC-USD",
  sequence: "12",
  publishedSequence: "12",
  lag: "0",
  freshness: "current",
  asOf: "2026-08-28T12:00:00.000Z",
  generatedAt: "2026-08-28T12:00:01.000Z",
  windowStart: "2026-08-27T12:00:01.000Z",
  windowEnd: "2026-08-28T12:00:01.000Z",
  lastPrice: "50000",
  lastQuantity: "0.003",
  lastExecutedAt: "2026-08-28T12:00:00.000Z",
  highPrice: "50100",
  lowPrice: "49900",
  baseVolume: "0.01",
  quoteVolume: "500",
} as const;

const candles = {
  marketCode: "BTC-USD",
  interval: "5m",
  limit: 120,
  sequence: "12",
  publishedSequence: "12",
  lag: "0",
  freshness: "current",
  asOf: "2026-08-28T12:00:00.000Z",
  generatedAt: "2026-08-28T12:01:00.000Z",
  candles: [],
  nextBefore: null,
} as const;

interface ClientHarness {
  readonly socket: WebSocket;
  readonly messages: MarketDataStreamServerMessage[];
}

interface GatewayHarness {
  readonly server: Server;
  readonly gateway: MarketDataStreamGateway;
  readonly url: string;
  readonly getCandles: MockedFunction<GetPublicCandles["execute"]>;
  readonly getLevelTwoOrderBook: MockedFunction<GetLevelTwoOrderBook["execute"]>;
  readonly getTradeTicker: MockedFunction<GetPublicTradeTicker["execute"]>;
}

const activeHarnesses: GatewayHarness[] = [];
const activeClients: WebSocket[] = [];

function logger(): Pick<Logger, "info" | "warn" | "error"> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as Pick<Logger, "info" | "warn" | "error">;
}

function rawDataText(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function createHarness(
  overrides: Partial<
    Pick<
      MarketDataStreamGatewayOptions,
      | "heartbeatIntervalMs"
      | "maximumConnections"
      | "maximumConnectionsPerClient"
      | "maximumSubscriptionsPerConnection"
      | "maximumMessageBytes"
      | "maximumBufferedBytes"
      | "refreshIntervalMs"
    >
  > = {},
): Promise<GatewayHarness> {
  const server = createServer((_request, response) => response.writeHead(404).end());
  const getCandles = vi
    .fn<GetPublicCandles["execute"]>()
    .mockResolvedValue({ status: "found", history: candles });
  const getLevelTwoOrderBook = vi
    .fn<GetLevelTwoOrderBook["execute"]>()
    .mockResolvedValue({ status: "found", orderBook });
  const getTradeTicker = vi
    .fn<GetPublicTradeTicker["execute"]>()
    .mockResolvedValue({ status: "found", ticker });
  const gateway = new MarketDataStreamGateway({
    server,
    logger: logger(),
    webOrigin: "http://localhost:5173",
    refreshIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    maximumConnections: 10,
    maximumConnectionsPerClient: 5,
    maximumSubscriptionsPerConnection: 3,
    maximumMessageBytes: 8_192,
    maximumBufferedBytes: 1_048_576,
    getCandles: { execute: getCandles },
    getLevelTwoOrderBook: { execute: getLevelTwoOrderBook },
    getTradeTicker: { execute: getTradeTicker },
    now: () => new Date("2026-08-28T12:00:00.000Z"),
    ...overrides,
  });
  gateway.start();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server has no port.");
  const harness = {
    server,
    gateway,
    url: `ws://127.0.0.1:${address.port}/api/v1/market-data/stream`,
    getCandles,
    getLevelTwoOrderBook,
    getTradeTicker,
  };
  activeHarnesses.push(harness);
  return harness;
}

async function connect(harness: GatewayHarness): Promise<ClientHarness> {
  const socket = new WebSocket(harness.url, marketDataStreamProtocol, {
    origin: "http://localhost:5173",
  });
  const messages: MarketDataStreamServerMessage[] = [];
  socket.on("message", (data) => {
    messages.push(marketDataStreamServerMessageSchema.parse(JSON.parse(rawDataText(data))));
  });
  activeClients.push(socket);
  await once(socket, "open");
  return { socket, messages };
}

async function takeMessage(
  client: ClientHarness,
  predicate: (message: MarketDataStreamServerMessage) => boolean,
): Promise<MarketDataStreamServerMessage> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const index = client.messages.findIndex(predicate);
    if (index >= 0) return client.messages.splice(index, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a Market Data stream message.");
}

function subscribe(client: ClientHarness, message: Record<string, unknown>): void {
  client.socket.send(JSON.stringify(message));
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    if (client.readyState === WebSocket.OPEN) client.close(1000);
    else if (client.readyState !== WebSocket.CLOSED) client.terminate();
  }
  for (const harness of activeHarnesses.splice(0).toReversed()) {
    await harness.gateway.stop();
    await closeServer(harness.server);
  }
});

describe("MarketDataStreamGateway", () => {
  it("negotiates the versioned protocol and sends an acknowledged exact initial snapshot", async () => {
    const harness = await createHarness();
    const client = await connect(harness);

    await expect(takeMessage(client, ({ type }) => type === "welcome")).resolves.toMatchObject({
      type: "welcome",
      protocol: marketDataStreamProtocol,
      maximumSubscriptions: 3,
    });
    subscribe(client, {
      type: "subscribe",
      requestId: "request_1",
      subscription: { id: "book", topic: "order_book", marketCode: "BTC-USD", depth: 20 },
    });
    await expect(takeMessage(client, ({ type }) => type === "subscribed")).resolves.toMatchObject({
      requestId: "request_1",
      subscription: { id: "book", topic: "order_book" },
    });
    await expect(takeMessage(client, ({ type }) => type === "snapshot")).resolves.toEqual({
      type: "snapshot",
      subscriptionId: "book",
      topic: "order_book",
      data: orderBook,
    });
    expect(harness.getLevelTwoOrderBook).toHaveBeenCalledWith({
      marketCode: "BTC-USD",
      depth: 20,
    });

    subscribe(client, { type: "unsubscribe", requestId: "request_2", subscriptionId: "book" });
    await expect(takeMessage(client, ({ type }) => type === "unsubscribed")).resolves.toEqual({
      type: "unsubscribed",
      requestId: "request_2",
      subscriptionId: "book",
    });
  });

  it("loads one refresh per unique channel and fans the replacement snapshot to subscribers", async () => {
    const harness = await createHarness();
    const first = await connect(harness);
    const second = await connect(harness);
    await takeMessage(first, ({ type }) => type === "welcome");
    await takeMessage(second, ({ type }) => type === "welcome");
    for (const [client, id] of [
      [first, "ticker_a"],
      [second, "ticker_b"],
    ] as const) {
      subscribe(client, {
        type: "subscribe",
        requestId: `request_${id}`,
        subscription: { id, topic: "ticker", marketCode: "BTC-USD" },
      });
      await takeMessage(client, ({ type }) => type === "subscribed");
      await takeMessage(client, ({ type }) => type === "snapshot");
    }
    expect(harness.getTradeTicker).toHaveBeenCalledTimes(2);
    harness.getTradeTicker.mockResolvedValue({
      status: "found",
      ticker: { ...ticker, sequence: "13", publishedSequence: "13" },
    });

    await harness.gateway.refreshNow();

    expect(harness.getTradeTicker).toHaveBeenCalledTimes(3);
    for (const client of [first, second]) {
      await expect(takeMessage(client, ({ type }) => type === "snapshot")).resolves.toMatchObject({
        topic: "ticker",
        data: { sequence: "13" },
      });
    }
  });

  it("returns safe subscription errors and closes a client after repeated invalid messages", async () => {
    const harness = await createHarness({ maximumSubscriptionsPerConnection: 1 });
    const client = await connect(harness);
    await takeMessage(client, ({ type }) => type === "welcome");
    subscribe(client, {
      type: "subscribe",
      requestId: "request_1",
      subscription: {
        id: "chart",
        topic: "candles",
        marketCode: "BTC-USD",
        interval: "5m",
        limit: 120,
      },
    });
    await takeMessage(client, ({ type }) => type === "subscribed");
    await takeMessage(client, ({ type }) => type === "snapshot");
    subscribe(client, {
      type: "subscribe",
      requestId: "request_2",
      subscription: { id: "ticker", topic: "ticker", marketCode: "BTC-USD" },
    });
    await expect(takeMessage(client, ({ type }) => type === "error")).resolves.toMatchObject({
      requestId: "request_2",
      subscriptionId: "ticker",
      code: "SUBSCRIPTION_LIMIT",
    });

    const closed = once(client.socket, "close");
    client.socket.send("not-json");
    client.socket.send("not-json");
    client.socket.send("not-json");
    const [code] = (await closed) as [number, Buffer];
    expect(code).toBe(1008);
  });

  it("rejects untrusted origins and excess per-client connections during upgrade", async () => {
    const harness = await createHarness({ maximumConnectionsPerClient: 1 });
    const untrusted = new WebSocket(harness.url, marketDataStreamProtocol, {
      origin: "https://untrusted.example",
    });
    untrusted.on("error", () => undefined);
    activeClients.push(untrusted);
    const untrustedStatus = await new Promise<number | undefined>((resolve) => {
      untrusted.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });
    expect(untrustedStatus).toBe(403);

    const first = await connect(harness);
    await takeMessage(first, ({ type }) => type === "welcome");
    const excess = new WebSocket(harness.url, marketDataStreamProtocol, {
      origin: "http://localhost:5173",
    });
    excess.on("error", () => undefined);
    activeClients.push(excess);
    const excessStatus = await new Promise<number | undefined>((resolve) => {
      excess.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });
    expect(excessStatus).toBe(429);
    expect(harness.gateway.activeConnectionCount).toBe(1);
  });

  it("requires the versioned Atlas Market Data subprotocol", async () => {
    const harness = await createHarness();
    const unsupported = new WebSocket(harness.url, "unsupported.protocol", {
      origin: "http://localhost:5173",
    });
    unsupported.on("error", () => undefined);
    activeClients.push(unsupported);
    const status = await new Promise<number | undefined>((resolve) => {
      unsupported.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });

    expect(status).toBe(426);
    expect(harness.gateway.activeConnectionCount).toBe(0);
  });

  it("sends application heartbeats and gracefully closes upgraded clients on shutdown", async () => {
    const harness = await createHarness({ heartbeatIntervalMs: 20 });
    const client = await connect(harness);
    await takeMessage(client, ({ type }) => type === "welcome");
    await expect(takeMessage(client, ({ type }) => type === "heartbeat")).resolves.toEqual({
      type: "heartbeat",
      serverTime: "2026-08-28T12:00:00.000Z",
    });
    const closed = once(client.socket, "close");

    await harness.gateway.stop();

    const [code] = (await closed) as [number, Buffer];
    expect(code).toBe(1001);
    expect(harness.gateway.activeConnectionCount).toBe(0);
  });

  it("waits for in-flight subscription reads before graceful shutdown completes", async () => {
    const harness = await createHarness();
    const client = await connect(harness);
    await takeMessage(client, ({ type }) => type === "welcome");
    subscribe(client, {
      type: "subscribe",
      requestId: "request_1",
      subscription: { id: "ticker", topic: "ticker", marketCode: "BTC-USD" },
    });
    await takeMessage(client, ({ type }) => type === "subscribed");
    await takeMessage(client, ({ type }) => type === "snapshot");

    let resolveRead: ((value: { status: "found"; ticker: typeof ticker }) => void) | undefined;
    harness.getTradeTicker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const refresh = harness.gateway.refreshNow();
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    let stopped = false;
    const stop = harness.gateway.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    resolveRead?.({ status: "found", ticker });
    await Promise.all([refresh, stop]);

    expect(stopped).toBe(true);
    expect(harness.gateway.activeConnectionCount).toBe(0);
  });
});
