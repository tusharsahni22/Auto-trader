import type { Candle } from "../types.js";

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function trueRanges(candles: Candle[]): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
    );
  }
  return trs;
}

export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const trs = trueRanges(candles);
  const out: (number | null)[] = [null]; // align with candles[0]
  for (let i = 0; i < trs.length; i++) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    const window = trs.slice(i + 1 - period, i + 1);
    out.push(window.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number {
  const series = atrSeries(candles, period);
  const last = series[series.length - 1];
  return last ?? 0;
}

/** log returns from close prices */
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

/** Percentile rank of the last value within its own trailing window, in [0,1]. */
export function percentileRank(values: number[]): number {
  if (values.length < 2) return 0.5;
  const last = values[values.length - 1];
  const sorted = [...values].sort((a, b) => a - b);
  const idx = sorted.findIndex((v) => v >= last);
  return idx < 0 ? 1 : idx / (sorted.length - 1);
}

/** Realized volatility (annualization-free, just stdev of log returns over window). */
export function realizedVol(closes: number[], window: number): number {
  const rets = logReturns(closes.slice(-window - 1));
  return stdev(rets);
}

/** Rolling series of realized vol, one point per bar, for percentile ranking. */
export function realizedVolSeries(closes: number[], window: number): number[] {
  const rets = logReturns(closes);
  const out: number[] = [];
  for (let i = window; i <= rets.length; i++) {
    out.push(stdev(rets.slice(i - window, i)));
  }
  return out;
}

/** Approximate Hurst exponent via rescaled-range (R/S) analysis. */
export function hurstExponent(closes: number[]): number {
  const rets = logReturns(closes);
  if (rets.length < 32) return 0.5;
  const chunkSizes = [8, 16, 32, 64].filter((n) => n <= rets.length);
  const points: [number, number][] = [];
  for (const n of chunkSizes) {
    const chunks = Math.floor(rets.length / n);
    if (chunks < 1) continue;
    const rsValues: number[] = [];
    for (let c = 0; c < chunks; c++) {
      const chunk = rets.slice(c * n, (c + 1) * n);
      const mean = chunk.reduce((a, b) => a + b, 0) / chunk.length;
      let cum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const r of chunk) {
        cum += r - mean;
        if (cum < min) min = cum;
        if (cum > max) max = cum;
      }
      const range = max - min;
      const sd = stdev(chunk);
      if (sd > 0) rsValues.push(range / sd);
    }
    if (rsValues.length === 0) continue;
    const avgRS = rsValues.reduce((a, b) => a + b, 0) / rsValues.length;
    if (avgRS > 0) points.push([Math.log(n), Math.log(avgRS)]);
  }
  if (points.length < 2) return 0.5;
  const n = points.length;
  const sumX = points.reduce((a, [x]) => a + x, 0);
  const sumY = points.reduce((a, [, y]) => a + y, 0);
  const sumXY = points.reduce((a, [x, y]) => a + x * y, 0);
  const sumXX = points.reduce((a, [x]) => a + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  return Math.max(0, Math.min(1, slope));
}

/** Lag-1 autocorrelation of returns. */
export function acf1(returns: number[]): number {
  if (returns.length < 3) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < returns.length; i++) {
    const d = returns[i] - mean;
    den += d * d;
    if (i > 0) num += d * (returns[i - 1] - mean);
  }
  return den === 0 ? 0 : num / den;
}

/** Simplified ADX (trend strength), 0-100. */
export function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2) return 0;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    );
  }
  const smooth = (arr: number[]) => {
    const w = arr.slice(-period);
    return w.reduce((a, b) => a + b, 0);
  };
  const trSum = smooth(trs) || 1e-9;
  const plusDI = (100 * smooth(plusDM)) / trSum;
  const minusDI = (100 * smooth(minusDM)) / trSum;
  const dx = (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI || 1e-9);
  return dx;
}

/** Bollinger bandwidth (upper-lower)/mid, as a fraction. */
export function bollingerBandwidth(closes: number[], period = 20, k = 2): number {
  const mid = sma(closes, period);
  if (mid === null) return 0;
  const sd = stdev(closes.slice(-period));
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  return mid === 0 ? 0 : (upper - lower) / mid;
}

export function rollingMax(values: number[], period: number): number {
  return Math.max(...values.slice(-period));
}

export function rollingMin(values: number[], period: number): number {
  return Math.min(...values.slice(-period));
}
