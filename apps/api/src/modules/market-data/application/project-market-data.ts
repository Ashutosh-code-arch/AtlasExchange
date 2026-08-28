import type { ProjectCandles, ProjectCandlesResult } from "./candle-projection.js";
import type {
  ProjectLevelTwoOrderBook,
  ProjectLevelTwoOrderBookResult,
} from "./level-two-order-book-projection.js";
import type {
  MarketDataProjector,
  MarketDataProjectorInput,
  MarketDataProjectorResult,
} from "./market-data-projection-worker.js";
import type { ProjectTradeTicker, ProjectTradeTickerResult } from "./trade-ticker-projection.js";

export interface ProjectMarketDataResult extends MarketDataProjectorResult {
  readonly candles: ProjectCandlesResult;
  readonly levelTwo: ProjectLevelTwoOrderBookResult;
  readonly ticker: ProjectTradeTickerResult;
}

function rejectedReason(result: PromiseRejectedResult): unknown {
  return result.reason;
}

export class ProjectMarketData implements MarketDataProjector {
  public constructor(
    private readonly levelTwo: Pick<ProjectLevelTwoOrderBook, "execute">,
    private readonly ticker: Pick<ProjectTradeTicker, "execute">,
    private readonly candles: Pick<ProjectCandles, "execute">,
  ) {}

  public async execute(input: MarketDataProjectorInput): Promise<ProjectMarketDataResult> {
    const [levelTwoResult, tickerResult, candlesResult] = await Promise.allSettled([
      this.levelTwo.execute(input),
      this.ticker.execute(input),
      this.candles.execute(input),
    ]);
    const failures = [levelTwoResult, tickerResult, candlesResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(rejectedReason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple Market Data projections failed.");
    }
    if (
      levelTwoResult.status !== "fulfilled" ||
      tickerResult.status !== "fulfilled" ||
      candlesResult.status !== "fulfilled"
    ) {
      throw new Error("Market Data projection results are unavailable.");
    }
    const levelTwo = levelTwoResult.value;
    const ticker = tickerResult.value;
    const candles = candlesResult.value;
    const lastSequence = [levelTwo.lastSequence, ticker.lastSequence, candles.lastSequence].reduce(
      (minimum, sequence) => (sequence < minimum ? sequence : minimum),
    );
    return {
      readCount: Math.max(levelTwo.readCount, ticker.readCount, candles.readCount),
      appliedCount: Math.max(levelTwo.appliedCount, ticker.appliedCount, candles.appliedCount),
      lastSequence,
      caughtUp: levelTwo.caughtUp && ticker.caughtUp && candles.caughtUp,
      candles,
      levelTwo,
      ticker,
    };
  }
}
