import type { ListAssets, ListWallets, WalletBalanceView } from "../../financial/index.js";
import type { GetPublicTradeTicker } from "../../market-data/index.js";
import type { ListMarkets, TradingMarketView } from "../../trading/index.js";
import { addExactDecimals, multiplyExactDecimals } from "../domain/exact-decimal.js";

export const portfolioValuationCurrency = "USD" as const;

export type PortfolioUnpricedReason = "NO_REFERENCE_PRICE" | "NO_VALUATION_MARKET";

export type PortfolioPositionValuation =
  | {
      readonly status: "cash";
      readonly marketCode: null;
      readonly referencePrice: "1";
      readonly referencePriceAsOf: null;
      readonly freshness: "current";
      readonly value: string;
    }
  | {
      readonly status: "valued";
      readonly marketCode: string;
      readonly referencePrice: string;
      readonly referencePriceAsOf: string;
      readonly freshness: "behind" | "current";
      readonly value: string;
    }
  | {
      readonly status: "zero";
      readonly marketCode: null;
      readonly referencePrice: null;
      readonly referencePriceAsOf: null;
      readonly freshness: null;
      readonly value: "0";
    }
  | {
      readonly status: "unpriced";
      readonly reason: PortfolioUnpricedReason;
      readonly marketCode: string | null;
      readonly referencePrice: null;
      readonly referencePriceAsOf: null;
      readonly freshness: null;
      readonly value: null;
    };

export interface PortfolioPositionView {
  readonly assetCode: string;
  readonly displayName: string;
  readonly available: string;
  readonly reserved: string;
  readonly total: string;
  readonly valuation: PortfolioPositionValuation;
}

export interface PortfolioSnapshotView {
  readonly valuationCurrency: typeof portfolioValuationCurrency;
  readonly generatedAt: string;
  readonly positions: readonly PortfolioPositionView[];
  readonly summary: {
    readonly totalValue: string;
    readonly unpricedAssetCodes: readonly string[];
    readonly complete: boolean;
  };
}

export interface GetPortfolioSnapshotQuery {
  readonly ownerId: string;
}

export interface GetPortfolioSnapshotOptions {
  readonly assets: Pick<ListAssets, "execute">;
  readonly wallets: Pick<ListWallets, "execute">;
  readonly markets: Pick<ListMarkets, "execute">;
  readonly tickers: Pick<GetPublicTradeTicker, "execute">;
  readonly clock?: () => Date;
}

function directValuationMarket(
  markets: readonly TradingMarketView[],
  assetCode: string,
): TradingMarketView | undefined {
  const candidates = markets.filter(
    (market) =>
      market.baseAssetCode === assetCode &&
      market.quoteAssetCode === portfolioValuationCurrency &&
      market.status !== "disabled",
  );
  if (candidates.length > 1) {
    throw new Error(`Portfolio has multiple direct valuation markets for ${assetCode}.`);
  }
  return candidates[0];
}

function validateWallet(wallet: WalletBalanceView): void {
  if (addExactDecimals([wallet.available, wallet.reserved]) !== wallet.total) {
    throw new Error(`Financial wallet ${wallet.walletId} does not reconcile.`);
  }
}

export class GetPortfolioSnapshot {
  private readonly clock: () => Date;

  public constructor(private readonly options: GetPortfolioSnapshotOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  public async execute(query: GetPortfolioSnapshotQuery): Promise<PortfolioSnapshotView> {
    const [assetResult, walletResult, marketResult] = await Promise.all([
      this.options.assets.execute(),
      this.options.wallets.execute({ ownerId: query.ownerId }),
      this.options.markets.execute(),
    ]);
    const generatedAt = this.clock();
    if (!Number.isFinite(generatedAt.getTime())) {
      throw new RangeError("Portfolio generation time is invalid.");
    }
    const assetsByCode = new Map<string, (typeof assetResult.assets)[number]>(
      assetResult.assets.map((asset) => [asset.code, asset]),
    );
    if (assetsByCode.size !== assetResult.assets.length) {
      throw new Error("Financial asset catalog contains duplicate asset codes.");
    }
    const sortedWallets = [...walletResult.wallets].sort((left, right) =>
      left.assetCode < right.assetCode ? -1 : left.assetCode > right.assetCode ? 1 : 0,
    );
    if (new Set(sortedWallets.map((wallet) => wallet.assetCode)).size !== sortedWallets.length) {
      throw new Error("Portfolio contains duplicate wallets for an asset.");
    }

    const positions = await Promise.all(
      sortedWallets.map(async (wallet): Promise<PortfolioPositionView> => {
        validateWallet(wallet);
        const asset = assetsByCode.get(wallet.assetCode);
        if (asset === undefined) {
          throw new Error(`Portfolio wallet references unknown asset ${wallet.assetCode}.`);
        }
        const common = {
          assetCode: wallet.assetCode,
          displayName: asset.displayName,
          available: wallet.available,
          reserved: wallet.reserved,
          total: wallet.total,
        };
        if (wallet.total === "0") {
          return {
            ...common,
            valuation: {
              status: "zero",
              marketCode: null,
              referencePrice: null,
              referencePriceAsOf: null,
              freshness: null,
              value: "0",
            },
          };
        }
        if (wallet.assetCode === portfolioValuationCurrency) {
          return {
            ...common,
            valuation: {
              status: "cash",
              marketCode: null,
              referencePrice: "1",
              referencePriceAsOf: null,
              freshness: "current",
              value: wallet.total,
            },
          };
        }
        const market = directValuationMarket(marketResult.markets, wallet.assetCode);
        if (market === undefined) {
          return {
            ...common,
            valuation: {
              status: "unpriced",
              reason: "NO_VALUATION_MARKET",
              marketCode: null,
              referencePrice: null,
              referencePriceAsOf: null,
              freshness: null,
              value: null,
            },
          };
        }
        const tickerResult = await this.options.tickers.execute({ marketCode: market.code });
        if (tickerResult.status === "not_found") {
          throw new Error(`Portfolio valuation market ${market.code} disappeared.`);
        }
        const ticker = tickerResult.ticker;
        if (ticker.lastPrice === null) {
          return {
            ...common,
            valuation: {
              status: "unpriced",
              reason: "NO_REFERENCE_PRICE",
              marketCode: market.code,
              referencePrice: null,
              referencePriceAsOf: null,
              freshness: null,
              value: null,
            },
          };
        }
        if (ticker.lastExecutedAt === null) {
          throw new Error(`Portfolio valuation market ${market.code} has an incomplete price.`);
        }
        return {
          ...common,
          valuation: {
            status: "valued",
            marketCode: market.code,
            referencePrice: ticker.lastPrice,
            referencePriceAsOf: ticker.lastExecutedAt,
            freshness: ticker.freshness,
            value: multiplyExactDecimals(wallet.total, ticker.lastPrice),
          },
        };
      }),
    );
    const unpricedAssetCodes = positions
      .filter((position) => position.valuation.status === "unpriced")
      .map((position) => position.assetCode);
    const totalValue = addExactDecimals(
      positions.flatMap((position) => {
        const value = position.valuation.value;
        return value === null ? [] : [value];
      }),
    );
    return {
      valuationCurrency: portfolioValuationCurrency,
      generatedAt: generatedAt.toISOString(),
      positions,
      summary: {
        totalValue,
        unpricedAssetCodes,
        complete: unpricedAssetCodes.length === 0,
      },
    };
  }
}
