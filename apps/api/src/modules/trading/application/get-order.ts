import { parseOrderId, parseOrderOwnerId } from "../domain/order.js";
import type { TradingOrderReader } from "./trading-readers.js";
import { toTradingOrderView, type TradingOrderView } from "./trading-read-views.js";

export interface GetOrderQuery {
  readonly ownerId: string;
  readonly orderId: string;
}

export type GetOrderResult =
  { readonly status: "found"; readonly order: TradingOrderView } | { readonly status: "not_found" };

export class GetOrder {
  public constructor(private readonly reader: TradingOrderReader) {}

  public async execute(query: GetOrderQuery): Promise<GetOrderResult> {
    const order = await this.reader.findByOwnerAndId(
      parseOrderOwnerId(query.ownerId),
      parseOrderId(query.orderId),
    );
    return order === undefined
      ? { status: "not_found" }
      : { status: "found", order: toTradingOrderView(order) };
  }
}
