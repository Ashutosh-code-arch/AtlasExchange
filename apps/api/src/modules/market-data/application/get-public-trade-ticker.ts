import { AssetQuantity } from "../../financial/index.js";
import {
  parseMarketCode,
  type Market,
  type TradingMarketReader,
  type TradingPublicationSequenceReader,
} from "../../trading/index.js";
import type { GetTradeTicker, TradeTickerSnapshot } from "./get-trade-ticker.js";

export interface PublicTradeTicker {
  readonly marketCode: string;
  readonly sequence: string;
  readonly publishedSequence: string;
  readonly lag: string;
  readonly freshness: "current" | "behind";
  readonly asOf: string | null;
  readonly generatedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly lastPrice: string | null;
  readonly lastQuantity: string | null;
  readonly lastExecutedAt: string | null;
  readonly highPrice: string | null;
  readonly lowPrice: string | null;
  readonly baseVolume: string;
  readonly quoteVolume: string;
}

export type GetPublicTradeTickerResult =
  | { readonly status: "found"; readonly ticker: PublicTradeTicker }
  | { readonly status: "not_found" };

export interface GetPublicTradeTickerQuery {
  readonly marketCode: string;
}

function baseVolume(market: Market, lots: bigint): string {
  return AssetQuantity.fromAtomicUnits(
    market.baseAssetCode,
    market.baseAssetScale,
    lots * market.baseLotAtomicUnits,
  ).toCanonicalDecimal();
}

function quoteVolume(market: Market, tickLots: bigint): string {
  const numerator = tickLots * market.baseLotAtomicUnits * market.quoteAtomicUnitsPerPriceTick;
  const denominator = 10n ** BigInt(market.baseAssetScale);
  if (numerator % denominator !== 0n) {
    throw new Error("Ticker quote volume cannot be represented exactly for its market.");
  }
  return AssetQuantity.fromAtomicUnits(
    market.quoteAssetCode,
    market.quoteAssetScale,
    numerator / denominator,
  ).toCanonicalDecimal();
}

function validateSnapshot(snapshot: TradeTickerSnapshot): void {
  if ((snapshot.sequence === 0n) !== (snapshot.asOf === null)) {
    throw new Error("Trade ticker sequence and timestamp are inconsistent.");
  }
  const hasTrades = snapshot.lastTrade !== null;
  if (
    (snapshot.highPriceTicks !== null) !== hasTrades ||
    (snapshot.lowPriceTicks !== null) !== hasTrades ||
    snapshot.baseVolumeLots > 0n !== hasTrades ||
    snapshot.quoteVolumeTickLots > 0n !== hasTrades
  ) {
    throw new Error("Trade ticker window values are inconsistent.");
  }
}

export class GetPublicTradeTicker {
  public constructor(
    private readonly markets: TradingMarketReader,
    private readonly tickers: Pick<GetTradeTicker, "execute">,
    private readonly sequences: TradingPublicationSequenceReader,
  ) {}

  public async execute(query: GetPublicTradeTickerQuery): Promise<GetPublicTradeTickerResult> {
    const marketCode = parseMarketCode(query.marketCode);
    const market = await this.markets.findByCode(marketCode);
    if (market === undefined) return { status: "not_found" };
    const [snapshot, publishedSequence] = await Promise.all([
      this.tickers.execute(marketCode),
      this.sequences.getLastPublishedSequence(marketCode),
    ]);
    if (snapshot.marketCode !== marketCode) {
      throw new Error("Trade ticker returned a different market.");
    }
    validateSnapshot(snapshot);
    if (publishedSequence < snapshot.sequence) {
      throw new Error("Market Data sequence exceeds the Trading publication sequence.");
    }
    const lag = publishedSequence - snapshot.sequence;
    const lastTrade = snapshot.lastTrade;
    return {
      status: "found",
      ticker: {
        marketCode,
        sequence: snapshot.sequence.toString(),
        publishedSequence: publishedSequence.toString(),
        lag: lag.toString(),
        freshness: lag === 0n ? "current" : "behind",
        asOf: snapshot.asOf?.toISOString() ?? null,
        generatedAt: snapshot.windowEnd.toISOString(),
        windowStart: snapshot.windowStart.toISOString(),
        windowEnd: snapshot.windowEnd.toISOString(),
        lastPrice:
          lastTrade === null
            ? null
            : market.limitPriceForTicks(lastTrade.priceTicks).toCanonicalDecimal(),
        lastQuantity: lastTrade === null ? null : baseVolume(market, lastTrade.quantityLots),
        lastExecutedAt: lastTrade?.executedAt.toISOString() ?? null,
        highPrice:
          snapshot.highPriceTicks === null
            ? null
            : market.limitPriceForTicks(snapshot.highPriceTicks).toCanonicalDecimal(),
        lowPrice:
          snapshot.lowPriceTicks === null
            ? null
            : market.limitPriceForTicks(snapshot.lowPriceTicks).toCanonicalDecimal(),
        baseVolume: baseVolume(market, snapshot.baseVolumeLots),
        quoteVolume: quoteVolume(market, snapshot.quoteVolumeTickLots),
      },
    };
  }
}
