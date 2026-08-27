import { parseMarketCode } from "../../trading/index.js";
import type {
  Market,
  TradingMarketReader,
  TradingPublicationSequenceReader,
} from "../../trading/index.js";
import type {
  LevelTwoOrderBookLevel,
  LevelTwoOrderBookReader,
} from "./level-two-order-book-projection.js";

export const defaultPublicOrderBookDepth = 20;
export const maximumPublicOrderBookDepth = 100;

export interface PublicOrderBookLevel {
  readonly price: string;
  readonly quantity: string;
  readonly orderCount: string;
}

export interface PublicLevelTwoOrderBook {
  readonly marketCode: string;
  readonly depth: number;
  readonly sequence: string;
  readonly publishedSequence: string;
  readonly lag: string;
  readonly freshness: "current" | "behind";
  readonly asOf: string | null;
  readonly generatedAt: string;
  readonly bids: readonly PublicOrderBookLevel[];
  readonly asks: readonly PublicOrderBookLevel[];
}

export type GetLevelTwoOrderBookResult =
  | { readonly status: "found"; readonly orderBook: PublicLevelTwoOrderBook }
  | { readonly status: "not_found" };

export interface GetLevelTwoOrderBookQuery {
  readonly marketCode: string;
  readonly depth?: number;
}

function toPublicLevel(market: Market, level: LevelTwoOrderBookLevel): PublicOrderBookLevel {
  return {
    price: market.limitPriceForTicks(level.priceTicks).toCanonicalDecimal(),
    quantity: market.baseQuantityForLots(level.aggregateRemainingLots).toCanonicalDecimal(),
    orderCount: level.orderCount.toString(),
  };
}

export class GetLevelTwoOrderBook {
  public constructor(
    private readonly markets: TradingMarketReader,
    private readonly books: LevelTwoOrderBookReader,
    private readonly sequences: TradingPublicationSequenceReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(query: GetLevelTwoOrderBookQuery): Promise<GetLevelTwoOrderBookResult> {
    const depth = query.depth ?? defaultPublicOrderBookDepth;
    if (!Number.isInteger(depth) || depth < 1 || depth > maximumPublicOrderBookDepth) {
      throw new RangeError("Public order-book depth is invalid.");
    }
    const marketCode = parseMarketCode(query.marketCode);
    const market = await this.markets.findByCode(marketCode);
    if (market === undefined) {
      return { status: "not_found" };
    }
    const [snapshot, publishedSequence] = await Promise.all([
      this.books.getSnapshot(marketCode, depth),
      this.sequences.getLastPublishedSequence(marketCode),
    ]);
    if (publishedSequence < snapshot.sequence) {
      throw new Error("Market Data sequence exceeds the Trading publication sequence.");
    }
    const lag = publishedSequence - snapshot.sequence;
    return {
      status: "found",
      orderBook: {
        marketCode,
        depth,
        sequence: snapshot.sequence.toString(),
        publishedSequence: publishedSequence.toString(),
        lag: lag.toString(),
        freshness: lag === 0n ? "current" : "behind",
        asOf: snapshot.asOf?.toISOString() ?? null,
        generatedAt: this.now().toISOString(),
        bids: snapshot.bids.slice(0, depth).map((level) => toPublicLevel(market, level)),
        asks: snapshot.asks.slice(0, depth).map((level) => toPublicLevel(market, level)),
      },
    };
  }
}
