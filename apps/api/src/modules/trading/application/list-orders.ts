import { parseMarketCode } from "../domain/market.js";
import { parseOrderId, parseOrderOwnerId, parseOrderStatus } from "../domain/order.js";
import {
  decodeTradingReadCursor,
  encodeTradingReadCursor,
  parseTradingReadPageLimit,
} from "./trading-read-pagination.js";
import type { TradingOrderReader } from "./trading-readers.js";
import { toTradingOrderView, type TradingOrderView } from "./trading-read-views.js";
import { TradingInputValidationError } from "../domain/trading-input-validation-error.js";

export interface ListOrdersQuery {
  readonly ownerId: string;
  readonly marketCode?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListOrdersResult {
  readonly orders: readonly TradingOrderView[];
  readonly nextCursor: string | null;
}

function orderFilters(marketCode: string | undefined, status: string | undefined): string {
  return JSON.stringify({ marketCode: marketCode ?? null, status: status ?? null });
}

export class ListOrders {
  public constructor(private readonly reader: TradingOrderReader) {}

  public async execute(query: ListOrdersQuery): Promise<ListOrdersResult> {
    const ownerId = parseOrderOwnerId(query.ownerId);
    const marketCode =
      query.marketCode === undefined ? undefined : parseMarketCode(query.marketCode);
    const status = query.status === undefined ? undefined : parseOrderStatus(query.status);
    const limit = parseTradingReadPageLimit(query.limit);
    const filters = orderFilters(marketCode, status);
    let before;
    if (query.cursor !== undefined) {
      const cursorOrderId = parseOrderId(decodeTradingReadCursor(query.cursor, "orders", filters));
      const cursorOrder = await this.reader.findByOwnerAndId(ownerId, cursorOrderId);
      if (
        cursorOrder === undefined ||
        (marketCode !== undefined && cursorOrder.market.code !== marketCode) ||
        (status !== undefined && cursorOrder.status !== status)
      ) {
        throw new TradingInputValidationError("cursor", "CURSOR_INVALID");
      }
      before = { id: cursorOrder.id, createdAt: cursorOrder.createdAt };
    }

    const records = await this.reader.listByOwner({
      ownerId,
      limit: limit + 1,
      ...(marketCode === undefined ? {} : { marketCode }),
      ...(status === undefined ? {} : { status }),
      ...(before === undefined ? {} : { before }),
    });
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      orders: page.map(toTradingOrderView),
      nextCursor:
        records.length > limit && last !== undefined
          ? encodeTradingReadCursor("orders", last.id, filters)
          : null,
    };
  }
}
