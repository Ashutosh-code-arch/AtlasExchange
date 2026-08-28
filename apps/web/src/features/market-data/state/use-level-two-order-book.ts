import { useCallback, useEffect, useRef, useState } from "react";

import type { LevelTwoOrderBookSnapshot } from "../api/market-data-api";
import type {
  MarketDataStreamSubscriptionHandle,
  MarketDataSubscriptionClient,
} from "./market-data-stream-client";

export type LevelTwoOrderBookStatus = "error" | "idle" | "loading" | "ready" | "stale";

export interface UseLevelTwoOrderBookOptions {
  readonly stream: MarketDataSubscriptionClient;
  readonly marketCode?: string;
  readonly depth?: number;
}

export interface LevelTwoOrderBookController {
  readonly status: LevelTwoOrderBookStatus;
  readonly snapshot: LevelTwoOrderBookSnapshot | null;
  readonly refresh: () => void;
}

export const defaultOrderBookDepth = 15;

export function useLevelTwoOrderBook({
  stream,
  marketCode,
  depth = defaultOrderBookDepth,
}: UseLevelTwoOrderBookOptions): LevelTwoOrderBookController {
  if (!Number.isInteger(depth) || depth < 1 || depth > 100) {
    throw new RangeError("Order-book depth is invalid.");
  }

  const snapshotRef = useRef<LevelTwoOrderBookSnapshot | null>(null);
  const handleRef = useRef<MarketDataStreamSubscriptionHandle | null>(null);
  const [snapshot, setSnapshot] = useState<LevelTwoOrderBookSnapshot | null>(null);
  const [status, setStatus] = useState<LevelTwoOrderBookStatus>(
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
      { topic: "order_book", marketCode: selectedMarketCode, depth },
      {
        onSnapshot: (message) => {
          if (!active || message.topic !== "order_book") return;
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
  }, [depth, marketCode, stream]);

  return { status, snapshot, refresh };
}
