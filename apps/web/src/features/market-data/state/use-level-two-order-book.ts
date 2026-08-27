import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getLevelTwoOrderBook,
  type LevelTwoOrderBookLoader,
  type LevelTwoOrderBookSnapshot,
  type MarketDataHttpClient,
} from "../api/market-data-api";

export type LevelTwoOrderBookStatus = "error" | "idle" | "loading" | "ready" | "stale";

export interface UseLevelTwoOrderBookOptions {
  readonly request: MarketDataHttpClient["request"];
  readonly marketCode?: string;
  readonly depth?: number;
  readonly pollIntervalMs?: number;
  readonly loader?: LevelTwoOrderBookLoader;
}

export interface LevelTwoOrderBookController {
  readonly status: LevelTwoOrderBookStatus;
  readonly snapshot: LevelTwoOrderBookSnapshot | null;
  readonly refresh: () => void;
}

export const defaultOrderBookDepth = 15;
export const defaultOrderBookPollIntervalMs = 2_000;

export function useLevelTwoOrderBook({
  request,
  marketCode,
  depth = defaultOrderBookDepth,
  pollIntervalMs = defaultOrderBookPollIntervalMs,
  loader = getLevelTwoOrderBook,
}: UseLevelTwoOrderBookOptions): LevelTwoOrderBookController {
  if (!Number.isInteger(depth) || depth < 1 || depth > 100) {
    throw new RangeError("Order-book depth is invalid.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
    throw new RangeError("Order-book polling interval is invalid.");
  }

  const client = useMemo(() => ({ request }), [request]);
  const snapshotRef = useRef<LevelTwoOrderBookSnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<LevelTwoOrderBookSnapshot | null>(null);
  const [status, setStatus] = useState<LevelTwoOrderBookStatus>(
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
        if (document.visibilityState === "visible") {
          void load();
        } else {
          schedule();
        }
      }, pollIntervalMs);
    };

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const nextSnapshot = await loader(client, { marketCode: selectedMarketCode, depth });
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
  }, [client, depth, loader, marketCode, pollIntervalMs, refreshSequence]);

  return { status, snapshot, refresh };
}
