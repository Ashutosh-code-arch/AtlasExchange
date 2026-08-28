import { describe, expect, it, vi } from "vitest";

import {
  ProjectMarketData,
  type ProjectCandlesInput,
  type ProjectCandlesResult,
  type ProjectLevelTwoOrderBookInput,
  type ProjectLevelTwoOrderBookResult,
  type ProjectTradeTickerInput,
  type ProjectTradeTickerResult,
} from "../src/modules/market-data/index.js";
import { parseMarketCode } from "../src/modules/trading/index.js";

const marketCode = parseMarketCode("BTC-USD");

function levelTwoResult(
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

function tickerResult(
  lastSequence: bigint,
  overrides: Partial<ProjectTradeTickerResult> = {},
): ProjectTradeTickerResult {
  return {
    readCount: 0,
    appliedCount: 0,
    storedTradeCount: 0,
    lastSequence,
    caughtUp: true,
    ...overrides,
  };
}

function candlesResult(
  lastSequence: bigint,
  overrides: Partial<ProjectCandlesResult> = {},
): ProjectCandlesResult {
  return {
    readCount: 0,
    appliedCount: 0,
    appliedTradeCount: 0,
    updatedCandleCount: 0,
    lastSequence,
    caughtUp: true,
    ...overrides,
  };
}

describe("ProjectMarketData", () => {
  it("runs all projections and reports progress from the slowest checkpoint", async () => {
    const levelTwo = vi
      .fn<(input: ProjectLevelTwoOrderBookInput) => Promise<ProjectLevelTwoOrderBookResult>>()
      .mockResolvedValue(levelTwoResult(8n, { readCount: 3, appliedCount: 3, caughtUp: true }));
    const ticker = vi
      .fn<(input: ProjectTradeTickerInput) => Promise<ProjectTradeTickerResult>>()
      .mockResolvedValue(tickerResult(6n, { readCount: 2, appliedCount: 2, caughtUp: false }));
    const candles = vi
      .fn<(input: ProjectCandlesInput) => Promise<ProjectCandlesResult>>()
      .mockResolvedValue(candlesResult(5n, { readCount: 4, appliedCount: 4, caughtUp: true }));
    const projector = new ProjectMarketData(
      { execute: levelTwo },
      { execute: ticker },
      { execute: candles },
    );

    await expect(projector.execute({ marketCode, limit: 25 })).resolves.toEqual({
      readCount: 4,
      appliedCount: 4,
      lastSequence: 5n,
      caughtUp: false,
      candles: candlesResult(5n, { readCount: 4, appliedCount: 4, caughtUp: true }),
      levelTwo: levelTwoResult(8n, { readCount: 3, appliedCount: 3, caughtUp: true }),
      ticker: tickerResult(6n, { readCount: 2, appliedCount: 2, caughtUp: false }),
    });
    expect(levelTwo).toHaveBeenCalledWith({ marketCode, limit: 25 });
    expect(ticker).toHaveBeenCalledWith({ marketCode, limit: 25 });
    expect(candles).toHaveBeenCalledWith({ marketCode, limit: 25 });
  });

  it("awaits the independent sibling projection before reporting a failure", async () => {
    let finishTicker: ((result: ProjectTradeTickerResult) => void) | undefined;
    const tickerPending = new Promise<ProjectTradeTickerResult>((resolve) => {
      finishTicker = resolve;
    });
    const projector = new ProjectMarketData(
      { execute: () => Promise.reject(new TypeError("book failed")) },
      { execute: () => tickerPending },
      { execute: () => Promise.resolve(candlesResult(4n)) },
    );
    let settled = false;
    const execution = projector.execute({ marketCode }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishTicker?.(tickerResult(4n));
    await expect(execution).rejects.toThrow("book failed");
    expect(settled).toBe(true);
  });

  it("reports all projection failures together", async () => {
    const projector = new ProjectMarketData(
      { execute: () => Promise.reject(new TypeError("book failed")) },
      { execute: () => Promise.reject(new RangeError("ticker failed")) },
      { execute: () => Promise.reject(new SyntaxError("candles failed")) },
    );

    await expect(projector.execute({ marketCode })).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.any(TypeError), expect.any(RangeError), expect.any(SyntaxError)],
    });
  });
});
