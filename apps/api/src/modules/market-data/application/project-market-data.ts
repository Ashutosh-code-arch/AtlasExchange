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
  ) {}

  public async execute(input: MarketDataProjectorInput): Promise<ProjectMarketDataResult> {
    const [levelTwoResult, tickerResult] = await Promise.allSettled([
      this.levelTwo.execute(input),
      this.ticker.execute(input),
    ]);
    const failures = [levelTwoResult, tickerResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(rejectedReason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple Market Data projections failed.");
    }
    if (levelTwoResult.status !== "fulfilled" || tickerResult.status !== "fulfilled") {
      throw new Error("Market Data projection results are unavailable.");
    }
    const levelTwo = levelTwoResult.value;
    const ticker = tickerResult.value;
    return {
      readCount: Math.max(levelTwo.readCount, ticker.readCount),
      appliedCount: Math.max(levelTwo.appliedCount, ticker.appliedCount),
      lastSequence:
        levelTwo.lastSequence < ticker.lastSequence ? levelTwo.lastSequence : ticker.lastSequence,
      caughtUp: levelTwo.caughtUp && ticker.caughtUp,
      levelTwo,
      ticker,
    };
  }
}
