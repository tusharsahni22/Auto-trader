import type { Candle } from "../types.js";
import { atr, bollingerBandwidth, ema, rollingMax, rollingMin, rsi, sma } from "../lib/indicators.js";
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
  // FIX: Use true EMA, not SMA. The prior code used sma() but labelled the variable ema20,
  // meaning every EMA20 pullback trade was actually anchored to a Simple Moving Average.
  const ema20 = ema(closes, 20);
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

/**
 * EMA_CROSSOVER — EMA9 crossing EMA21 with ADX trend confirmation.
 * The most common crypto swing signal. Catches trend starts early.
 * Conservative stop: below the recent swing low/high + ATR buffer.
 */
function emaCrossover(asset: string, candles: Candle[]): ArchetypeCandidate | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const a = atr(candles, 14);
  if (a === 0) return null;

  // Compute EMA9 and EMA21 for the last 2 bars to detect the cross
  const ema9Now = ema(closes, 9);
  const ema21Now = ema(closes, 21);
  const ema9Prev = ema(closes.slice(0, -1), 9);
  const ema21Prev = ema(closes.slice(0, -1), 21);
  if (ema9Now === null || ema21Now === null || ema9Prev === null || ema21Prev === null) return null;

  const last = closes[closes.length - 1];
  const bullishCross = ema9Prev <= ema21Prev && ema9Now > ema21Now;
  const bearishCross = ema9Prev >= ema21Prev && ema9Now < ema21Now;

  if (bullishCross) {
    const recentLow = rollingMin(closes.slice(-10), 10);
    const stop = recentLow - 1.0 * a;
    const stopDist = last - stop;
    if (stopDist <= 0) return null;
    return {
      archetype: "EMA_CROSSOVER",
      direction: "LONG",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildTargets(last, stopDist, "LONG", [1.2, 2.0, 3.0], [0.4, 0.35, 0.25]),
      maxHoldHours: 72,
      structuralReason: `EMA9 crossed above EMA21 (${ema9Now.toFixed(2)} > ${ema21Now.toFixed(2)}), bullish momentum shift`,
      atr: a,
    };
  }
  if (bearishCross) {
    const recentHigh = rollingMax(closes.slice(-10), 10);
    const stop = recentHigh + 1.0 * a;
    const stopDist = stop - last;
    if (stopDist <= 0) return null;
    return {
      archetype: "EMA_CROSSOVER",
      direction: "SHORT",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildTargets(last, stopDist, "SHORT", [1.2, 2.0, 3.0], [0.4, 0.35, 0.25]),
      maxHoldHours: 72,
      structuralReason: `EMA9 crossed below EMA21 (${ema9Now.toFixed(2)} < ${ema21Now.toFixed(2)}), bearish momentum shift`,
      atr: a,
    };
  }
  return null;
}

/**
 * RSI_DIVERGENCE — Price makes a new extreme but RSI does not confirm.
 * Classic reversal signal. Looks at the last 20 bars for divergence.
 */
function rsiDivergence(asset: string, candles: Candle[]): ArchetypeCandidate | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const a = atr(candles, 14);
  if (a === 0) return null;

  // Compute RSI at two points: 10 bars ago and now
  const rsiNow = rsi(closes, 14);
  const rsiPrev = rsi(closes.slice(0, -10), 14);
  if (rsiNow === null || rsiPrev === null) return null;

  const last = closes[closes.length - 1];
  const prevClose = closes[closes.length - 11];

  // Bullish divergence: price made lower low but RSI made higher low
  if (last < prevClose && rsiNow > rsiPrev && rsiNow < 40) {
    const recentLow = rollingMin(closes.slice(-15), 15);
    const stop = recentLow - 1.0 * a;
    const stopDist = last - stop;
    if (stopDist <= 0) return null;
    return {
      archetype: "RSI_DIVERGENCE",
      direction: "LONG",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildTargets(last, stopDist, "LONG", [1.0, 1.8, 2.5], [0.45, 0.35, 0.2]),
      maxHoldHours: 48,
      structuralReason: `Bullish RSI divergence: price lower (${prevClose.toFixed(2)}→${last.toFixed(2)}) but RSI higher (${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)})`,
      atr: a,
    };
  }

  // Bearish divergence: price made higher high but RSI made lower high
  if (last > prevClose && rsiNow < rsiPrev && rsiNow > 60) {
    const recentHigh = rollingMax(closes.slice(-15), 15);
    const stop = recentHigh + 1.0 * a;
    const stopDist = stop - last;
    if (stopDist <= 0) return null;
    return {
      archetype: "RSI_DIVERGENCE",
      direction: "SHORT",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: buildTargets(last, stopDist, "SHORT", [1.0, 1.8, 2.5], [0.45, 0.35, 0.2]),
      maxHoldHours: 48,
      structuralReason: `Bearish RSI divergence: price higher (${prevClose.toFixed(2)}→${last.toFixed(2)}) but RSI lower (${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)})`,
      atr: a,
    };
  }
  return null;
}

/**
 * VWAP_BOUNCE — Price touches the session VWAP (approximated as volume-weighted
 * average of last 96 bars = 24h on 15m) and bounces with volume confirmation.
 */
function vwapBounce(asset: string, candles: Candle[]): ArchetypeCandidate | null {
  if (candles.length < 96) return null;
  const a = atr(candles, 14);
  if (a === 0) return null;

  // Approximate VWAP over last 96 bars (24h on 15m candles)
  const window = candles.slice(-96);
  let cumPV = 0;
  let cumVol = 0;
  for (const c of window) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
  }
  const vwap = cumVol > 0 ? cumPV / cumVol : 0;
  if (vwap === 0) return null;

  const last = candles[candles.length - 1];
  const lastClose = last.close;
  const distToVwap = Math.abs(lastClose - vwap);

  // Price must be within 0.5 ATR of VWAP
  if (distToVwap > a * 0.5) return null;

  // Volume confirmation: last bar > 1.3x average
  const avgVol = window.slice(0, -1).reduce((s, c) => s + c.volume, 0) / (window.length - 1);
  const volSpike = avgVol > 0 ? last.volume / avgVol : 1;
  if (volSpike < 1.3) return null;

  // Determine bounce direction from candle body
  const isBullishCandle = last.close > last.open;
  const isBearishCandle = last.close < last.open;

  if (isBullishCandle && lastClose >= vwap) {
    const stop = vwap - 1.5 * a;
    const stopDist = lastClose - stop;
    if (stopDist <= 0) return null;
    return {
      archetype: "VWAP_BOUNCE",
      direction: "LONG",
      asset,
      entryPrice: lastClose,
      stopPrice: stop,
      targets: buildTargets(lastClose, stopDist, "LONG", [1.0, 1.6, 2.2], [0.45, 0.35, 0.2]),
      maxHoldHours: 24,
      structuralReason: `Bullish bounce off VWAP (${vwap.toFixed(2)}) with ${volSpike.toFixed(1)}x volume`,
      atr: a,
    };
  }
  if (isBearishCandle && lastClose <= vwap) {
    const stop = vwap + 1.5 * a;
    const stopDist = stop - lastClose;
    if (stopDist <= 0) return null;
    return {
      archetype: "VWAP_BOUNCE",
      direction: "SHORT",
      asset,
      entryPrice: lastClose,
      stopPrice: stop,
      targets: buildTargets(lastClose, stopDist, "SHORT", [1.0, 1.6, 2.2], [0.45, 0.35, 0.2]),
      maxHoldHours: 24,
      structuralReason: `Bearish rejection at VWAP (${vwap.toFixed(2)}) with ${volSpike.toFixed(1)}x volume`,
      atr: a,
    };
  }
  return null;
}

/**
 * RANGE_MEAN_REVERSION — In range-bound markets, fade the extremes.
 * Long near range bottom, short near range top. The engine previously
 * had ZERO strategies for range-bound markets — this fills that gap.
 */
function rangeMeanReversion(asset: string, candles: Candle[], regime: Regime): ArchetypeCandidate | null {
  if (regime !== "RANGE_BOUND" && regime !== "LOW_VOL_COMPRESSION") return null;
  if (candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  const a = atr(candles, 14);
  if (a === 0) return null;

  const rangeHigh = rollingMax(closes.slice(-40), 40);
  const rangeLow = rollingMin(closes.slice(-40), 40);
  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize < a * 2) return null; // range must be at least 2 ATR wide

  const last = closes[closes.length - 1];
  const positionInRange = (last - rangeLow) / rangeSize;

  // Current RSI for confluence
  const currentRsi = rsi(closes, 14);

  // Long near range bottom (bottom 20%)
  if (positionInRange < 0.20 && (currentRsi === null || currentRsi < 35)) {
    const stop = rangeLow - 0.5 * a;
    const stopDist = last - stop;
    if (stopDist <= 0) return null;
    const midRange = (rangeHigh + rangeLow) / 2;
    // Second target sits 5% of the RANGE below the far edge (it was 5% of price, which lands on the wrong side of entry).
    const tp2Price = rangeHigh - rangeSize * 0.05;
    const tp1R = (midRange - last) / stopDist;
    const tp2R = (tp2Price - last) / stopDist;
    if (tp2R < 1.0) return null; // not enough room to be worth the costs
    return {
      archetype: "RANGE_MEAN_REVERSION",
      direction: "LONG",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: [
        { price: midRange, fraction: 0.5, r: tp1R },
        { price: tp2Price, fraction: 0.5, r: tp2R },
      ],
      maxHoldHours: 48,
      structuralReason: `Near range bottom (${(positionInRange * 100).toFixed(0)}% of range ${rangeLow.toFixed(2)}–${rangeHigh.toFixed(2)}), RSI ${currentRsi?.toFixed(1) ?? 'N/A'} oversold`,
      atr: a,
    };
  }

  // Short near range top (top 20%)
  if (positionInRange > 0.80 && (currentRsi === null || currentRsi > 65)) {
    const stop = rangeHigh + 0.5 * a;
    const stopDist = stop - last;
    if (stopDist <= 0) return null;
    const midRange = (rangeHigh + rangeLow) / 2;
    const tp2Price = rangeLow + rangeSize * 0.05;
    const tp1R = (last - midRange) / stopDist;
    const tp2R = (last - tp2Price) / stopDist;
    if (tp2R < 1.0) return null;
    return {
      archetype: "RANGE_MEAN_REVERSION",
      direction: "SHORT",
      asset,
      entryPrice: last,
      stopPrice: stop,
      targets: [
        { price: midRange, fraction: 0.5, r: tp1R },
        { price: tp2Price, fraction: 0.5, r: tp2R },
      ],
      maxHoldHours: 48,
      structuralReason: `Near range top (${(positionInRange * 100).toFixed(0)}% of range ${rangeLow.toFixed(2)}–${rangeHigh.toFixed(2)}), RSI ${currentRsi?.toFixed(1) ?? 'N/A'} overbought`,
      atr: a,
    };
  }
  return null;
}

export function detectArchetypes(asset: string, candles: Candle[], regime: Regime): ArchetypeCandidate[] {
  if (candles.length < 60) return [];
  const out: ArchetypeCandidate[] = [];

  // Original 3 detectors
  const cb = compressionBreakout(asset, candles);
  if (cb) out.push(cb);
  const lr = liquidationReversal(asset, candles);
  if (lr) out.push(lr);
  const tc = trendContinuation(asset, candles, regime);
  if (tc) out.push(tc);

  // 4 new detectors — maximize trade opportunities across all market conditions
  const ec = emaCrossover(asset, candles);
  if (ec) out.push(ec);
  const rd = rsiDivergence(asset, candles);
  if (rd) out.push(rd);
  const vb = vwapBounce(asset, candles);
  if (vb) out.push(vb);
  const mr = rangeMeanReversion(asset, candles, regime);
  if (mr) out.push(mr);

  // Cost ceiling + noise floor validity checks (docs/02 §2.1), applied uniformly.
  return out.filter((c) => {
    const stopDistPct = Math.abs(c.entryPrice - c.stopPrice) / c.entryPrice;
    const noiseFloor = c.atr / c.entryPrice;
    return stopDistPct >= noiseFloor * 0.9; // stop_distance >= ~1.0 x ATR
  });
}

