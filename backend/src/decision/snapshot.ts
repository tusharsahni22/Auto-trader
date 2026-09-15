import type { Candle } from "../types.js";
import { adx, atr, bollingerBandwidth, hurstExponent, logReturns, percentileRank, realizedVolSeries } from "../lib/indicators.js";
import { computeNewsSentiment } from "../news/headlines.js";
import { hoursToNextTier1Event } from "../news/calendar.js";
import type { ArchetypeCandidate, Cluster } from "./types.js";

/**
 * docs/01 §4.1 — the verified feature snapshot every claim (rule-based or
 * LLM) is checked against. Computed once per candidate so every agent sees
 * the exact same numbers, and citation verification (evidence.ts) has a
 * single source of truth to check claimed values against.
 */

export const FEATURE_CLUSTERS: Record<string, Cluster> = {
  rv_30d_rank: "VOLATILITY",
  bollinger_bandwidth: "PRICE_STRUCTURE",
  volume_ratio_20: "FLOW",
  adx_14: "PRICE_STRUCTURE",
  hurst_200: "VOLATILITY",
  stop_distance_atr: "PRICE_STRUCTURE",
  drift_96: "FLOW",
  news_sentiment_score: "NEWS",
  hours_to_next_tier1_event: "EVENT",
};

export interface FeatureSnapshot {
  values: Record<string, number>;
  meta: {
    asset: string;
    archetype: string;
    direction: string;
    regime: string;
    entryPrice: number;
    stopPrice: number;
  };
}

export function buildFeatureSnapshot(candles: Candle[], candidate: ArchetypeCandidate, regimeLabel: string): FeatureSnapshot {
  const closes = candles.map((c) => c.close);

  const rvSeries = realizedVolSeries(closes, 30);
  const rvRank = percentileRank(rvSeries);
  const bw = bollingerBandwidth(closes, 20);
  const avgVol = candles.slice(-20, -1).reduce((a, c) => a + c.volume, 0) / 19;
  const lastVol = candles[candles.length - 1].volume;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const adx14 = adx(candles, 14);
  const hurst = hurstExponent(closes);
  const a = atr(candles, 14);
  const stopDistAtr = a > 0 ? Math.abs(candidate.entryPrice - candidate.stopPrice) / a : 0;
  const rets = logReturns(closes.slice(-96));
  const drift = rets.reduce((s, r) => s + r, 0);
  const newsSentiment = computeNewsSentiment(candidate.asset as "BTCUSDT" | "ETHUSDT");
  const hoursToEvent = hoursToNextTier1Event();

  return {
    values: {
      rv_30d_rank: rvRank,
      bollinger_bandwidth: bw,
      volume_ratio_20: volRatio,
      adx_14: adx14,
      hurst_200: hurst,
      stop_distance_atr: stopDistAtr,
      drift_96: drift,
      news_sentiment_score: newsSentiment,
      hours_to_next_tier1_event: hoursToEvent,
    },
    meta: {
      asset: candidate.asset,
      archetype: candidate.archetype,
      direction: candidate.direction,
      regime: regimeLabel,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopPrice,
    },
  };
}
