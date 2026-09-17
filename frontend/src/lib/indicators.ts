import type { Candle } from "./types";

/**
 * EMA as a series aligned to `values`. Entries before the seed period are null
 * so the result can be zipped straight onto candle times.
 */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Rolling extreme over the `period` bars *before* each index — the level a
 * breakout would be measured against, so the current bar is excluded.
 */
export function rollingExtremeSeries(
  values: number[],
  period: number,
  kind: "max" | "min"
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const window = values.slice(i - period, i);
    out[i] = kind === "max" ? Math.max(...window) : Math.min(...window);
  }
  return out;
}

export interface OverlayPoint {
  time: number;
  value: number;
}

function zip(candles: Candle[], series: (number | null)[]): OverlayPoint[] {
  const points: OverlayPoint[] = [];
  for (let i = 0; i < candles.length; i++) {
    const value = series[i];
    if (value !== null && Number.isFinite(value)) points.push({ time: candles[i].time, value });
  }
  return points;
}

export function emaOverlay(candles: Candle[], period: number): OverlayPoint[] {
  return zip(candles, emaSeries(candles.map((c) => c.close), period));
}

export function breakoutOverlay(
  candles: Candle[],
  lookback: number,
  kind: "max" | "min"
): OverlayPoint[] {
  const source = candles.map((c) => (kind === "max" ? c.high : c.low));
  return zip(candles, rollingExtremeSeries(source, lookback, kind));
}

/** Simple moving average overlay, used by the SMA strategy preset. */
export function smaOverlay(candles: Candle[], period: number): OverlayPoint[] {
  const closes = candles.map((c) => c.close);
  const series: (number | null)[] = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) series[i] = sum / period;
  }
  return zip(candles, series);
}

/** Bollinger bands as [upper, lower] overlays around an SMA basis. */
export function bollingerOverlays(
  candles: Candle[],
  period = 20,
  k = 2
): { upper: OverlayPoint[]; lower: OverlayPoint[] } {
  const closes = candles.map((c) => c.close);
  const upper: OverlayPoint[] = [];
  const lower: OverlayPoint[] = [];

  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push({ time: candles[i].time, value: mean + k * sd });
    lower.push({ time: candles[i].time, value: mean - k * sd });
  }

  return { upper, lower };
}
