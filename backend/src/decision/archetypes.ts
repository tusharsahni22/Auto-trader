import type { Candle } from "../types.js";
import { atr, bollingerBandwidth, rollingMax, rollingMin, sma } from "../lib/indicators.js";
import type { ArchetypeCandidate, Regime } from "./types.js";

/**
 * docs/01 §3.1 — MVP builds the first three archetypes only. Detection
 * predicates are simplified where this repo lacks a feed the doc assumes
 * (no OI/funding series yet, so OI-confirmation checks are omitted rather
 * than faked).
 */

function buildTargets(entry: number, stopDistance: number, direction: "LONG" | "SHORT", multiples: [number, number, number], fractions: [number, number, number]) {
  const sign = direction === "LONG" ? 1 : -1;
  return multiples.map((m, i) => ({
    price: entry + sign * stopDistance * m,
    fraction: fractions[i],
    r: m,
  }));
}

/** docs/01 §3.1 TREND_CONTINUATION — targets from the measured move of the prior impulse leg. */
function buildMeasuredMoveTargets(
  entry: number,
  stopDistance: number,
  impulseMagnitude: number,
  direction: "LONG" | "SHORT",
  moveMultiples: [number, number, number],
  fractions: [number, number, number]
) {
  const sign = direction === "LONG" ? 1 : -1;
  return moveMultiples.map((m, i) => {
    const price = entry + sign * impulseMagnitude * m;
    const r = Math.abs(price - entry) / stopDistance;
    return { price, fraction: fractions[i], r };
  });
}

function compressionBreakout(asset: string, candles: Candle[]): ArchetypeCandidate | null {
  const closes = candles.map((c) => c.close);
  const bw = bollingerBandwidth(closes, 20);
  const bwSeries: number[] = [];
  for (let i = 20; i < closes.length; i++) bwSeries.push(bollingerBandwidth(closes.slice(0, i + 1), 20));
  const bwRank = bwSeries.length ? bwSeries.filter((v) => v <= bw).length / bwSeries.length : 0.5;
  if (bwRank > 0.2) return null; // needs to be a genuinely tight compression

  const rangeHigh = rollingMax(closes.slice(-30, -1), 29);
  const rangeLow = rollingMin(closes.slice(-30, -1), 29);
  const last = closes[closes.length - 1];
  const avgVol = candles.slice(-30, -1).reduce((a, c) => a + c.volume, 0) / 29;
  const lastVol = candles[candles.length - 1].volume;
  const volSpike = avgVol > 0 ? lastVol / avgVol : 1;

  const a = atr(candles, 14);
  if (a === 0) return null;

  if (last > rangeHigh && volSpike > 1.5) {
    const stop = rangeLow - 0.5 * a;
    const stopDist = last - stop;
    return {
      archetype: "COMPRESSION_BREAKOUT",
      direction: "LONG",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildTargets(last, stopDist, "LONG", [1.16, 2.47, 3.79], [0.4, 0.35, 0.25]),
      maxHoldHours: 48,
      structuralReason: `Range break above ${rangeHigh.toFixed(2)} after Bollinger bandwidth compression (rank ${(bwRank * 100).toFixed(0)}%), volume ${volSpike.toFixed(1)}x average`,
      atr: a,
    };
  }
  if (last < rangeLow && volSpike > 1.5) {
    const stop = rangeHigh + 0.5 * a;
    const stopDist = stop - last;
    return {
      archetype: "COMPRESSION_BREAKOUT",
      direction: "SHORT",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildTargets(last, stopDist, "SHORT", [1.16, 2.47, 3.79], [0.4, 0.35, 0.25]),
      maxHoldHours: 48,
      structuralReason: `Range break below ${rangeLow.toFixed(2)} after Bollinger bandwidth compression (rank ${(bwRank * 100).toFixed(0)}%), volume ${volSpike.toFixed(1)}x average`,
      atr: a,
    };
  }
  return null;
}

function liquidationReversal(asset: string, candles: Candle[]): ArchetypeCandidate | null {
  // No real liquidation feed in this MVP — proxy with a large-range, high-volume
  // wick candle (a "flush") followed by a >=50% reclaim of that wick.
  const a = atr(candles, 14);
  if (a === 0 || candles.length < 20) return null;
  const avgVol = candles.slice(-20, -1).reduce((a2, c) => a2 + c.volume, 0) / 19;
  const flushIdx = candles.length - 2;
  const flush = candles[flushIdx];
  const current = candles[candles.length - 1];
  const flushRange = flush.high - flush.low;
  const isFlushDown = flush.close < flush.open && flushRange > a * 2 && flush.volume > avgVol * 2.5;
  const isFlushUp = flush.close > flush.open && flushRange > a * 2 && flush.volume > avgVol * 2.5;

  if (isFlushDown) {
    const wickExtreme = flush.low;
    const reclaim = flush.low + flushRange * 0.5;
    if (current.close >= reclaim) {
      const stop = wickExtreme - 0.5 * a;
      const stopDist = current.close - stop;
      return {
        archetype: "LIQUIDATION_REVERSAL",
        direction: "LONG",
        asset,
        entryPrice: current.close,
        stopPrice: stop,
        targets: buildTargets(current.close, stopDist, "LONG", [1.0, 1.8, 2.6], [0.5, 0.3, 0.2]),
        maxHoldHours: 36,
        structuralReason: `Reclaimed 50% of flush wick low ${wickExtreme.toFixed(2)} on ${flush.volume.toFixed(1)} volume (${(flush.volume / avgVol).toFixed(1)}x average)`,
        atr: a,
      };
    }
  }
  if (isFlushUp) {
    const wickExtreme = flush.high;
    const reclaim = flush.high - flushRange * 0.5;
    if (current.close <= reclaim) {
      const stop = wickExtreme + 0.5 * a;
      const stopDist = stop - current.close;
      return {
        archetype: "LIQUIDATION_REVERSAL",
        direction: "SHORT",
        asset,
        entryPrice: current.close,
        stopPrice: stop,
        targets: buildTargets(current.close, stopDist, "SHORT", [1.0, 1.8, 2.6], [0.5, 0.3, 0.2]),
        maxHoldHours: 36,
        structuralReason: `Reclaimed 50% of flush wick high ${wickExtreme.toFixed(2)} on ${flush.volume.toFixed(1)} volume (${(flush.volume / avgVol).toFixed(1)}x average)`,
        atr: a,
      };
    }
  }
  return null;
}

function trendContinuation(asset: string, candles: Candle[], regime: Regime): ArchetypeCandidate | null {
  if (regime !== "TRENDING_UP" && regime !== "TRENDING_DOWN") return null;
  const closes = candles.map((c) => c.close);
  const ema20 = sma(closes, 20);
  const a = atr(candles, 14);
  if (ema20 === null || a === 0) return null;
  const last = closes[closes.length - 1];
  const distToEma = Math.abs(last - ema20);
  const nearEma = distToEma < a * 0.6;
  if (!nearEma) return null;

  const impulseWindow = closes.slice(-40, -10);
  const pullbackWindow = closes.slice(-10);
  if (impulseWindow.length < 10) return null;
  const impulseMove = impulseWindow[impulseWindow.length - 1] - impulseWindow[0];
  const swingLow = rollingMin(pullbackWindow, pullbackWindow.length);
  const swingHigh = rollingMax(pullbackWindow, pullbackWindow.length);

  if (regime === "TRENDING_UP" && impulseMove > 0 && last > ema20 * 0.995) {
    const stop = swingLow - 1.5 * a;
    const stopDist = last - stop;
    if (stopDist <= 0) return null;
    return {
      archetype: "TREND_CONTINUATION",
      direction: "LONG",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildMeasuredMoveTargets(last, stopDist, Math.abs(impulseMove), "LONG", [0.6, 1.0, 1.4], [0.4, 0.35, 0.25]),
      maxHoldHours: 96,
      structuralReason: `Pullback to EMA20 (${ema20.toFixed(2)}) within an established uptrend, holding above last swing low ${swingLow.toFixed(2)}`,
      atr: a,
    };
  }
  if (regime === "TRENDING_DOWN" && impulseMove < 0 && last < ema20 * 1.005) {
    const stop = swingHigh + 1.5 * a;
    const stopDist = stop - last;
    if (stopDist <= 0) return null;
    return {
      archetype: "TREND_CONTINUATION",
      direction: "SHORT",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildMeasuredMoveTargets(last, stopDist, Math.abs(impulseMove), "SHORT", [0.6, 1.0, 1.4], [0.4, 0.35, 0.25]),
      maxHoldHours: 96,
      structuralReason: `Pullback to EMA20 (${ema20.toFixed(2)}) within an established downtrend, holding below last swing high ${swingHigh.toFixed(2)}`,
      atr: a,
    };
  }
  return null;
}

export function detectArchetypes(asset: string, candles: Candle[], regime: Regime): ArchetypeCandidate[] {
  if (candles.length < 60) return [];
  const out: ArchetypeCandidate[] = [];
  const cb = compressionBreakout(asset, candles);
  if (cb) out.push(cb);
  const lr = liquidationReversal(asset, candles);
  if (lr) out.push(lr);
  const tc = trendContinuation(asset, candles, regime);
  if (tc) out.push(tc);

  // Cost ceiling + noise floor validity checks (docs/02 §2.1), applied uniformly.
  return out.filter((c) => {
    const stopDistPct = Math.abs(c.entryPrice - c.stopPrice) / c.entryPrice;
    const noiseFloor = c.atr / c.entryPrice;
    return stopDistPct >= noiseFloor * 0.9; // stop_distance >= ~1.0 x ATR
  });
}
