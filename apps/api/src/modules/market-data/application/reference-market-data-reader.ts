import type {
  ReferenceMarketCode,
  ReferenceMarketDataCandlesResponse,
  ReferenceMarketDataTickerResponse,
} from "@atlas/contracts";

export type ReferenceMarketTicker = ReferenceMarketDataTickerResponse["data"];
export type ReferenceMarketCandles = ReferenceMarketDataCandlesResponse["data"];

export interface ReferenceMarketDataReader {
  getTicker(marketCode: ReferenceMarketCode): ReferenceMarketTicker | undefined;
  getCandles(marketCode: ReferenceMarketCode, limit: number): ReferenceMarketCandles | undefined;
}
