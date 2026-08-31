import { useCallback, useEffect, useRef, useState } from "react";

import {
  getReferenceMarketCandles,
  getReferenceMarketTicker,
  type MarketDataHttpClient,
  type ReferenceMarketCandlesLoader,
  type ReferenceMarketCandlesSnapshot,
  type ReferenceMarketTickerLoader,
  type ReferenceMarketTickerSnapshot,
} from "../api/market-data-api";

export type ReferenceMarketDataStatus = "error" | "idle" | "loading" | "ready" | "stale";

export interface UseReferenceMarketDataOptions {
  readonly client: MarketDataHttpClient;
  readonly marketCode?: string;
  readonly limit?: number;
  readonly refreshIntervalMs?: number;
  readonly tickerLoader?: ReferenceMarketTickerLoader;
  readonly candlesLoader?: ReferenceMarketCandlesLoader;
}

export interface ReferenceMarketDataController {
  readonly ticker: ReferenceMarketTickerSnapshot | null;
  readonly candles: ReferenceMarketCandlesSnapshot | null;
  readonly status: ReferenceMarketDataStatus;
  readonly refresh: () => void;
}

export const defaultReferenceMarketRefreshIntervalMs = 5_000;
export const defaultReferenceMarketCandleLimit = 120;

export function useReferenceMarketData({
  client,
  marketCode,
  limit = defaultReferenceMarketCandleLimit,
  refreshIntervalMs = defaultReferenceMarketRefreshIntervalMs,
  tickerLoader = getReferenceMarketTicker,
  candlesLoader = getReferenceMarketCandles,
}: UseReferenceMarketDataOptions): ReferenceMarketDataController {
  const [ticker, setTicker] = useState<ReferenceMarketTickerSnapshot | null>(null);
  const [candles, setCandles] = useState<ReferenceMarketCandlesSnapshot | null>(null);
  const [status, setStatus] = useState<ReferenceMarketDataStatus>(
    marketCode === undefined || marketCode.length === 0 ? "idle" : "loading",
  );
  const [revision, setRevision] = useState(0);
  const tickerRef = useRef<ReferenceMarketTickerSnapshot | null>(null);
  const candlesRef = useRef<ReferenceMarketCandlesSnapshot | null>(null);

  useEffect(() => {
    const selectedMarketCode = marketCode ?? "";
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let requestActive = false;
    const isActive = (): boolean => active;

    tickerRef.current = null;
    candlesRef.current = null;
    if (selectedMarketCode.length === 0) {
      void Promise.resolve().then(() => {
        if (!isActive()) return;
        setTicker(null);
        setCandles(null);
        setStatus("idle");
      });
      return () => {
        active = false;
      };
    }
    void Promise.resolve().then(() => {
      if (!isActive()) return;
      setTicker(null);
      setCandles(null);
      setStatus("loading");
    });

    const scheduleRefresh = (): void => {
      if (!active || refreshIntervalMs <= 0) return;
      refreshTimer = setTimeout(() => void load(), refreshIntervalMs);
    };
    const load = async (): Promise<void> => {
      if (!active || requestActive) return;
      requestActive = true;
      try {
        const [nextTicker, nextCandles] = await Promise.all([
          tickerLoader(client, { marketCode: selectedMarketCode }),
          candlesLoader(client, { marketCode: selectedMarketCode, limit }),
        ]);
        if (!isActive()) return;
        tickerRef.current = nextTicker;
        candlesRef.current = nextCandles;
        setTicker(nextTicker);
        setCandles(nextCandles);
        setStatus("ready");
      } catch {
        if (!isActive()) return;
        const hasCurrentSnapshot =
          tickerRef.current?.marketCode === selectedMarketCode &&
          candlesRef.current?.marketCode === selectedMarketCode;
        setStatus(hasCurrentSnapshot ? "stale" : "error");
      } finally {
        requestActive = false;
        scheduleRefresh();
      }
    };

    void load();
    return () => {
      active = false;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [candlesLoader, client, limit, marketCode, refreshIntervalMs, revision, tickerLoader]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { ticker, candles, status, refresh };
}
