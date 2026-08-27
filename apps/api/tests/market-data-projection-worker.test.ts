import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MarketDataProjectionWorker,
  type MarketDataProjectionWorkerOptions,
  type MarketDataWorkerLogger,
  type MarketDataWorkerScheduler,
  type ProjectLevelTwoOrderBookInput,
  type ProjectLevelTwoOrderBookResult,
} from "../src/modules/market-data/index.js";
import { parseMarketCode, type Market, type MarketCode } from "../src/modules/trading/index.js";

interface PendingSleep {
  readonly delayMs: number;
  readonly release: () => void;
}

class ManualScheduler implements MarketDataWorkerScheduler {
  private nowMilliseconds = Date.parse("2026-08-28T14:00:00.000Z");
  public readonly sleeps: PendingSleep[] = [];

  public now(): Date {
    return new Date(this.nowMilliseconds);
  }

  public sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const complete = (): void => {
        signal.removeEventListener("abort", complete);
        resolve();
      };
      signal.addEventListener("abort", complete, { once: true });
      this.sleeps.push({
        delayMs,
        release: () => {
          this.nowMilliseconds += delayMs;
          complete();
        },
      });
    });
  }

  public releaseNext(): void {
    const sleep = this.sleeps.shift();
    if (sleep === undefined) {
      throw new Error("No Market Data worker sleep is pending");
    }
    sleep.release();
  }
}

const btcUsd = parseMarketCode("BTC-USD");
const ethUsd = parseMarketCode("ETH-USD");
const workerOptions: MarketDataProjectionWorkerOptions = {
  batchSize: 2,
  maximumBatchesPerCycle: 2,
  pollIntervalMs: 1_000,
  retryInitialDelayMs: 100,
  retryMaximumDelayMs: 800,
};

function market(code: MarketCode): Market {
  return { code } as Market;
}

function result(
  lastSequence: bigint,
  overrides: Partial<ProjectLevelTwoOrderBookResult> = {},
): ProjectLevelTwoOrderBookResult {
  return {
    readCount: 0,
    appliedCount: 0,
    lastSequence,
    caughtUp: true,
    ...overrides,
  };
}

function logger(): MarketDataWorkerLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

function markets(...codes: MarketCode[]): { list: () => Promise<readonly Market[]> } {
  return { list: () => Promise.resolve(codes.map(market)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Market Data projection worker", () => {
  it("discovers markets, projects immediately, and exposes exact per-market lag", async () => {
    const scheduler = new ManualScheduler();
    const execute = vi
      .fn<(input: ProjectLevelTwoOrderBookInput) => Promise<ProjectLevelTwoOrderBookResult>>()
      .mockImplementation(({ marketCode }) =>
        Promise.resolve(result(marketCode === btcUsd ? 5n : 2n)),
      );
    const publicationSequences = {
      getLastPublishedSequence: (marketCode: MarketCode) =>
        Promise.resolve(marketCode === btcUsd ? 5n : 4n),
    };
    const worker = new MarketDataProjectionWorker(
      markets(ethUsd, btcUsd),
      { execute },
      publicationSequences,
      logger(),
      workerOptions,
      scheduler,
    );

    await worker.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(worker.getStatus()).toMatchObject({
      running: true,
      markets: [
        {
          marketCode: btcUsd,
          state: "caught_up",
          projectedSequence: 5n,
          publishedSequence: 5n,
          lag: 0n,
        },
        {
          marketCode: ethUsd,
          state: "behind",
          projectedSequence: 2n,
          publishedSequence: 4n,
          lag: 2n,
        },
      ],
    });

    await worker.stop();
    expect(worker.getStatus()).toMatchObject({
      running: false,
      markets: [{ state: "stopped" }, { state: "stopped" }],
    });
  });

  it("bounds catch-up work per cycle before yielding to the poll interval", async () => {
    const scheduler = new ManualScheduler();
    const execute = vi
      .fn<(input: ProjectLevelTwoOrderBookInput) => Promise<ProjectLevelTwoOrderBookResult>>()
      .mockResolvedValueOnce(result(2n, { readCount: 2, appliedCount: 2, caughtUp: false }))
      .mockResolvedValueOnce(result(4n, { readCount: 2, appliedCount: 2, caughtUp: false }));
    const worker = new MarketDataProjectionWorker(
      markets(btcUsd),
      { execute },
      { getLastPublishedSequence: () => Promise.resolve(5n) },
      logger(),
      workerOptions,
      scheduler,
    );

    await worker.start();
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
      expect(worker.getStatus().markets[0]).toMatchObject({
        state: "behind",
        projectedSequence: 4n,
        publishedSequence: 5n,
        lag: 1n,
      });
    });
    expect(scheduler.sleeps[0]?.delayMs).toBe(workerOptions.pollIntervalMs);

    await worker.stop();
  });

  it("backs off a failed market independently and records recovery", async () => {
    const scheduler = new ManualScheduler();
    const workerLogger = logger();
    const execute = vi
      .fn<(input: ProjectLevelTwoOrderBookInput) => Promise<ProjectLevelTwoOrderBookResult>>()
      .mockRejectedValueOnce(new TypeError("temporary projection failure"))
      .mockResolvedValue(result(3n));
    const worker = new MarketDataProjectionWorker(
      markets(btcUsd),
      { execute },
      { getLastPublishedSequence: () => Promise.resolve(3n) },
      workerLogger,
      workerOptions,
      scheduler,
    );

    await worker.start();
    await vi.waitFor(() =>
      expect(worker.getStatus().markets[0]).toMatchObject({
        state: "failed",
        consecutiveFailures: 1,
        lastErrorName: "TypeError",
      }),
    );
    expect(scheduler.sleeps[0]?.delayMs).toBe(workerOptions.retryInitialDelayMs);
    scheduler.releaseNext();
    await vi.waitFor(() =>
      expect(worker.getStatus().markets[0]).toMatchObject({
        state: "caught_up",
        consecutiveFailures: 0,
        projectedSequence: 3n,
        lag: 0n,
      }),
    );
    expect(workerLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "market_data.projection.failed", retryDelayMs: 100 }),
      "Market Data projection cycle failed",
    );
    expect(workerLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "market_data.projection.recovered", previousFailures: 1 }),
      "Market Data projection recovered",
    );

    await worker.stop();
  });

  it("doubles consecutive retry delays and caps them at the configured maximum", async () => {
    const scheduler = new ManualScheduler();
    const execute = vi
      .fn<(input: ProjectLevelTwoOrderBookInput) => Promise<ProjectLevelTwoOrderBookResult>>()
      .mockRejectedValue(new Error("persistent projection failure"));
    const worker = new MarketDataProjectionWorker(
      markets(btcUsd),
      { execute },
      { getLastPublishedSequence: () => Promise.resolve(0n) },
      logger(),
      workerOptions,
      scheduler,
    );

    await worker.start();
    const expectedDelays = [100, 200, 400, 800, 800];
    for (const [index, expectedDelay] of expectedDelays.entries()) {
      await vi.waitFor(() =>
        expect(worker.getStatus().markets[0]?.consecutiveFailures).toBe(index + 1),
      );
      expect(scheduler.sleeps[0]?.delayMs).toBe(expectedDelay);
      if (index < expectedDelays.length - 1) {
        scheduler.releaseNext();
      }
    }

    await worker.stop();
  });

  it("waits for in-flight projection work during graceful stop", async () => {
    const scheduler = new ManualScheduler();
    let resolveProjection: ((value: ProjectLevelTwoOrderBookResult) => void) | undefined;
    const projection = new Promise<ProjectLevelTwoOrderBookResult>((resolve) => {
      resolveProjection = resolve;
    });
    const execute = vi
      .fn<(input: ProjectLevelTwoOrderBookInput) => Promise<ProjectLevelTwoOrderBookResult>>()
      .mockReturnValue(projection);
    const worker = new MarketDataProjectionWorker(
      markets(btcUsd),
      { execute },
      { getLastPublishedSequence: () => Promise.resolve(1n) },
      logger(),
      workerOptions,
      scheduler,
    );
    await worker.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveProjection?.(result(1n));
    await stop;

    expect(stopped).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects unsafe worker configuration before startup", () => {
    expect(
      () =>
        new MarketDataProjectionWorker(
          markets(btcUsd),
          { execute: () => Promise.resolve(result(0n)) },
          { getLastPublishedSequence: () => Promise.resolve(0n) },
          logger(),
          { ...workerOptions, retryInitialDelayMs: 801 },
        ),
    ).toThrow(RangeError);
  });
});
