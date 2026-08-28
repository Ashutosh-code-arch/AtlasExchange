import type { MarketCode } from "../../trading/index.js";

export const tradeTickerWindowMilliseconds = 24 * 60 * 60 * 1_000;

export interface TradeTickerLastTrade {
  readonly priceTicks: bigint;
  readonly quantityLots: bigint;
  readonly executionSequence: bigint;
  readonly executedAt: Date;
}

export interface TradeTickerSnapshot {
  readonly marketCode: MarketCode;
  readonly sequence: bigint;
  readonly asOf: Date | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly lastTrade: TradeTickerLastTrade | null;
  readonly highPriceTicks: bigint | null;
  readonly lowPriceTicks: bigint | null;
  readonly baseVolumeLots: bigint;
  readonly quoteVolumeTickLots: bigint;
}

export interface TradeTickerWindowReader {
  getSnapshot(input: {
    readonly marketCode: MarketCode;
    readonly windowStart: Date;
    readonly windowEnd: Date;
  }): Promise<TradeTickerSnapshot>;
}

export class GetTradeTicker {
  public constructor(
    private readonly tickers: TradeTickerWindowReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public execute(marketCode: MarketCode): Promise<TradeTickerSnapshot> {
    const windowEnd = this.now();
    if (Number.isNaN(windowEnd.getTime())) {
      throw new RangeError("Trade ticker clock returned an invalid time.");
    }
    const windowStart = new Date(windowEnd.getTime() - tradeTickerWindowMilliseconds);
    return this.tickers.getSnapshot({ marketCode, windowStart, windowEnd });
  }
}
