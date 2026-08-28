import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketDataCandleInterval } from "@atlas/contracts";

import type { CandleHistorySnapshot } from "../api/market-data-api";
import type {
  MarketDataStreamSubscriptionHandle,
  MarketDataSubscriptionClient,
} from "./market-data-stream-client";

export type CandleHistoryStatus = "error" | "idle" | "loading" | "ready" | "stale";

export interface UseCandleHistoryOptions {
  readonly stream: MarketDataSubscriptionClient;
  readonly marketCode?: string;
  readonly interval: MarketDataCandleInterval;
  readonly limit?: number;
}

export interface CandleHistoryController {
  readonly status: CandleHistoryStatus;
  readonly snapshot: CandleHistorySnapshot | null;
  readonly refresh: () => void;
}

export const defaultCandleHistoryLimit = 120;

export function useCandleHistory({
  stream,
  marketCode,
  interval,
  limit = defaultCandleHistoryLimit,
}: UseCandleHistoryOptions): CandleHistoryController {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("Candle history limit is invalid.");
  }

  const snapshotRef = useRef<CandleHistorySnapshot | null>(null);
  const handleRef = useRef<MarketDataStreamSubscriptionHandle | null>(null);
  const [snapshot, setSnapshot] = useState<CandleHistorySnapshot | null>(null);
  const [status, setStatus] = useState<CandleHistoryStatus>(
    marketCode === undefined || marketCode.length === 0 ? "idle" : "loading",
  );

  const refresh = useCallback((): void => {
    handleRef.current?.retry();
  }, []);

  useEffect(() => {
    let active = true;
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

    void Promise.resolve().then(() => {
      if (!active || selectionMatches(snapshotRef.current)) return;
      snapshotRef.current = null;
      setSnapshot(null);
      setStatus("loading");
    });
    const handle = stream.subscribe(
      { topic: "candles", marketCode: selectedMarketCode, interval, limit },
      {
        onSnapshot: (message) => {
          if (!active || message.topic !== "candles") return;
          snapshotRef.current = message.data;
          setSnapshot(message.data);
          setStatus("ready");
        },
        onUnavailable: () => {
          if (!active) return;
          setStatus(selectionMatches(snapshotRef.current) ? "stale" : "error");
        },
      },
    );
    handleRef.current = handle;

    return () => {
      active = false;
      if (handleRef.current === handle) handleRef.current = null;
      handle.unsubscribe();
    };
  }, [interval, limit, marketCode, stream]);

  return { status, snapshot, refresh };
}
