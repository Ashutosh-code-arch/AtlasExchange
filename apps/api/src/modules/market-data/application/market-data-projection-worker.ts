import type {
  MarketCode,
  TradingMarketReader,
  TradingPublicationSequenceReader,
} from "../../trading/index.js";
import type {
  ProjectLevelTwoOrderBook,
  ProjectLevelTwoOrderBookResult,
} from "./level-two-order-book-projection.js";

export type MarketDataProjectionWorkerMarketState =
  "behind" | "caught_up" | "failed" | "starting" | "stopped";

export interface MarketDataProjectionWorkerMarketStatus {
  readonly marketCode: MarketCode;
  readonly state: MarketDataProjectionWorkerMarketState;
  readonly projectedSequence: bigint;
  readonly publishedSequence: bigint;
  readonly lag: bigint;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastErrorName: string | null;
}

export interface MarketDataProjectionWorkerStatus {
  readonly running: boolean;
  readonly startedAt: Date | null;
  readonly stoppedAt: Date | null;
  readonly markets: readonly MarketDataProjectionWorkerMarketStatus[];
}

export interface MarketDataProjectionWorkerOptions {
  readonly batchSize: number;
  readonly maximumBatchesPerCycle: number;
  readonly pollIntervalMs: number;
  readonly retryInitialDelayMs: number;
  readonly retryMaximumDelayMs: number;
}

export interface MarketDataWorkerScheduler {
  now(): Date;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface MarketDataWorkerLogger {
  readonly debug: (context: Readonly<Record<string, unknown>>, message: string) => void;
  readonly error: (context: Readonly<Record<string, unknown>>, message: string) => void;
  readonly info: (context: Readonly<Record<string, unknown>>, message: string) => void;
}

interface MutableMarketStatus {
  marketCode: MarketCode;
  state: MarketDataProjectionWorkerMarketState;
  projectedSequence: bigint;
  publishedSequence: bigint;
  lag: bigint;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorName: string | null;
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const complete = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", complete);
      resolve();
    };
    const timer = setTimeout(complete, delayMs);
    signal.addEventListener("abort", complete, { once: true });
  });
}

const systemScheduler: MarketDataWorkerScheduler = {
  now: () => new Date(),
  sleep: abortableSleep,
};

function validateOptions(options: MarketDataProjectionWorkerOptions): void {
  const positiveIntegers = [
    options.batchSize,
    options.maximumBatchesPerCycle,
    options.pollIntervalMs,
    options.retryInitialDelayMs,
    options.retryMaximumDelayMs,
  ];
  if (
    positiveIntegers.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    options.batchSize > 1_000 ||
    options.retryMaximumDelayMs < options.retryInitialDelayMs
  ) {
    throw new RangeError("Market Data projection worker configuration is invalid.");
  }
}

function retryDelay(
  options: MarketDataProjectionWorkerOptions,
  consecutiveFailures: number,
): number {
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(options.retryMaximumDelayMs, options.retryInitialDelayMs * 2 ** exponent);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownProjectionError";
}

function wasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function cloneDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value);
}

export class MarketDataProjectionWorker {
  private controller: AbortController | undefined;
  private tasks: readonly Promise<void>[] = [];
  private stopTask: Promise<void> | undefined;
  private startedAt: Date | null = null;
  private stoppedAt: Date | null = null;
  private readonly marketStatuses = new Map<MarketCode, MutableMarketStatus>();

  public constructor(
    private readonly markets: Pick<TradingMarketReader, "list">,
    private readonly projector: Pick<ProjectLevelTwoOrderBook, "execute">,
    private readonly publicationSequences: TradingPublicationSequenceReader,
    private readonly logger: MarketDataWorkerLogger,
    private readonly options: MarketDataProjectionWorkerOptions,
    private readonly scheduler: MarketDataWorkerScheduler = systemScheduler,
  ) {
    validateOptions(options);
  }

  public getStatus(): MarketDataProjectionWorkerStatus {
    return {
      running: this.controller !== undefined,
      startedAt: cloneDate(this.startedAt),
      stoppedAt: cloneDate(this.stoppedAt),
      markets: [...this.marketStatuses.values()]
        .sort((left, right) => left.marketCode.localeCompare(right.marketCode))
        .map((status) => ({
          ...status,
          lastSuccessAt: cloneDate(status.lastSuccessAt),
          lastFailureAt: cloneDate(status.lastFailureAt),
        })),
    };
  }

  public async start(): Promise<void> {
    if (this.controller !== undefined) {
      return;
    }
    if (this.stopTask !== undefined) {
      await this.stopTask;
    }
    const marketCodes = [
      ...new Set((await this.markets.list()).map((market) => market.code)),
    ].sort();
    if (marketCodes.length === 0) {
      throw new Error("Market Data projection worker requires at least one Trading market.");
    }
    const controller = new AbortController();
    this.controller = controller;
    this.startedAt = this.scheduler.now();
    this.stoppedAt = null;
    this.marketStatuses.clear();
    for (const marketCode of marketCodes) {
      this.marketStatuses.set(marketCode, {
        marketCode,
        state: "starting",
        projectedSequence: 0n,
        publishedSequence: 0n,
        lag: 0n,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastErrorName: null,
      });
    }
    this.logger.info(
      {
        event: "market_data.projection_worker.started",
        markets: marketCodes,
        batchSize: this.options.batchSize,
        maximumBatchesPerCycle: this.options.maximumBatchesPerCycle,
        pollIntervalMs: this.options.pollIntervalMs,
      },
      "Market Data projection worker started",
    );
    this.tasks = marketCodes.map((marketCode) => this.runMarketLoop(marketCode, controller.signal));
  }

  public stop(): Promise<void> {
    this.stopTask ??= this.stopActiveWorker().finally(() => {
      this.stopTask = undefined;
    });
    return this.stopTask;
  }

  private async stopActiveWorker(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) {
      return;
    }
    controller.abort();
    await Promise.all(this.tasks);
    const stoppedAt = this.scheduler.now();
    for (const status of this.marketStatuses.values()) {
      status.state = "stopped";
    }
    this.controller = undefined;
    this.tasks = [];
    this.stoppedAt = stoppedAt;
    this.logger.info(
      { event: "market_data.projection_worker.stopped" },
      "Market Data projection worker stopped",
    );
  }

  private async runMarketLoop(marketCode: MarketCode, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.projectMarketCycle(marketCode);
        await this.scheduler.sleep(this.options.pollIntervalMs, signal);
      } catch (error) {
        if (wasAborted(signal)) {
          return;
        }
        const status = this.marketStatuses.get(marketCode);
        if (status === undefined) {
          throw error;
        }
        status.state = "failed";
        status.consecutiveFailures += 1;
        status.lastFailureAt = this.scheduler.now();
        status.lastErrorName = errorName(error);
        const delayMs = retryDelay(this.options, status.consecutiveFailures);
        this.logger.error(
          {
            event: "market_data.projection.failed",
            err: error,
            marketCode,
            projectedSequence: status.projectedSequence.toString(),
            publishedSequence: status.publishedSequence.toString(),
            lag: status.lag.toString(),
            consecutiveFailures: status.consecutiveFailures,
            retryDelayMs: delayMs,
          },
          "Market Data projection cycle failed",
        );
        await this.scheduler.sleep(delayMs, signal);
      }
    }
  }

  private async projectMarketCycle(marketCode: MarketCode): Promise<void> {
    let latestResult: ProjectLevelTwoOrderBookResult | undefined;
    let appliedCount = 0;
    for (let batch = 0; batch < this.options.maximumBatchesPerCycle; batch += 1) {
      latestResult = await this.projector.execute({
        marketCode,
        limit: this.options.batchSize,
      });
      appliedCount += latestResult.appliedCount;
      if (latestResult.caughtUp) {
        break;
      }
    }
    if (latestResult === undefined) {
      throw new Error("Market Data projection cycle executed no batches.");
    }
    const publishedSequence = await this.publicationSequences.getLastPublishedSequence(marketCode);
    if (publishedSequence < latestResult.lastSequence) {
      throw new Error("Trading publication sequence is behind the Market Data checkpoint.");
    }
    const status = this.marketStatuses.get(marketCode);
    if (status === undefined) {
      throw new Error(`Market Data projection status is unavailable for ${marketCode}.`);
    }
    const previousState = status.state;
    const previousProjectedSequence = status.projectedSequence;
    const previousPublishedSequence = status.publishedSequence;
    const previousLag = status.lag;
    const previousFailures = status.consecutiveFailures;
    const lag = publishedSequence - latestResult.lastSequence;
    status.state = lag === 0n ? "caught_up" : "behind";
    status.projectedSequence = latestResult.lastSequence;
    status.publishedSequence = publishedSequence;
    status.lag = lag;
    status.consecutiveFailures = 0;
    status.lastSuccessAt = this.scheduler.now();
    status.lastErrorName = null;
    if (previousFailures > 0) {
      this.logger.info(
        {
          event: "market_data.projection.recovered",
          marketCode,
          projectedSequence: latestResult.lastSequence.toString(),
          publishedSequence: publishedSequence.toString(),
          lag: lag.toString(),
          previousFailures,
        },
        "Market Data projection recovered",
      );
    }
    if (
      appliedCount > 0 ||
      previousState !== status.state ||
      previousProjectedSequence !== latestResult.lastSequence ||
      previousPublishedSequence !== publishedSequence ||
      previousLag !== lag
    ) {
      this.logger.debug(
        {
          event: "market_data.projection.cycle_completed",
          marketCode,
          appliedCount,
          projectedSequence: latestResult.lastSequence.toString(),
          publishedSequence: publishedSequence.toString(),
          lag: lag.toString(),
          state: status.state,
        },
        "Market Data projection cycle completed",
      );
    }
  }
}
