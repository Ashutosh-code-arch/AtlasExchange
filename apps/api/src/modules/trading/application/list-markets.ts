import type { TradingMarketReader } from "./trading-readers.js";
import { toTradingMarketView, type TradingMarketView } from "./trading-read-views.js";

export interface ListMarketsResult {
  readonly markets: readonly TradingMarketView[];
}

export class ListMarkets {
  public constructor(private readonly reader: TradingMarketReader) {}

  public async execute(): Promise<ListMarketsResult> {
    return { markets: (await this.reader.list()).map(toTradingMarketView) };
  }
}
