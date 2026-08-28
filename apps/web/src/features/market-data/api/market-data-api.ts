import {
  marketDataOrderBookParamsSchema,
  marketDataOrderBookQuerySchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerParamsSchema,
  marketDataTickerQuerySchema,
  marketDataTickerResponseSchema,
  type MarketDataOrderBookResponse,
  type MarketDataTickerResponse,
} from "@atlas/contracts";

import type { AuthenticationHttpClient } from "../../authentication";

export type MarketDataHttpClient = Pick<AuthenticationHttpClient, "request">;

export interface GetLevelTwoOrderBookInput {
  readonly marketCode: string;
  readonly depth?: number;
}

export type LevelTwoOrderBookSnapshot = MarketDataOrderBookResponse["data"];
export type LevelTwoOrderBookLoader = typeof getLevelTwoOrderBook;
export interface GetTradeTickerInput {
  readonly marketCode: string;
}

export type TradeTickerSnapshot = MarketDataTickerResponse["data"];
export type TradeTickerLoader = typeof getTradeTicker;

export async function getLevelTwoOrderBook(
  client: MarketDataHttpClient,
  input: GetLevelTwoOrderBookInput,
): Promise<LevelTwoOrderBookSnapshot> {
  const params = marketDataOrderBookParamsSchema.parse({ marketCode: input.marketCode });
  const query = marketDataOrderBookQuerySchema.parse({
    depth: input.depth === undefined ? undefined : String(input.depth),
  });
  const search = new URLSearchParams({ depth: String(query.depth) });
  const response = await client.request(
    `/api/v1/market-data/markets/${encodeURIComponent(params.marketCode)}/order-book?${search.toString()}`,
    { method: "GET", recoverAuthentication: false },
  );
  const payload = (await response.json()) as unknown;
  return marketDataOrderBookResponseSchema.parse(payload).data;
}

export async function getTradeTicker(
  client: MarketDataHttpClient,
  input: GetTradeTickerInput,
): Promise<TradeTickerSnapshot> {
  const params = marketDataTickerParamsSchema.parse({ marketCode: input.marketCode });
  marketDataTickerQuerySchema.parse({});
  const response = await client.request(
    `/api/v1/market-data/markets/${encodeURIComponent(params.marketCode)}/ticker`,
    { method: "GET", recoverAuthentication: false },
  );
  const payload = (await response.json()) as unknown;
  return marketDataTickerResponseSchema.parse(payload).data;
}
