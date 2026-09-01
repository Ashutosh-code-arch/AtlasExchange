import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  marketDataStreamClientMessageSchema,
  marketDataStreamEndpoint,
  marketDataStreamProtocol,
  marketDataStreamServerMessageSchema,
  type MarketDataCandlesResponse,
  type MarketDataOrderBookResponse,
  type MarketDataStreamClientMessage,
  type MarketDataStreamErrorCode,
  type MarketDataStreamServerMessage,
  type MarketDataStreamSubscription,
  type MarketDataTickerResponse,
} from "@atlas/contracts";
import type { Logger } from "pino";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { GetLevelTwoOrderBook } from "../../application/get-level-two-order-book.js";
import type { GetPublicCandles } from "../../application/get-public-candles.js";
import type { GetPublicTradeTicker } from "../../application/get-public-trade-ticker.js";
import type { AccessTokenVerifier } from "../../../../platform/security/cloudflare-access-token-verifier.js";
import {
  demoGatewaySecretHeader,
  matchesDemoGatewaySecret,
} from "../../../../platform/security/demo-gateway-authentication.js";
import { readCloudflareAccessAssertion } from "../../../../platform/security/staging-access.js";

export interface MarketDataStreamQueries {
  readonly getCandles: Pick<GetPublicCandles, "execute">;
  readonly getLevelTwoOrderBook: Pick<GetLevelTwoOrderBook, "execute">;
  readonly getTradeTicker: Pick<GetPublicTradeTicker, "execute">;
}

export interface MarketDataStreamGatewayOptions extends MarketDataStreamQueries {
  readonly server: Server;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  readonly webOrigin: string;
  readonly refreshIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maximumConnections: number;
  readonly maximumConnectionsPerClient: number;
  readonly maximumSubscriptionsPerConnection: number;
  readonly maximumMessageBytes: number;
  readonly maximumBufferedBytes: number;
  readonly stagingAccessTokenVerifier?: AccessTokenVerifier;
  readonly demoGatewaySharedSecret?: string;
  readonly now?: () => Date;
}

interface ConnectionState {
  readonly id: string;
  readonly clientKey: string;
  readonly socket: WebSocket;
  readonly subscriptions: Map<string, MarketDataStreamSubscription>;
  alive: boolean;
  invalidMessages: number;
  messageQueue: Promise<void>;
}

type SnapshotPayload =
  | { readonly topic: "order_book"; readonly data: MarketDataOrderBookResponse["data"] }
  | { readonly topic: "ticker"; readonly data: MarketDataTickerResponse["data"] }
  | { readonly topic: "candles"; readonly data: MarketDataCandlesResponse["data"] };

interface SnapshotRecipients {
  readonly subscription: MarketDataStreamSubscription;
  readonly recipients: Array<{
    readonly state: ConnectionState;
    readonly subscriptionId: string;
  }>;
}

const maximumInvalidMessages = 3;
const gracefulClientCloseMilliseconds = 500;

function rawDataText(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function subscriptionKey(subscription: MarketDataStreamSubscription): string {
  switch (subscription.topic) {
    case "order_book":
      return `${subscription.topic}:${subscription.marketCode}:${subscription.depth}`;
    case "ticker":
      return `${subscription.topic}:${subscription.marketCode}`;
    case "candles":
      return `${subscription.topic}:${subscription.marketCode}:${subscription.interval}:${subscription.limit}`;
  }
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}

function hasProtocol(request: IncomingMessage): boolean {
  const header = request.headers["sec-websocket-protocol"];
  return (
    typeof header === "string" &&
    header
      .split(",")
      .map((value) => value.trim())
      .includes(marketDataStreamProtocol)
  );
}

function waitForClientClose(state: ConnectionState): Promise<void> {
  if (state.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      state.socket.terminate();
      resolve();
    }, gracefulClientCloseMilliseconds);
    state.socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export class MarketDataStreamGateway {
  private readonly webSocketServer: WebSocketServer;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly connectionsPerClient = new Map<string, number>();
  private readonly failedSubscriptionKeys = new Set<string>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private refreshTask: Promise<void> | undefined;
  private started = false;

  public constructor(private readonly options: MarketDataStreamGatewayOptions) {
    for (const [name, value] of Object.entries({
      refreshIntervalMs: options.refreshIntervalMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      maximumConnections: options.maximumConnections,
      maximumConnectionsPerClient: options.maximumConnectionsPerClient,
      maximumSubscriptionsPerConnection: options.maximumSubscriptionsPerConnection,
      maximumMessageBytes: options.maximumMessageBytes,
      maximumBufferedBytes: options.maximumBufferedBytes,
    })) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(`Market Data stream option ${name} is invalid.`);
      }
    }
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: options.maximumMessageBytes,
      handleProtocols: (protocols) =>
        protocols.has(marketDataStreamProtocol) ? marketDataStreamProtocol : false,
    });
    this.webSocketServer.on("wsClientError", (error, socket) => {
      this.options.logger.warn(
        { event: "market_data.stream.handshake_failed", errorName: error.name },
        "Market Data stream handshake failed",
      );
      rejectUpgrade(socket, 400, "Bad Request");
    });
  }

  public get activeConnectionCount(): number {
    return this.connections.size;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.options.server.on("upgrade", this.handleUpgrade);
    this.refreshTimer = setInterval(
      () => void this.triggerRefresh(),
      this.options.refreshIntervalMs,
    );
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.options.heartbeatIntervalMs);
    this.refreshTimer.unref();
    this.heartbeatTimer.unref();
    this.options.logger.info(
      {
        event: "market_data.stream.started",
        endpoint: marketDataStreamEndpoint,
        refreshIntervalMs: this.options.refreshIntervalMs,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        maximumConnections: this.options.maximumConnections,
      },
      "Market Data stream started",
    );
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.options.server.off("upgrade", this.handleUpgrade);
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.refreshTimer = undefined;
    this.heartbeatTimer = undefined;
    const states = [...this.connections.values()];
    const closing = states.map((state) => {
      if (state.socket.readyState === WebSocket.OPEN) {
        state.socket.close(1001, "Atlas server is shutting down.");
      } else if (state.socket.readyState === WebSocket.CONNECTING) {
        state.socket.terminate();
      }
      return waitForClientClose(state);
    });
    await Promise.all(closing);
    await Promise.all([
      ...(this.refreshTask === undefined ? [] : [this.refreshTask]),
      ...states.map((state) => state.messageQueue),
    ]);
    this.options.logger.info({ event: "market_data.stream.stopped" }, "Market Data stream stopped");
  }

  public forceCloseConnections(): void {
    for (const state of this.connections.values()) state.socket.terminate();
  }

  public async refreshNow(): Promise<void> {
    await this.triggerRefresh();
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void this.handleUpgradeRequest(request, socket, head).catch(() => {
      rejectUpgrade(socket, 403, "Forbidden");
    });
  };

  private async handleUpgradeRequest(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.started) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (this.options.stagingAccessTokenVerifier !== undefined) {
      const token = readCloudflareAccessAssertion(request.headers["cf-access-jwt-assertion"]);
      if (token === undefined || !(await this.options.stagingAccessTokenVerifier(token))) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
    }
    if (
      this.options.demoGatewaySharedSecret !== undefined &&
      !matchesDemoGatewaySecret(
        request.headers[demoGatewaySecretHeader],
        this.options.demoGatewaySharedSecret,
      )
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://atlas.invalid");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (
      request.method !== "GET" ||
      url.pathname !== marketDataStreamEndpoint ||
      url.search !== ""
    ) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (request.headers.origin !== this.options.webOrigin) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!hasProtocol(request)) {
      rejectUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    if (this.connections.size >= this.options.maximumConnections) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const clientKey = request.socket.remoteAddress ?? "unknown";
    if (
      (this.connectionsPerClient.get(clientKey) ?? 0) >= this.options.maximumConnectionsPerClient
    ) {
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }

    const handleSocketError = (): void => {
      socket.destroy();
    };
    socket.on("error", handleSocketError);
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      socket.off("error", handleSocketError);
      this.acceptConnection(webSocket, clientKey);
    });
  }

  private acceptConnection(socket: WebSocket, clientKey: string): void {
    const state: ConnectionState = {
      id: randomUUID(),
      clientKey,
      socket,
      subscriptions: new Map(),
      alive: true,
      invalidMessages: 0,
      messageQueue: Promise.resolve(),
    };
    this.connections.set(socket, state);
    this.connectionsPerClient.set(clientKey, (this.connectionsPerClient.get(clientKey) ?? 0) + 1);
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("error", (error) => {
      this.options.logger.warn(
        { event: "market_data.stream.client_error", connectionId: state.id, errorName: error.name },
        "Market Data stream client failed",
      );
    });
    socket.on("close", () => this.removeConnection(state));
    socket.on("message", (data, isBinary) => this.receiveMessage(state, data, isBinary));
    this.send(state, {
      type: "welcome",
      protocol: marketDataStreamProtocol,
      serverTime: this.options.now?.().toISOString() ?? new Date().toISOString(),
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      maximumSubscriptions: this.options.maximumSubscriptionsPerConnection,
    });
    this.options.logger.info(
      {
        event: "market_data.stream.connected",
        connectionId: state.id,
        activeConnections: this.connections.size,
      },
      "Market Data stream client connected",
    );
  }

  private removeConnection(state: ConnectionState): void {
    if (!this.connections.delete(state.socket)) return;
    const count = (this.connectionsPerClient.get(state.clientKey) ?? 1) - 1;
    if (count <= 0) this.connectionsPerClient.delete(state.clientKey);
    else this.connectionsPerClient.set(state.clientKey, count);
    this.options.logger.info(
      {
        event: "market_data.stream.disconnected",
        connectionId: state.id,
        activeConnections: this.connections.size,
      },
      "Market Data stream client disconnected",
    );
  }

  private receiveMessage(state: ConnectionState, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      state.socket.close(1003, "Binary messages are not supported.");
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(rawDataText(data)) as unknown;
    } catch {
      this.rejectInvalidMessage(state);
      return;
    }
    const result = marketDataStreamClientMessageSchema.safeParse(input);
    if (!result.success) {
      this.rejectInvalidMessage(state);
      return;
    }
    state.invalidMessages = 0;
    state.messageQueue = state.messageQueue
      .then(() => this.processClientMessage(state, result.data))
      .catch((error: unknown) => {
        this.options.logger.error(
          {
            event: "market_data.stream.message_failed",
            connectionId: state.id,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Market Data stream message failed",
        );
        this.sendError(
          state,
          result.data.requestId,
          result.data.type === "subscribe"
            ? result.data.subscription.id
            : result.data.subscriptionId,
          "STREAM_UNAVAILABLE",
          "Market Data stream is temporarily unavailable.",
        );
      });
  }

  private rejectInvalidMessage(state: ConnectionState): void {
    state.invalidMessages += 1;
    this.sendError(
      state,
      null,
      null,
      "VALIDATION_FAILED",
      "Market Data stream message is invalid.",
    );
    if (state.invalidMessages >= maximumInvalidMessages) {
      state.socket.close(1008, "Too many invalid messages.");
    }
  }

  private async processClientMessage(
    state: ConnectionState,
    message: MarketDataStreamClientMessage,
  ): Promise<void> {
    if (message.type === "unsubscribe") {
      state.subscriptions.delete(message.subscriptionId);
      this.send(state, {
        type: "unsubscribed",
        requestId: message.requestId,
        subscriptionId: message.subscriptionId,
      });
      return;
    }
    const subscription = message.subscription;
    if (state.subscriptions.has(subscription.id)) {
      this.sendError(
        state,
        message.requestId,
        subscription.id,
        "SUBSCRIPTION_CONFLICT",
        "Subscription identifier is already active.",
      );
      return;
    }
    if (state.subscriptions.size >= this.options.maximumSubscriptionsPerConnection) {
      this.sendError(
        state,
        message.requestId,
        subscription.id,
        "SUBSCRIPTION_LIMIT",
        "Market Data subscription limit exceeded.",
      );
      return;
    }
    const payload = await this.loadSnapshot(subscription);
    if (payload === null) {
      this.sendError(
        state,
        message.requestId,
        subscription.id,
        "MARKET_NOT_FOUND",
        "Market was not found.",
      );
      return;
    }
    state.subscriptions.set(subscription.id, subscription);
    this.send(state, { type: "subscribed", requestId: message.requestId, subscription });
    this.sendSnapshot(state, subscription.id, payload);
  }

  private async loadSnapshot(
    subscription: MarketDataStreamSubscription,
  ): Promise<SnapshotPayload | null> {
    switch (subscription.topic) {
      case "order_book": {
        const result = await this.options.getLevelTwoOrderBook.execute({
          marketCode: subscription.marketCode,
          depth: subscription.depth,
        });
        return result.status === "not_found"
          ? null
          : {
              topic: "order_book",
              data: {
                ...result.orderBook,
                bids: [...result.orderBook.bids],
                asks: [...result.orderBook.asks],
              },
            };
      }
      case "ticker": {
        const result = await this.options.getTradeTicker.execute({
          marketCode: subscription.marketCode,
        });
        return result.status === "not_found" ? null : { topic: "ticker", data: result.ticker };
      }
      case "candles": {
        const result = await this.options.getCandles.execute({
          marketCode: subscription.marketCode,
          interval: subscription.interval,
          limit: subscription.limit,
        });
        return result.status === "not_found"
          ? null
          : {
              topic: "candles",
              data: { ...result.history, candles: [...result.history.candles] },
            };
      }
    }
  }

  private triggerRefresh(): Promise<void> {
    if (!this.started) return Promise.resolve();
    if (this.refreshTask !== undefined) return this.refreshTask;
    const task = this.refreshSubscriptions().finally(() => {
      if (this.refreshTask === task) this.refreshTask = undefined;
    });
    this.refreshTask = task;
    return task;
  }

  private async refreshSubscriptions(): Promise<void> {
    const subscriptions = new Map<string, SnapshotRecipients>();
    for (const state of this.connections.values()) {
      for (const subscription of state.subscriptions.values()) {
        const key = subscriptionKey(subscription);
        const existing = subscriptions.get(key);
        const recipient = { state, subscriptionId: subscription.id };
        if (existing === undefined) {
          subscriptions.set(key, { subscription, recipients: [recipient] });
        } else {
          existing.recipients.push(recipient);
        }
      }
    }
    await Promise.all(
      [...subscriptions].map(async ([key, entry]) => {
        try {
          const payload = await this.loadSnapshot(entry.subscription);
          this.failedSubscriptionKeys.delete(key);
          if (payload === null) {
            for (const recipient of entry.recipients) {
              recipient.state.subscriptions.delete(recipient.subscriptionId);
              this.sendError(
                recipient.state,
                null,
                recipient.subscriptionId,
                "MARKET_NOT_FOUND",
                "Market was not found.",
              );
            }
            return;
          }
          for (const recipient of entry.recipients) {
            this.sendSnapshot(recipient.state, recipient.subscriptionId, payload);
          }
        } catch (error) {
          if (!this.failedSubscriptionKeys.has(key)) {
            this.failedSubscriptionKeys.add(key);
            this.options.logger.error(
              {
                event: "market_data.stream.refresh_failed",
                topic: entry.subscription.topic,
                marketCode: entry.subscription.marketCode,
                errorName: error instanceof Error ? error.name : "UnknownError",
              },
              "Market Data stream refresh failed",
            );
            for (const recipient of entry.recipients) {
              this.sendError(
                recipient.state,
                null,
                recipient.subscriptionId,
                "STREAM_UNAVAILABLE",
                "Market Data stream is temporarily unavailable.",
              );
            }
          }
        }
      }),
    );
  }

  private heartbeat(): void {
    const serverTime = this.options.now?.().toISOString() ?? new Date().toISOString();
    for (const state of this.connections.values()) {
      if (!state.alive) {
        state.socket.terminate();
        continue;
      }
      state.alive = false;
      state.socket.ping();
      this.send(state, { type: "heartbeat", serverTime });
    }
  }

  private sendSnapshot(
    state: ConnectionState,
    subscriptionId: string,
    payload: SnapshotPayload,
  ): void {
    switch (payload.topic) {
      case "order_book":
        this.send(state, { type: "snapshot", subscriptionId, ...payload });
        return;
      case "ticker":
        this.send(state, { type: "snapshot", subscriptionId, ...payload });
        return;
      case "candles":
        this.send(state, { type: "snapshot", subscriptionId, ...payload });
        return;
    }
  }

  private sendError(
    state: ConnectionState,
    requestId: string | null,
    subscriptionId: string | null,
    code: MarketDataStreamErrorCode,
    message: string,
  ): void {
    this.send(state, { type: "error", requestId, subscriptionId, code, message });
  }

  private send(state: ConnectionState, input: MarketDataStreamServerMessage): void {
    if (state.socket.readyState !== WebSocket.OPEN) return;
    if (state.socket.bufferedAmount > this.options.maximumBufferedBytes) {
      state.socket.close(1013, "Client is not consuming Market Data quickly enough.");
      return;
    }
    const message = marketDataStreamServerMessageSchema.parse(input);
    state.socket.send(JSON.stringify(message));
  }
}
