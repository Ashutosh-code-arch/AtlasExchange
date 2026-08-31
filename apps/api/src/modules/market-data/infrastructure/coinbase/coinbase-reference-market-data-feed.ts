import {
  maximumReferenceMarketDataCandleLimit,
  referenceMarketCodeSchema,
  referenceMarketDataCandleSchema,
  referenceMarketDataTickerResponseSchema,
  type ReferenceMarketCode,
} from "@atlas/contracts";
import type { Logger } from "pino";
import WebSocket from "ws";
import { z } from "zod";

import type {
  ReferenceMarketCandles,
  ReferenceMarketDataReader,
  ReferenceMarketTicker,
} from "../../application/reference-market-data-reader.js";

export const coinbaseReferenceMarketDataUrl = "wss://advanced-trade-ws.coinbase.com";
export const coinbaseReferenceMarketCodes = ["BTC-USD", "ETH-USD"] as const;

const providerDecimalSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .max(100);
const providerTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a timestamp");
const providerSequenceSchema = z.number().int().nonnegative();

const tickerMessageSchema = z.object({
  channel: z.literal("ticker_batch"),
  timestamp: providerTimestampSchema,
  sequence_num: providerSequenceSchema,
  events: z.array(
    z.object({
      type: z.enum(["snapshot", "update"]),
      tickers: z.array(
        z.object({
          type: z.literal("ticker"),
          product_id: referenceMarketCodeSchema,
          price: providerDecimalSchema,
          volume_24_h: providerDecimalSchema,
          low_24_h: providerDecimalSchema,
          high_24_h: providerDecimalSchema,
          price_percent_chg_24_h: providerDecimalSchema,
        }),
      ),
    }),
  ),
});

const candleMessageSchema = z.object({
  channel: z.literal("candles"),
  timestamp: providerTimestampSchema,
  sequence_num: providerSequenceSchema,
  events: z.array(
    z.object({
      type: z.enum(["snapshot", "update"]),
      candles: z.array(
        z.object({
          start: z.string().regex(/^(?:0|[1-9]\d*)$/),
          high: providerDecimalSchema,
          low: providerDecimalSchema,
          open: providerDecimalSchema,
          close: providerDecimalSchema,
          volume: providerDecimalSchema,
          product_id: referenceMarketCodeSchema,
        }),
      ),
    }),
  ),
});

const heartbeatMessageSchema = z.object({
  channel: z.literal("heartbeats"),
  timestamp: providerTimestampSchema,
  sequence_num: providerSequenceSchema,
  events: z.array(
    z.object({
      current_time: z.string().min(1),
      heartbeat_counter: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    }),
  ),
});

const recognizedMessageSchema = z.discriminatedUnion("channel", [
  tickerMessageSchema,
  candleMessageSchema,
  heartbeatMessageSchema,
]);

type CoinbaseReferenceMessage = z.infer<typeof recognizedMessageSchema>;

export type CoinbaseReferenceMessageParseResult =
  | Readonly<{ status: "accepted"; message: CoinbaseReferenceMessage }>
  | Readonly<{ status: "ignored" }>
  | Readonly<{ status: "invalid" }>;

export function parseCoinbaseReferenceMessage(input: string): CoinbaseReferenceMessageParseResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(input);
  } catch {
    return { status: "invalid" };
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("channel" in candidate) ||
    !["ticker_batch", "candles", "heartbeats"].includes(String(candidate.channel))
  ) {
    return { status: "ignored" };
  }
  const result = recognizedMessageSchema.safeParse(candidate);
  return result.success ? { status: "accepted", message: result.data } : { status: "invalid" };
}

export interface CoinbaseWebSocketConnection {
  on(event: string, listener: (...arguments_: readonly unknown[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface CoinbaseReferenceMarketDataFeedOptions {
  readonly logger: Pick<Logger, "info" | "warn">;
  readonly url?: string;
  readonly staleAfterMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaximumDelayMs?: number;
  readonly now?: () => Date;
  readonly webSocketFactory?: (url: string) => CoinbaseWebSocketConnection;
}

interface StoredTicker {
  readonly marketCode: ReferenceMarketCode;
  readonly price: string;
  readonly priceChange24hPercent: string;
  readonly highPrice24h: string;
  readonly lowPrice24h: string;
  readonly baseVolume24h: string;
  readonly observedAt: string;
  readonly receivedAt: string;
}

interface StoredCandleState {
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly candles: Map<string, ReferenceMarketCandles["candles"][number]>;
}

function normalizeDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [rawWhole = "0", rawFraction = ""] = unsigned.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  const magnitude = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function rawMessageToString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("utf8");
  }
  if (Array.isArray(value) && value.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(value).toString("utf8");
  }
  return undefined;
}

export class CoinbaseReferenceMarketDataFeed implements ReferenceMarketDataReader {
  readonly #logger: Pick<Logger, "info" | "warn">;
  readonly #url: string;
  readonly #staleAfterMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #reconnectInitialDelayMs: number;
  readonly #reconnectMaximumDelayMs: number;
  readonly #now: () => Date;
  readonly #webSocketFactory: (url: string) => CoinbaseWebSocketConnection;
  readonly #tickers = new Map<ReferenceMarketCode, StoredTicker>();
  readonly #candles = new Map<ReferenceMarketCode, StoredCandleState>();
  #socket: CoinbaseWebSocketConnection | undefined;
  #running = false;
  #lastHeartbeatAt = 0;
  #connectionOpenedAt = 0;
  #reconnectDelayMs: number;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;

  public constructor(options: CoinbaseReferenceMarketDataFeedOptions) {
    this.#logger = options.logger;
    this.#url = options.url ?? coinbaseReferenceMarketDataUrl;
    this.#staleAfterMs = options.staleAfterMs ?? 15_000;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
    this.#reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1_000;
    this.#reconnectMaximumDelayMs = options.reconnectMaximumDelayMs ?? 30_000;
    this.#reconnectDelayMs = this.#reconnectInitialDelayMs;
    this.#now = options.now ?? (() => new Date());
    this.#webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  public start(): Promise<void> {
    if (this.#running) {
      return Promise.resolve();
    }
    this.#running = true;
    this.#connect();
    this.#heartbeatTimer = setInterval(
      () => this.#checkHeartbeat(),
      Math.max(1_000, Math.floor(this.#heartbeatTimeoutMs / 2)),
    );
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.#running = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "Atlas shutdown");
    return Promise.resolve();
  }

  public getTicker(marketCode: ReferenceMarketCode): ReferenceMarketTicker | undefined {
    const ticker = this.#tickers.get(marketCode);
    if (ticker === undefined) {
      return undefined;
    }
    return referenceMarketDataTickerResponseSchema.parse({
      success: true,
      data: {
        ...ticker,
        source: "coinbase",
        freshness: this.#freshness(ticker.receivedAt),
      },
    }).data;
  }

  public getCandles(
    marketCode: ReferenceMarketCode,
    limit: number,
  ): ReferenceMarketCandles | undefined {
    const state = this.#candles.get(marketCode);
    if (state === undefined) {
      return undefined;
    }
    return {
      marketCode,
      source: "coinbase",
      interval: "5m",
      freshness: this.#freshness(state.receivedAt),
      observedAt: state.observedAt,
      receivedAt: state.receivedAt,
      candles: [...state.candles.values()]
        .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
        .slice(-limit),
    };
  }

  #freshness(receivedAt: string): "live" | "stale" {
    return this.#now().getTime() - Date.parse(receivedAt) <= this.#staleAfterMs ? "live" : "stale";
  }

  #connect(): void {
    if (!this.#running || this.#socket !== undefined) {
      return;
    }
    const socket = this.#webSocketFactory(this.#url);
    this.#socket = socket;
    socket.on("open", () => this.#handleOpen(socket));
    socket.on("message", (value) => this.#handleRawMessage(socket, value));
    socket.on("close", () => this.#handleClose(socket));
    socket.on("error", (error) => this.#handleError(socket, error));
  }

  #handleOpen(socket: CoinbaseWebSocketConnection): void {
    if (socket !== this.#socket || !this.#running) {
      return;
    }
    this.#connectionOpenedAt = this.#now().getTime();
    this.#lastHeartbeatAt = 0;
    this.#reconnectDelayMs = this.#reconnectInitialDelayMs;
    for (const channel of ["ticker_batch", "candles"] as const) {
      socket.send(
        JSON.stringify({ type: "subscribe", product_ids: coinbaseReferenceMarketCodes, channel }),
      );
    }
    socket.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
    this.#logger.info(
      { event: "reference_market_data.connected", source: "coinbase" },
      "Coinbase reference Market Data connected",
    );
  }

  #handleRawMessage(socket: CoinbaseWebSocketConnection, raw: unknown): void {
    if (socket !== this.#socket || !this.#running) {
      return;
    }
    const text = rawMessageToString(raw);
    const result =
      text === undefined ? { status: "invalid" as const } : parseCoinbaseReferenceMessage(text);
    if (result.status === "ignored") {
      return;
    }
    if (result.status === "invalid") {
      this.#logger.warn(
        { event: "reference_market_data.message_rejected", source: "coinbase" },
        "Rejected invalid Coinbase reference Market Data message",
      );
      return;
    }
    this.#applyMessage(result.message);
  }

  #applyMessage(message: CoinbaseReferenceMessage): void {
    const receivedAt = this.#now().toISOString();
    const observedAt = normalizeTimestamp(message.timestamp);
    if (message.channel === "heartbeats") {
      this.#lastHeartbeatAt = this.#now().getTime();
      return;
    }
    if (message.channel === "ticker_batch") {
      for (const event of message.events) {
        for (const ticker of event.tickers) {
          this.#tickers.set(ticker.product_id, {
            marketCode: ticker.product_id,
            price: normalizeDecimal(ticker.price),
            priceChange24hPercent: normalizeDecimal(ticker.price_percent_chg_24_h),
            highPrice24h: normalizeDecimal(ticker.high_24_h),
            lowPrice24h: normalizeDecimal(ticker.low_24_h),
            baseVolume24h: normalizeDecimal(ticker.volume_24_h),
            observedAt,
            receivedAt,
          });
        }
      }
      return;
    }
    for (const event of message.events) {
      for (const candle of event.candles) {
        const startMilliseconds = Number(candle.start) * 1_000;
        const normalized = referenceMarketDataCandleSchema.safeParse({
          start: new Date(startMilliseconds).toISOString(),
          end: new Date(startMilliseconds + 5 * 60_000).toISOString(),
          openPrice: normalizeDecimal(candle.open),
          highPrice: normalizeDecimal(candle.high),
          lowPrice: normalizeDecimal(candle.low),
          closePrice: normalizeDecimal(candle.close),
          baseVolume: normalizeDecimal(candle.volume),
        });
        if (!normalized.success) {
          this.#logger.warn(
            { event: "reference_market_data.candle_rejected", source: "coinbase" },
            "Rejected inconsistent Coinbase reference candle",
          );
          continue;
        }
        const existing = this.#candles.get(candle.product_id);
        const candles = new Map(existing?.candles ?? []);
        candles.set(normalized.data.start, normalized.data);
        const starts = [...candles.keys()].sort(
          (left, right) => Date.parse(left) - Date.parse(right),
        );
        for (const start of starts.slice(0, -maximumReferenceMarketDataCandleLimit)) {
          candles.delete(start);
        }
        this.#candles.set(candle.product_id, { observedAt, receivedAt, candles });
      }
    }
  }

  #handleClose(socket: CoinbaseWebSocketConnection): void {
    if (socket !== this.#socket) {
      return;
    }
    this.#socket = undefined;
    if (!this.#running) {
      return;
    }
    this.#logger.warn(
      { event: "reference_market_data.disconnected", source: "coinbase" },
      "Coinbase reference Market Data disconnected",
    );
    this.#scheduleReconnect();
  }

  #handleError(socket: CoinbaseWebSocketConnection, error: unknown): void {
    if (socket !== this.#socket) {
      return;
    }
    this.#logger.warn(
      {
        event: "reference_market_data.connection_error",
        source: "coinbase",
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "Coinbase reference Market Data connection failed",
    );
    socket.terminate();
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer !== undefined) {
      return;
    }
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, this.#reconnectMaximumDelayMs);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #checkHeartbeat(): void {
    const socket = this.#socket;
    if (socket === undefined || this.#connectionOpenedAt === 0) {
      return;
    }
    const heartbeatReference = this.#lastHeartbeatAt || this.#connectionOpenedAt;
    if (this.#now().getTime() - heartbeatReference > this.#heartbeatTimeoutMs) {
      this.#logger.warn(
        { event: "reference_market_data.heartbeat_timed_out", source: "coinbase" },
        "Coinbase reference Market Data heartbeat timed out",
      );
      socket.terminate();
    }
  }
}
