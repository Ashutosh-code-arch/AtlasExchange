import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketDataCandleInterval } from "@atlas/contracts";

import {
  getCandleHistory,
  type CandleHistoryLoader,
  type CandleHistorySnapshot,
  type MarketDataHttpClient,
} from "../api/market-data-api";

export type CandleHistoryStatus = "error" | "idle" | "loading" | "ready" | "stale";

export interface UseCandleHistoryOptions {
  readonly request: MarketDataHttpClient["request"];
  readonly marketCode?: string;
  readonly interval: MarketDataCandleInterval;
  readonly limit?: number;
  readonly pollIntervalMs?: number;
  readonly loader?: CandleHistoryLoader;
}

export interface CandleHistoryController {
  readonly status: CandleHistoryStatus;
  readonly snapshot: CandleHistorySnapshot | null;
  readonly refresh: () => void;
}

export const defaultCandleHistoryLimit = 120;
export const defaultCandlePollIntervalMs = 5_000;

export function useCandleHistory({
  request,
  marketCode,
  interval,
  limit = defaultCandleHistoryLimit,
  pollIntervalMs = defaultCandlePollIntervalMs,
  loader = getCandleHistory,
}: UseCandleHistoryOptions): CandleHistoryController {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500 || pollIntervalMs > 120_000) {
    throw new RangeError("Candle polling interval is invalid.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("Candle history limit is invalid.");
  }

  const client = useMemo(() => ({ request }), [request]);
  const snapshotRef = useRef<CandleHistorySnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<CandleHistorySnapshot | null>(null);
  const [status, setStatus] = useState<CandleHistoryStatus>(
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
    const selectionMatches = (candidate: CandleHistorySnapshot | null): boolean =>
      candidate?.marketCode === selectedMarketCode && candidate.interval === interval;

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
        const nextSnapshot = await loader(client, {
          marketCode: selectedMarketCode,
          interval,
          limit,
        });
        if (!active) return;
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        setStatus("ready");
      } catch {
        if (!active) return;
        setStatus(selectionMatches(snapshotRef.current) ? "stale" : "error");
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
      if (!selectionMatches(snapshotRef.current)) {
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
  }, [client, interval, limit, loader, marketCode, pollIntervalMs, refreshSequence]);

  return { status, snapshot, refresh };
}
