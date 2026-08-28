import { AssetQuantity } from "../../financial/index.js";
import {
  parseMarketCode,
  type Market,
  type TradingMarketReader,
  type TradingPublicationSequenceReader,
} from "../../trading/index.js";
import { getCandleBucket, type CandleInterval } from "./candle-projection.js";
import type { CandleHistorySnapshot, GetCandles, HistoricalCandle } from "./get-candles.js";

export interface PublicHistoricalCandle {
  readonly start: string;
  readonly end: string;
  readonly openPrice: string;
  readonly highPrice: string;
  readonly lowPrice: string;
  readonly closePrice: string;
  readonly baseVolume: string;
  readonly quoteVolume: string;
  readonly tradeCount: string;
  readonly closed: boolean;
}

export interface PublicCandleHistory {
  readonly marketCode: string;
  readonly interval: CandleInterval;
  readonly limit: number;
  readonly sequence: string;
  readonly publishedSequence: string;
  readonly lag: string;
  readonly freshness: "current" | "behind";
  readonly asOf: string | null;
  readonly generatedAt: string;
  readonly candles: readonly PublicHistoricalCandle[];
  readonly nextBefore: string | null;
}

export type GetPublicCandlesResult =
  | { readonly status: "found"; readonly history: PublicCandleHistory }
  | { readonly status: "not_found" };

export interface GetPublicCandlesQuery {
  readonly marketCode: string;
  readonly interval: CandleInterval;
  readonly limit?: number;
  readonly before?: string;
}

function quoteVolume(market: Market, tickLots: bigint): string {
  const numerator = tickLots * market.baseLotAtomicUnits * market.quoteAtomicUnitsPerPriceTick;
  const denominator = 10n ** BigInt(market.baseAssetScale);
  if (numerator % denominator !== 0n) {
    throw new Error("Candle quote volume cannot be represented exactly for its market.");
  }
  return AssetQuantity.fromAtomicUnits(
    market.quoteAssetCode,
    market.quoteAssetScale,
    numerator / denominator,
  ).toCanonicalDecimal();
}

function validateCandle(candle: HistoricalCandle, interval: CandleInterval): void {
  const bucket = getCandleBucket(candle.start, interval);
  if (
    bucket.start.getTime() !== candle.start.getTime() ||
    bucket.end.getTime() !== candle.end.getTime()
  ) {
    throw new Error("Candle history contains an invalid interval boundary.");
  }
  if (
    candle.openPriceTicks < 1n ||
    candle.highPriceTicks < candle.lowPriceTicks ||
    candle.openPriceTicks < candle.lowPriceTicks ||
    candle.openPriceTicks > candle.highPriceTicks ||
    candle.closePriceTicks < candle.lowPriceTicks ||
    candle.closePriceTicks > candle.highPriceTicks ||
    candle.baseVolumeLots < 1n ||
    candle.quoteVolumeTickLots < 1n ||
    candle.tradeCount < 1n
  ) {
    throw new Error("Candle history contains inconsistent exact values.");
  }
}

function validateSnapshot(snapshot: CandleHistorySnapshot): void {
  if ((snapshot.sequence === 0n) !== (snapshot.asOf === null)) {
    throw new Error("Candle sequence and timestamp are inconsistent.");
  }
  if (
    snapshot.candles.length > snapshot.limit ||
    !Number.isFinite(snapshot.generatedAt.getTime())
  ) {
    throw new Error("Candle history page is inconsistent.");
  }
  for (const [index, candle] of snapshot.candles.entries()) {
    validateCandle(candle, snapshot.interval);
    const previous = snapshot.candles[index - 1];
    if (previous !== undefined && previous.start >= candle.start) {
      throw new Error("Candle history is not strictly ordered.");
    }
    if (candle.start > snapshot.generatedAt) {
      throw new Error("Candle history begins after its generation time.");
    }
  }
  const first = snapshot.candles[0];
  if (
    snapshot.nextBefore !== null &&
    (first === undefined || snapshot.nextBefore.getTime() !== first.start.getTime())
  ) {
    throw new Error("Candle history cursor is inconsistent.");
  }
}

function toPublicCandle(
  market: Market,
  candle: HistoricalCandle,
  generatedAt: Date,
): PublicHistoricalCandle {
  return {
    start: candle.start.toISOString(),
    end: candle.end.toISOString(),
    openPrice: market.limitPriceForTicks(candle.openPriceTicks).toCanonicalDecimal(),
    highPrice: market.limitPriceForTicks(candle.highPriceTicks).toCanonicalDecimal(),
    lowPrice: market.limitPriceForTicks(candle.lowPriceTicks).toCanonicalDecimal(),
    closePrice: market.limitPriceForTicks(candle.closePriceTicks).toCanonicalDecimal(),
    baseVolume: market.baseQuantityForLots(candle.baseVolumeLots).toCanonicalDecimal(),
    quoteVolume: quoteVolume(market, candle.quoteVolumeTickLots),
    tradeCount: candle.tradeCount.toString(),
    closed: candle.end <= generatedAt,
  };
}

export class GetPublicCandles {
  public constructor(
    private readonly markets: TradingMarketReader,
    private readonly candles: Pick<GetCandles, "execute">,
    private readonly sequences: TradingPublicationSequenceReader,
  ) {}

  public async execute(query: GetPublicCandlesQuery): Promise<GetPublicCandlesResult> {
    const marketCode = parseMarketCode(query.marketCode);
    const market = await this.markets.findByCode(marketCode);
    if (market === undefined) return { status: "not_found" };
    const historyQuery = {
      marketCode,
      interval: query.interval,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.before === undefined ? {} : { before: new Date(query.before) }),
    };
    const [snapshot, publishedSequence] = await Promise.all([
      this.candles.execute(historyQuery),
      this.sequences.getLastPublishedSequence(marketCode),
    ]);
    if (snapshot.marketCode !== marketCode || snapshot.interval !== query.interval) {
      throw new Error("Candle history returned a different market or interval.");
    }
    validateSnapshot(snapshot);
    if (publishedSequence < snapshot.sequence) {
      throw new Error("Market Data sequence exceeds the Trading publication sequence.");
    }
    const lag = publishedSequence - snapshot.sequence;
    return {
      status: "found",
      history: {
        marketCode,
        interval: snapshot.interval,
        limit: snapshot.limit,
        sequence: snapshot.sequence.toString(),
        publishedSequence: publishedSequence.toString(),
        lag: lag.toString(),
        freshness: lag === 0n ? "current" : "behind",
        asOf: snapshot.asOf?.toISOString() ?? null,
        generatedAt: snapshot.generatedAt.toISOString(),
        candles: snapshot.candles.map((candle) =>
          toPublicCandle(market, candle, snapshot.generatedAt),
        ),
        nextBefore: snapshot.nextBefore?.toISOString() ?? null,
      },
    };
  }
}
