import {
  marketDataStreamClientMessageSchema,
  marketDataStreamEndpoint,
  marketDataStreamProtocol,
  marketDataStreamServerMessageSchema,
  marketDataStreamSubscriptionSchema,
  type MarketDataStreamCandlesSubscription,
  type MarketDataStreamOrderBookSubscription,
  type MarketDataStreamServerMessage,
  type MarketDataStreamSnapshotMessage,
  type MarketDataStreamSubscription,
  type MarketDataStreamTickerSubscription,
} from "@atlas/contracts";

export type MarketDataStreamSubscriptionInput =
  | Omit<MarketDataStreamOrderBookSubscription, "id">
  | Omit<MarketDataStreamTickerSubscription, "id">
  | Omit<MarketDataStreamCandlesSubscription, "id">;

export interface MarketDataStreamObserver {
  readonly onSnapshot: (message: MarketDataStreamSnapshotMessage) => void;
  readonly onUnavailable: () => void;
}

export interface MarketDataStreamSubscriptionHandle {
  readonly retry: () => void;
  readonly unsubscribe: () => void;
}

export interface MarketDataSubscriptionClient {
  subscribe(
    subscription: MarketDataStreamSubscriptionInput,
    observer: MarketDataStreamObserver,
  ): MarketDataStreamSubscriptionHandle;
  dispose(): void;
}

interface SubscriptionRecord {
  readonly subscription: MarketDataStreamSubscription;
  readonly observer: MarketDataStreamObserver;
  lastSequence: bigint | null;
}

interface VisibilityDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface BrowserMarketDataStreamClientOptions {
  readonly apiBaseUrl: string;
  readonly webSocketFactory?: (url: string, protocol: string) => WebSocket;
  readonly visibilityDocument?: VisibilityDocument;
  readonly initialReconnectDelayMs?: number;
  readonly maximumReconnectDelayMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const webSocketConnecting = 0;
const webSocketOpen = 1;
const heartbeatGraceMultiplier = 2.5;

export function marketDataStreamUrl(apiBaseUrl: string): string {
  const url = new URL(marketDataStreamEndpoint, `${apiBaseUrl.replace(/\/$/, "")}/`);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new TypeError("Market Data stream requires an HTTP API base URL.");
  return url.toString();
}

function snapshotMatches(
  subscription: MarketDataStreamSubscription,
  message: MarketDataStreamSnapshotMessage,
): boolean {
  if (subscription.topic !== message.topic || subscription.marketCode !== message.data.marketCode) {
    return false;
  }
  switch (subscription.topic) {
    case "order_book":
      return message.topic === "order_book" && subscription.depth === message.data.depth;
    case "ticker":
      return message.topic === "ticker";
    case "candles":
      return (
        message.topic === "candles" &&
        subscription.interval === message.data.interval &&
        subscription.limit === message.data.limit
      );
  }
}

export class BrowserMarketDataStreamClient implements MarketDataSubscriptionClient {
  private readonly url: string;
  private readonly webSocketFactory: (url: string, protocol: string) => WebSocket;
  private readonly visibilityDocument: VisibilityDocument;
  private readonly initialReconnectDelayMs: number;
  private readonly maximumReconnectDelayMs: number;
  private readonly setTimer: NonNullable<BrowserMarketDataStreamClientOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<BrowserMarketDataStreamClientOptions["clearTimer"]>;
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatIntervalMs: number | undefined;
  private subscriptionSequence = 0;
  private requestSequence = 0;
  private reconnectAttempts = 0;
  private welcomed = false;
  private disposed = false;

  public constructor(options: BrowserMarketDataStreamClientOptions) {
    this.url = marketDataStreamUrl(options.apiBaseUrl);
    this.webSocketFactory =
      options.webSocketFactory ?? ((url, protocol) => new WebSocket(url, protocol));
    this.visibilityDocument = options.visibilityDocument ?? document;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 250;
    this.maximumReconnectDelayMs = options.maximumReconnectDelayMs ?? 8_000;
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));
    if (
      !Number.isInteger(this.initialReconnectDelayMs) ||
      this.initialReconnectDelayMs < 1 ||
      !Number.isInteger(this.maximumReconnectDelayMs) ||
      this.maximumReconnectDelayMs < this.initialReconnectDelayMs
    ) {
      throw new RangeError("Market Data reconnect configuration is invalid.");
    }
  }

  public subscribe(
    input: MarketDataStreamSubscriptionInput,
    observer: MarketDataStreamObserver,
  ): MarketDataStreamSubscriptionHandle {
    if (this.disposed) throw new Error("Market Data stream client is disposed.");
    this.subscriptionSequence += 1;
    const id = `subscription_${this.subscriptionSequence}`;
    const subscription = marketDataStreamSubscriptionSchema.parse({ id, ...input });
    const wasIdle = this.subscriptions.size === 0;
    this.subscriptions.set(id, { subscription, observer, lastSequence: null });
    if (wasIdle) {
      this.visibilityDocument.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    if (this.welcomed && this.socket?.readyState === webSocketOpen) {
      this.sendSubscribe(subscription);
    } else {
      this.ensureConnected();
    }
    let active = true;
    return {
      retry: () => {
        if (!active) return;
        this.retrySubscription(id);
      },
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.unsubscribe(id);
      },
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visibilityDocument.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.cancelReconnect();
    this.cancelHeartbeatWatchdog();
    this.subscriptions.clear();
    this.closeSocket(1000, "Market Data client disposed.");
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.visibilityDocument.visibilityState === "hidden") {
      this.cancelReconnect();
      this.cancelHeartbeatWatchdog();
      this.closeSocket(1000, "Market Data paused while hidden.");
      return;
    }
    this.notifyUnavailable();
    this.ensureConnected();
  };

  private ensureConnected(): void {
    if (
      this.disposed ||
      this.subscriptions.size === 0 ||
      this.visibilityDocument.visibilityState !== "visible" ||
      this.socket?.readyState === webSocketConnecting ||
      this.socket?.readyState === webSocketOpen
    ) {
      return;
    }
    this.cancelReconnect();
    const socket = this.webSocketFactory(this.url, marketDataStreamProtocol);
    this.socket = socket;
    this.welcomed = false;
    socket.onopen = () => undefined;
    socket.onmessage = (event) => this.receiveMessage(socket, event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => this.handleClose(socket);
  }

  private receiveMessage(socket: WebSocket, data: unknown): void {
    if (this.socket !== socket) return;
    if (typeof data !== "string") {
      socket.close(1002, "Market Data protocol violation.");
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(data) as unknown;
    } catch {
      socket.close(1002, "Market Data protocol violation.");
      return;
    }
    const result = marketDataStreamServerMessageSchema.safeParse(input);
    if (!result.success) {
      socket.close(1002, "Market Data protocol violation.");
      return;
    }
    this.processMessage(socket, result.data);
  }

  private processMessage(socket: WebSocket, message: MarketDataStreamServerMessage): void {
    switch (message.type) {
      case "welcome":
        if (this.welcomed) {
          socket.close(1002, "Duplicate Market Data welcome.");
          return;
        }
        this.welcomed = true;
        this.reconnectAttempts = 0;
        this.heartbeatIntervalMs = message.heartbeatIntervalMs;
        this.resetHeartbeatWatchdog();
        for (const record of this.subscriptions.values()) this.sendSubscribe(record.subscription);
        return;
      case "heartbeat":
        if (!this.welcomed) {
          socket.close(1002, "Market Data heartbeat before welcome.");
          return;
        }
        this.resetHeartbeatWatchdog();
        return;
      case "snapshot": {
        const record = this.subscriptions.get(message.subscriptionId);
        if (record === undefined) return;
        if (!snapshotMatches(record.subscription, message)) {
          socket.close(1002, "Cross-routed Market Data snapshot.");
          return;
        }
        const sequence = BigInt(message.data.sequence);
        if (record.lastSequence !== null && sequence < record.lastSequence) return;
        record.lastSequence = sequence;
        record.observer.onSnapshot(message);
        return;
      }
      case "error":
        if (message.subscriptionId === null) this.notifyUnavailable();
        else this.subscriptions.get(message.subscriptionId)?.observer.onUnavailable();
        return;
      case "subscribed":
      case "unsubscribed":
        return;
    }
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.welcomed = false;
    this.cancelHeartbeatWatchdog();
    if (
      this.disposed ||
      this.subscriptions.size === 0 ||
      this.visibilityDocument.visibilityState !== "visible"
    ) {
      return;
    }
    this.notifyUnavailable();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    const delay = Math.min(
      this.initialReconnectDelayMs * 2 ** this.reconnectAttempts,
      this.maximumReconnectDelayMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      this.ensureConnected();
    }, delay);
  }

  private retrySubscription(subscriptionId: string): void {
    const record = this.subscriptions.get(subscriptionId);
    if (record === undefined) return;
    record.observer.onUnavailable();
    if (!this.welcomed || this.socket?.readyState !== webSocketOpen) {
      this.cancelReconnect();
      this.ensureConnected();
      return;
    }
    this.send({
      type: "unsubscribe",
      requestId: this.nextRequestId(),
      subscriptionId,
    });
    this.sendSubscribe(record.subscription);
  }

  private unsubscribe(subscriptionId: string): void {
    if (!this.subscriptions.delete(subscriptionId)) return;
    if (this.welcomed && this.socket?.readyState === webSocketOpen) {
      this.send({ type: "unsubscribe", requestId: this.nextRequestId(), subscriptionId });
    }
    if (this.subscriptions.size > 0) return;
    this.visibilityDocument.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.cancelReconnect();
    this.cancelHeartbeatWatchdog();
    this.closeSocket(1000, "No active Market Data subscriptions.");
  }

  private sendSubscribe(subscription: MarketDataStreamSubscription): void {
    this.send({ type: "subscribe", requestId: this.nextRequestId(), subscription });
  }

  private send(input: unknown): void {
    const socket = this.socket;
    if (!this.welcomed || socket?.readyState !== webSocketOpen) return;
    const message = marketDataStreamClientMessageSchema.parse(input);
    socket.send(JSON.stringify(message));
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `request_${this.requestSequence}`;
  }

  private notifyUnavailable(): void {
    for (const record of this.subscriptions.values()) record.observer.onUnavailable();
  }

  private resetHeartbeatWatchdog(): void {
    this.cancelHeartbeatWatchdog();
    if (this.heartbeatIntervalMs === undefined) return;
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = undefined;
      this.socket?.close(4000, "Market Data heartbeat timed out.");
    }, this.heartbeatIntervalMs * heartbeatGraceMultiplier);
  }

  private cancelHeartbeatWatchdog(): void {
    if (this.heartbeatTimer === undefined) return;
    this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === undefined) return;
    if (socket.readyState === webSocketConnecting || socket.readyState === webSocketOpen) {
      socket.close(code, reason);
    }
  }
}
