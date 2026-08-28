import type { MarketDataCandle, MarketDataCandleInterval } from "@atlas/contracts";

const intervalMilliseconds: Record<MarketDataCandleInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export const candleChartGeometry = {
  width: 1_000,
  height: 390,
  left: 18,
  right: 76,
  priceTop: 20,
  priceBottom: 286,
  volumeTop: 306,
  volumeBottom: 352,
} as const;

export interface ChartCandle {
  readonly candle: MarketDataCandle;
  readonly x: number;
  readonly bodyTop: number;
  readonly bodyHeight: number;
  readonly highY: number;
  readonly lowY: number;
  readonly volumeY: number;
  readonly rising: boolean;
}

export interface CandleChartModel {
  readonly candles: readonly ChartCandle[];
  readonly candleWidth: number;
  readonly priceGuides: readonly { readonly label: string; readonly y: number }[];
  readonly timeGuides: readonly { readonly label: string; readonly x: number }[];
}

export function displayCandleTimestamp(value: string, interval: MarketDataCandleInterval): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    ...(interval === "1d" ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(new Date(value));
}

function compactDecimal(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 1_000 ? 0 : value >= 1 ? 2 : 6,
  }).format(value);
}

export function buildCandleChartModel(
  candles: readonly MarketDataCandle[],
  interval: MarketDataCandleInterval,
): CandleChartModel | null {
  if (candles.length === 0) return null;
  const values = candles.flatMap((candle) => [
    Number(candle.openPrice),
    Number(candle.highPrice),
    Number(candle.lowPrice),
    Number(candle.closePrice),
  ]);
  const volumes = candles.map((candle) => Number(candle.baseVolume));
  if ([...values, ...volumes].some((value) => !Number.isFinite(value))) return null;

  const { width, left, right, priceTop, priceBottom, volumeTop, volumeBottom } =
    candleChartGeometry;
  const rawMinimum = Math.min(...candles.map((candle) => Number(candle.lowPrice)));
  const rawMaximum = Math.max(...candles.map((candle) => Number(candle.highPrice)));
  const pricePadding = Math.max(
    (rawMaximum - rawMinimum) * 0.08,
    Math.abs(rawMaximum) * 0.001,
    1e-8,
  );
  const minimum = rawMinimum - pricePadding;
  const maximum = rawMaximum + pricePadding;
  const priceRange = maximum - minimum;
  const firstStart = Date.parse(candles[0]!.start);
  const lastEnd = Date.parse(candles[candles.length - 1]!.end);
  const timeRange = Math.max(lastEnd - firstStart, intervalMilliseconds[interval]);
  const plotWidth = width - left - right;
  const bucketWidth = (plotWidth * intervalMilliseconds[interval]) / timeRange;
  const candleWidth = Math.max(2, Math.min(14, bucketWidth * 0.62));
  const maximumVolume = Math.max(...volumes, 1e-8);
  const priceY = (value: number): number =>
    priceTop + ((maximum - value) / priceRange) * (priceBottom - priceTop);
  const timeX = (value: number): number => left + ((value - firstStart) / timeRange) * plotWidth;

  const chartCandles = candles.map((candle): ChartCandle => {
    const open = Number(candle.openPrice);
    const close = Number(candle.closePrice);
    const openY = priceY(open);
    const closeY = priceY(close);
    return {
      candle,
      x: timeX(Date.parse(candle.start) + intervalMilliseconds[interval] / 2),
      bodyTop: Math.min(openY, closeY),
      bodyHeight: Math.max(1.5, Math.abs(closeY - openY)),
      highY: priceY(Number(candle.highPrice)),
      lowY: priceY(Number(candle.lowPrice)),
      volumeY:
        volumeBottom - (Number(candle.baseVolume) / maximumVolume) * (volumeBottom - volumeTop),
      rising: close >= open,
    };
  });
  const priceGuides = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return {
      label: compactDecimal(maximum - priceRange * ratio),
      y: priceTop + (priceBottom - priceTop) * ratio,
    };
  });
  const middleTime = firstStart + timeRange / 2;
  const timeGuides = [firstStart, middleTime, lastEnd].map((time) => ({
    label: displayCandleTimestamp(new Date(time).toISOString(), interval),
    x: timeX(time),
  }));
  return { candles: chartCandles, candleWidth, priceGuides, timeGuides };
}
