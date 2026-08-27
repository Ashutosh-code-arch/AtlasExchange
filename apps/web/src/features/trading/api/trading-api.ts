import {
  cancelOrderParamsSchema,
  cancelOrderResponseSchema,
  placeOrderHeadersSchema,
  placeOrderRequestSchema,
  placeOrderResponseSchema,
  tradingMarketListResponseSchema,
  tradingMarketParamsSchema,
  tradingMarketResponseSchema,
  tradingOrderListQuerySchema,
  tradingOrderListResponseSchema,
  tradingOrderParamsSchema,
  tradingOrderResponseSchema,
  tradingTradeListQuerySchema,
  tradingTradeListResponseSchema,
  type CancelOrderResponse,
  type PlaceOrderRequest,
  type PlaceOrderResponse,
  type TradingMarket,
  type TradingOrder,
  type TradingOrderListResponse,
  type TradingOrderStatus,
  type TradingTradeListResponse,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

type TradingHttpClient = Pick<AuthenticationHttpClient, "request">;

export interface TradingOrderListInput {
  readonly marketCode?: string;
  readonly status?: TradingOrderStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TradingTradeListInput {
  readonly marketCode?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PlaceTradingOrderInput extends PlaceOrderRequest {
  readonly idempotencyKey: string;
}

export type TradingOrderPage = TradingOrderListResponse["data"];
export type TradingTradePage = TradingTradeListResponse["data"];
export type TradingPlacement = PlaceOrderResponse["data"];

function queryPath(path: string, query: URLSearchParams): string {
  const serialized = query.toString();
  return serialized.length === 0 ? path : `${path}?${serialized}`;
}

function orderListPath(input: TradingOrderListInput): string {
  const parsed = tradingOrderListQuerySchema.parse({
    marketCode: input.marketCode,
    status: input.status,
    limit: input.limit === undefined ? undefined : String(input.limit),
    cursor: input.cursor,
  });
  const query = new URLSearchParams();
  if (parsed.marketCode !== undefined) query.set("marketCode", parsed.marketCode);
  if (parsed.status !== undefined) query.set("status", parsed.status);
  query.set("limit", String(parsed.limit));
  if (parsed.cursor !== undefined) query.set("cursor", parsed.cursor);
  return queryPath("/api/v1/orders", query);
}

function tradeListPath(input: TradingTradeListInput): string {
  const parsed = tradingTradeListQuerySchema.parse({
    marketCode: input.marketCode,
    limit: input.limit === undefined ? undefined : String(input.limit),
    cursor: input.cursor,
  });
  const query = new URLSearchParams();
  if (parsed.marketCode !== undefined) query.set("marketCode", parsed.marketCode);
  query.set("limit", String(parsed.limit));
  if (parsed.cursor !== undefined) query.set("cursor", parsed.cursor);
  return queryPath("/api/v1/trades", query);
}

export async function listTradingMarkets(
  client: TradingHttpClient,
): Promise<readonly TradingMarket[]> {
  const response = await client.request("/api/v1/markets", { method: "GET" });
  const payload = (await response.json()) as unknown;
  return tradingMarketListResponseSchema.parse(payload).data.markets;
}

export async function getTradingMarket(
  client: TradingHttpClient,
  marketCode: string,
): Promise<TradingMarket> {
  const params = tradingMarketParamsSchema.parse({ marketCode });
  const response = await client.request(
    `/api/v1/markets/${encodeURIComponent(params.marketCode)}`,
    { method: "GET" },
  );
  const payload = (await response.json()) as unknown;
  return tradingMarketResponseSchema.parse(payload).data.market;
}

export async function listTradingOrders(
  client: TradingHttpClient,
  input: TradingOrderListInput = {},
): Promise<TradingOrderPage> {
  const response = await client.request(orderListPath(input), { method: "GET" });
  const payload = (await response.json()) as unknown;
  return tradingOrderListResponseSchema.parse(payload).data;
}

export async function getTradingOrder(
  client: TradingHttpClient,
  orderId: string,
): Promise<TradingOrder> {
  const params = tradingOrderParamsSchema.parse({ orderId });
  const response = await client.request(`/api/v1/orders/${encodeURIComponent(params.orderId)}`, {
    method: "GET",
  });
  const payload = (await response.json()) as unknown;
  return tradingOrderResponseSchema.parse(payload).data.order;
}

export async function listTradingTrades(
  client: TradingHttpClient,
  input: TradingTradeListInput = {},
): Promise<TradingTradePage> {
  const response = await client.request(tradeListPath(input), { method: "GET" });
  const payload = (await response.json()) as unknown;
  return tradingTradeListResponseSchema.parse(payload).data;
}

export async function placeTradingOrder(
  client: TradingHttpClient,
  input: PlaceTradingOrderInput,
): Promise<TradingPlacement> {
  const headers = placeOrderHeadersSchema.parse({
    "idempotency-key": input.idempotencyKey,
  });
  const body = placeOrderRequestSchema.parse({
    marketCode: input.marketCode,
    side: input.side,
    quantity: input.quantity,
    limitPrice: input.limitPrice,
  });
  const response = await client.request("/api/v1/orders", {
    method: "POST",
    csrf: true,
    headers,
    body,
  });
  const payload = (await response.json()) as unknown;
  return placeOrderResponseSchema.parse(payload).data;
}

export async function cancelTradingOrder(
  client: TradingHttpClient,
  orderId: string,
): Promise<CancelOrderResponse["data"]["order"]> {
  const params = cancelOrderParamsSchema.parse({ orderId });
  const response = await client.request(`/api/v1/orders/${encodeURIComponent(params.orderId)}`, {
    method: "DELETE",
    csrf: true,
  });
  const payload = (await response.json()) as unknown;
  return cancelOrderResponseSchema.parse(payload).data.order;
}
