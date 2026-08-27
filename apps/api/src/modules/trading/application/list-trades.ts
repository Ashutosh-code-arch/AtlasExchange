import { parseMarketCode } from "../domain/market.js";
import { parseOrderOwnerId } from "../domain/order.js";
import { TradingInputValidationError } from "../domain/trading-input-validation-error.js";
import {
  decodeTradingReadCursor,
  encodeTradingReadCursor,
  parseTradingReadPageLimit,
} from "./trading-read-pagination.js";
import type { TradingTradeReader } from "./trading-readers.js";
import { toTradingTradeView, type TradingTradeView } from "./trading-read-views.js";

export interface ListTradesQuery {
  readonly ownerId: string;
  readonly marketCode?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListTradesResult {
  readonly trades: readonly TradingTradeView[];
  readonly nextCursor: string | null;
}

function tradeFilters(marketCode: string | undefined): string {
  return JSON.stringify({ marketCode: marketCode ?? null });
}

export class ListTrades {
  public constructor(private readonly reader: TradingTradeReader) {}

  public async execute(query: ListTradesQuery): Promise<ListTradesResult> {
    const ownerId = parseOrderOwnerId(query.ownerId);
    const marketCode =
      query.marketCode === undefined ? undefined : parseMarketCode(query.marketCode);
    const limit = parseTradingReadPageLimit(query.limit);
    const filters = tradeFilters(marketCode);
    let before;
    if (query.cursor !== undefined) {
      const cursorTradeId = decodeTradingReadCursor(query.cursor, "trades", filters);
      const cursorTrade = await this.reader.findByOwnerAndId(ownerId, cursorTradeId);
      if (
        cursorTrade === undefined ||
        (marketCode !== undefined && cursorTrade.market.code !== marketCode)
      ) {
        throw new TradingInputValidationError("cursor", "CURSOR_INVALID");
      }
      before = {
        executedAt: cursorTrade.executedAt,
        executionSequence: cursorTrade.executionSequence,
      };
    }

    const records = await this.reader.listByOwner({
      ownerId,
      limit: limit + 1,
      ...(marketCode === undefined ? {} : { marketCode }),
      ...(before === undefined ? {} : { before }),
    });
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      trades: page.map(toTradingTradeView),
      nextCursor:
        records.length > limit && last !== undefined
          ? encodeTradingReadCursor("trades", last.id, filters)
          : null,
    };
  }
}
