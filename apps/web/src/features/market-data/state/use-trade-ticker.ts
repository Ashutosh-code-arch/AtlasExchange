import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getTradeTicker,
  type MarketDataHttpClient,
  type TradeTickerLoader,
  type TradeTickerSnapshot,
} from "../api/market-data-api";

export type TradeTickerStatus = "error" | "idle" | "loading" | "ready" | "stale";

export interface UseTradeTickerOptions {
  readonly request: MarketDataHttpClient["request"];
  readonly marketCode?: string;
  readonly pollIntervalMs?: number;
  readonly loader?: TradeTickerLoader;
}

export interface TradeTickerController {
  readonly status: TradeTickerStatus;
  readonly snapshot: TradeTickerSnapshot | null;
  readonly refresh: () => void;
}

export const defaultTickerPollIntervalMs = 2_000;

export function useTradeTicker({
  request,
  marketCode,
  pollIntervalMs = defaultTickerPollIntervalMs,
  loader = getTradeTicker,
}: UseTradeTickerOptions): TradeTickerController {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
    throw new RangeError("Ticker polling interval is invalid.");
  }

  const client = useMemo(() => ({ request }), [request]);
  const snapshotRef = useRef<TradeTickerSnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<TradeTickerSnapshot | null>(null);
  const [status, setStatus] = useState<TradeTickerStatus>(
    marketCode === undefined || marketCode.length === 0 ? "idle" : "loading",
  );
  const [refreshSequence, setRefreshSequence] = useState(0);

  const refresh = useCallback((): void => {
    setRefreshSequence((current) => current + 1);
  }, []);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const selectedMarketCode = marketCode ?? "";

    if (selectedMarketCode.length === 0) {
      void Promise.resolve().then(() => {
        if (!active) return;
        snapshotRef.current = null;
        setSnapshot(null);
        setStatus("idle");
      });
      return () => {
        active = false;
      };
    }

    const schedule = (): void => {
      if (!active) return;
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") void load();
        else schedule();
      }, pollIntervalMs);
    };

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const nextSnapshot = await loader(client, { marketCode: selectedMarketCode });
        if (!active) return;
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        setStatus("ready");
      } catch {
        if (!active) return;
        const hasCurrentSnapshot = snapshotRef.current?.marketCode === selectedMarketCode;
        setStatus(hasCurrentSnapshot ? "stale" : "error");
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const handleVisibilityChange = (): void => {
      if (!active || document.visibilityState !== "visible") return;
      if (timer !== undefined) clearTimeout(timer);
      void load();
    };

    void Promise.resolve().then(() => {
      if (!active) return;
      if (snapshotRef.current?.marketCode !== selectedMarketCode) {
        snapshotRef.current = null;
        setSnapshot(null);
        setStatus("loading");
      }
      if (document.visibilityState === "visible") void load();
      else schedule();
    });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [client, loader, marketCode, pollIntervalMs, refreshSequence]);

  return { status, snapshot, refresh };
}
