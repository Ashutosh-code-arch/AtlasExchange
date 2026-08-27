import { parseMarketCode } from "../domain/market.js";
import type { TradingMarketReader } from "./trading-readers.js";
import { toTradingMarketView, type TradingMarketView } from "./trading-read-views.js";

export interface GetMarketQuery {
  readonly marketCode: string;
}

export type GetMarketResult =
  | { readonly status: "found"; readonly market: TradingMarketView }
  | { readonly status: "not_found" };

export class GetMarket {
  public constructor(private readonly reader: TradingMarketReader) {}

  public async execute(query: GetMarketQuery): Promise<GetMarketResult> {
    const market = await this.reader.findByCode(parseMarketCode(query.marketCode));
    return market === undefined
      ? { status: "not_found" }
      : { status: "found", market: toTradingMarketView(market) };
  }
}
