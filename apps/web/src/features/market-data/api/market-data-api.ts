import {
  marketDataCandleParamsSchema,
  marketDataCandleQuerySchema,
  marketDataCandlesResponseSchema,
  marketDataOrderBookParamsSchema,
  marketDataOrderBookQuerySchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerParamsSchema,
  marketDataTickerQuerySchema,
  marketDataTickerResponseSchema,
  type MarketDataOrderBookResponse,
  type MarketDataCandleInterval,
  type MarketDataCandlesResponse,
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
export interface GetCandleHistoryInput {
  readonly marketCode: string;
  readonly interval: MarketDataCandleInterval;
  readonly limit?: number;
  readonly before?: string;
}

export type CandleHistorySnapshot = MarketDataCandlesResponse["data"];
export type CandleHistoryLoader = typeof getCandleHistory;

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

export async function getCandleHistory(
  client: MarketDataHttpClient,
  input: GetCandleHistoryInput,
): Promise<CandleHistorySnapshot> {
  const params = marketDataCandleParamsSchema.parse({ marketCode: input.marketCode });
  const query = marketDataCandleQuerySchema.parse({
    interval: input.interval,
    limit: input.limit === undefined ? undefined : String(input.limit),
    before: input.before,
  });
  const search = new URLSearchParams({
    interval: query.interval,
    limit: String(query.limit),
  });
  if (query.before !== undefined) search.set("before", query.before);
  const response = await client.request(
    `/api/v1/market-data/markets/${encodeURIComponent(params.marketCode)}/candles?${search.toString()}`,
    { method: "GET", recoverAuthentication: false },
  );
  const payload = (await response.json()) as unknown;
  return marketDataCandlesResponseSchema.parse(payload).data;
}
