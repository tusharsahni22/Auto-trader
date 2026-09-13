import type { Candle } from "../types.js";
import { acf1, adx, atr, atrSeries, hurstExponent, logReturns, percentileRank, realizedVolSeries, stdev } from "../lib/indicators.js";
import { ALL_REGIMES, type Regime, type RegimeSnapshot } from "./types.js";

/**
 * docs/01 §2 — Phase 2 rule-based regime classifier. Runs on the same
 * candles as the rest of the engine (15m) rather than the doc's 4h,
 * since that is what this MVP ingests; thresholds are unchanged, which
 * makes them slightly more reactive than the spec intends. Acceptable
 * for an MVP that says so.
 */

function score(candles: Candle[]): Record<Regime, number> {
  const closes = candles.map((c) => c.close);
  const ema20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
  const ema100Window = closes.slice(-100);
  const ema100 = ema100Window.reduce((a, b) => a + b, 0) / ema100Window.length;
  const a14 = atr(candles, 14);
  const trendZ = a14 > 0 ? (ema20 - ema100) / a14 : 0;

  const adx14 = adx(candles, 14);
  const hurst = hurstExponent(closes);
  const rets = logReturns(closes.slice(-60));
  const acf = acf1(rets);

  const rvSeries = realizedVolSeries(closes, 30);
  const rvRank = percentileRank(rvSeries);

  const atrs = atrSeries(candles, 14).filter((v): v is number => v !== null);
  const atrLongSeries = atrSeries(candles, 100).filter((v): v is number => v !== null);
  const atrShort = atrs[atrs.length - 1] ?? 0;
  const atrLong = atrLongSeries[atrLongSeries.length - 1] ?? atrShort;
  const atrRatio = atrLong > 0 ? atrShort / atrLong : 1;

  const scores: Record<Regime, number> = {
    TRENDING_UP: 0,
    TRENDING_DOWN: 0,
    RANGE_BOUND: 0,
    LOW_VOL_COMPRESSION: 0,
    HIGH_VOL_EXPANSION: 0,
    POST_CAPITULATION: 0,
  };

  if (trendZ > 1.0 && adx14 > 22 && hurst > 0.55) scores.TRENDING_UP = trendZ + adx14 / 50 + hurst;
  if (trendZ < -1.0 && adx14 > 22 && hurst > 0.55) scores.TRENDING_DOWN = -trendZ + adx14 / 50 + hurst;
  if (Math.abs(trendZ) < 0.5 && adx14 < 18 && acf < 0) scores.RANGE_BOUND = (0.5 - Math.abs(trendZ)) + (18 - adx14) / 18 - acf;
  if (rvRank < 0.2 && atrRatio < 0.7) scores.LOW_VOL_COMPRESSION = (0.2 - rvRank) + (0.7 - atrRatio);
  if (rvRank > 0.8 && atrRatio > 1.4) scores.HIGH_VOL_EXPANSION = (rvRank - 0.8) + (atrRatio - 1.4);

  // POST_CAPITULATION proxy: no liquidation feed in this MVP, so approximate with
  // a sharp drawdown + volatility spike over the trailing 72 bars (~18h at 15m).
  const window = closes.slice(-72);
  if (window.length >= 2) {
    const dropPct = (window[window.length - 1] - window[0]) / window[0];
    const recentVol = stdev(logReturns(window));
    if (dropPct < -0.1 && recentVol > stdev(logReturns(closes.slice(-300, -72))) * 1.5) {
      scores.POST_CAPITULATION = Math.abs(dropPct) * 5;
    }
  }

  return scores;
}

export function classifyRegime(asset: string, candles: Candle[], nowMs: number): RegimeSnapshot {
  if (candles.length < 100) {
    return {
      label: "RANGE_BOUND",
      posterior: Object.fromEntries(ALL_REGIMES.map((r) => [r, 1 / ALL_REGIMES.length])) as Record<Regime, number>,
      confidence: 0,
      hoursInRegime: 0,
    };
  }

  const raw = score(candles);
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const posterior = Object.fromEntries(
    ALL_REGIMES.map((r) => [r, total > 0 ? raw[r] / total : 1 / ALL_REGIMES.length])
  ) as Record<Regime, number>;

  let label: Regime = "RANGE_BOUND";
  let best = -Infinity;
  for (const r of ALL_REGIMES) {
    if (raw[r] > best) {
      best = raw[r];
      label = r;
    }
  }
  if (total === 0) label = "RANGE_BOUND";

  const sorted = [...ALL_REGIMES].sort((a, b) => posterior[b] - posterior[a]);
  const confidence = total === 0 ? 0.3 : Math.min(0.95, posterior[sorted[0]] - (posterior[sorted[1]] ?? 0) + 0.5);

  let hoursInRegime = 0;
  const last = regimeHistoryByAsset.get(asset);
  if (last && last.label === label) {
    hoursInRegime = (nowMs - last.since) / 3600000;
  } else {
    regimeHistoryByAsset.set(asset, { label, since: nowMs });
  }

  return { label, posterior, confidence, hoursInRegime };
}

const regimeHistoryByAsset = new Map<string, { label: Regime; since: number }>();
