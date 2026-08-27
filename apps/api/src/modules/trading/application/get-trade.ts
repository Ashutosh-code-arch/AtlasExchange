import { parseOrderOwnerId } from "../domain/order.js";
import type { TradingTradeReader } from "./trading-readers.js";
import { toTradingTradeView, type TradingTradeView } from "./trading-read-views.js";

export interface GetTradeQuery {
  readonly ownerId: string;
  readonly tradeId: string;
}

export type GetTradeResult =
  { readonly status: "found"; readonly trade: TradingTradeView } | { readonly status: "not_found" };

export class GetTrade {
  public constructor(private readonly reader: TradingTradeReader) {}

  public async execute(query: GetTradeQuery): Promise<GetTradeResult> {
    const trade = await this.reader.findByOwnerAndId(
      parseOrderOwnerId(query.ownerId),
      query.tradeId,
    );
    return trade === undefined
      ? { status: "not_found" }
      : { status: "found", trade: toTradingTradeView(trade) };
  }
}
