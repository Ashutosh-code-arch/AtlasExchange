import type { MarketCode } from "../../trading/index.js";
import { getCandleBucket, type CandleInterval } from "./candle-projection.js";

export const defaultCandleHistoryLimit = 200;
export const maximumCandleHistoryLimit = 500;

export interface HistoricalCandle {
  readonly start: Date;
  readonly end: Date;
  readonly openPriceTicks: bigint;
  readonly highPriceTicks: bigint;
  readonly lowPriceTicks: bigint;
  readonly closePriceTicks: bigint;
  readonly baseVolumeLots: bigint;
  readonly quoteVolumeTickLots: bigint;
  readonly tradeCount: bigint;
}

export interface CandleHistoryPage {
  readonly marketCode: MarketCode;
  readonly interval: CandleInterval;
  readonly sequence: bigint;
  readonly asOf: Date | null;
  readonly candles: readonly HistoricalCandle[];
  readonly nextBefore: Date | null;
}

export interface CandleHistorySnapshot extends CandleHistoryPage {
  readonly limit: number;
  readonly generatedAt: Date;
}

export interface CandleHistoryReader {
  getPage(input: {
    readonly marketCode: MarketCode;
    readonly interval: CandleInterval;
    readonly limit: number;
    readonly before: Date;
  }): Promise<CandleHistoryPage>;
}

export interface GetCandlesQuery {
  readonly marketCode: MarketCode;
  readonly interval: CandleInterval;
  readonly limit?: number;
  readonly before?: Date;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumCandleHistoryLimit) {
    throw new RangeError("Candle history limit is invalid.");
  }
}

function validateCursor(before: Date, interval: CandleInterval): void {
  const bucket = getCandleBucket(before, interval);
  if (bucket.start.getTime() !== before.getTime()) {
    throw new RangeError("Candle history cursor must be interval aligned.");
  }
}

export class GetCandles {
  public constructor(
    private readonly candles: CandleHistoryReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(query: GetCandlesQuery): Promise<CandleHistorySnapshot> {
    const limit = query.limit ?? defaultCandleHistoryLimit;
    validateLimit(limit);
    const generatedAt = this.now();
    if (!Number.isFinite(generatedAt.getTime())) {
      throw new RangeError("Candle history clock returned an invalid time.");
    }
    const currentBucketEnd = getCandleBucket(generatedAt, query.interval).end;
    if (query.before !== undefined) {
      validateCursor(query.before, query.interval);
    }
    const before =
      query.before !== undefined && query.before < currentBucketEnd
        ? new Date(query.before)
        : currentBucketEnd;
    const page = await this.candles.getPage({
      marketCode: query.marketCode,
      interval: query.interval,
      limit,
      before,
    });
    if (page.marketCode !== query.marketCode || page.interval !== query.interval) {
      throw new Error("Candle history reader returned a different market or interval.");
    }
    return {
      ...page,
      limit,
      generatedAt: new Date(generatedAt),
    };
  }
}
