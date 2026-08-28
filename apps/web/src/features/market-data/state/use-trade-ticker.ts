import { useCallback, useEffect, useRef, useState } from "react";

import type { TradeTickerSnapshot } from "../api/market-data-api";
import type {
  MarketDataStreamSubscriptionHandle,
  MarketDataSubscriptionClient,
} from "./market-data-stream-client";

export type TradeTickerStatus = "error" | "idle" | "loading" | "ready" | "stale";

export interface UseTradeTickerOptions {
  readonly stream: MarketDataSubscriptionClient;
  readonly marketCode?: string;
}

export interface TradeTickerController {
  readonly status: TradeTickerStatus;
  readonly snapshot: TradeTickerSnapshot | null;
  readonly refresh: () => void;
}

export function useTradeTicker({
  stream,
  marketCode,
}: UseTradeTickerOptions): TradeTickerController {
  const snapshotRef = useRef<TradeTickerSnapshot | null>(null);
  const handleRef = useRef<MarketDataStreamSubscriptionHandle | null>(null);
  const [snapshot, setSnapshot] = useState<TradeTickerSnapshot | null>(null);
  const [status, setStatus] = useState<TradeTickerStatus>(
    marketCode === undefined || marketCode.length === 0 ? "idle" : "loading",
  );

  const refresh = useCallback((): void => {
    handleRef.current?.retry();
  }, []);

  useEffect(() => {
    let active = true;
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

    void Promise.resolve().then(() => {
      if (!active || snapshotRef.current?.marketCode === selectedMarketCode) return;
      snapshotRef.current = null;
      setSnapshot(null);
      setStatus("loading");
    });
    const handle = stream.subscribe(
      { topic: "ticker", marketCode: selectedMarketCode },
      {
        onSnapshot: (message) => {
          if (!active || message.topic !== "ticker") return;
          snapshotRef.current = message.data;
          setSnapshot(message.data);
          setStatus("ready");
        },
        onUnavailable: () => {
          if (!active) return;
          setStatus(snapshotRef.current?.marketCode === selectedMarketCode ? "stale" : "error");
        },
      },
    );
    handleRef.current = handle;

    return () => {
      active = false;
      if (handleRef.current === handle) handleRef.current = null;
      handle.unsubscribe();
    };
  }, [marketCode, stream]);

  return { status, snapshot, refresh };
}
