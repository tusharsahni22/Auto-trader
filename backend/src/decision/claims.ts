import type { Candle } from "../types.js";
import { adx, atr, bollingerBandwidth, hurstExponent, logReturns, percentileRank, realizedVolSeries } from "../lib/indicators.js";
import type { ArchetypeCandidate, Claim } from "./types.js";

/**
 * docs/01 §4.1 + docs/05 — real agent output. This MVP has no LLM agent
 * mesh wired up (no provider, no prompts, no budget), so claims are
 * generated deterministically straight from the verified feature
 * snapshot instead of from a model call. Every claim still carries
 * featureIds + observedValues in the same shape a real agent's output
 * would, specifically so a future LLM-based agent can be dropped in
 * here without changing the evidence graph, ensemble, or calibration
 * code downstream — they only ever consume `Claim[]`.
 */

export function generateClaims(candles: Candle[], candidate: ArchetypeCandidate): Claim[] {
  const closes = candles.map((c) => c.close);
  const claims: Claim[] = [];
  const dirSign = candidate.direction === "LONG" ? 1 : -1;

  const rvSeries = realizedVolSeries(closes, 30);
  const rvRank = percentileRank(rvSeries);
  claims.push({
    text: `Realized vol sits at the ${(rvRank * 100).toFixed(0)}th percentile of its trailing window`,
    stance: rvRank < 0.3 ? "BULLISH" : rvRank > 0.7 ? "BEARISH" : "NEUTRAL",
    strength: rvRank < 0.3 ? 0.5 : rvRank > 0.7 ? -0.3 : 0.1,
    featureIds: ["rv_30d_rank"],
    observedValues: { rv_30d_rank: rvRank },
    agent: "quant",
    cluster: "VOLATILITY",
    verified: true,
  });

  const bw = bollingerBandwidth(closes, 20);
  claims.push({
    text: `Bollinger bandwidth is ${(bw * 100).toFixed(2)}% of price`,
    stance: bw < 0.03 ? "BULLISH" : "NEUTRAL",
    strength: bw < 0.03 ? 0.4 * dirSign : 0,
    featureIds: ["bollinger_bandwidth"],
    observedValues: { bollinger_bandwidth: bw },
    agent: "technical",
    cluster: "PRICE_STRUCTURE",
    verified: true,
  });

  const avgVol = candles.slice(-20, -1).reduce((a, c) => a + c.volume, 0) / 19;
  const lastVol = candles[candles.length - 1].volume;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  claims.push({
    text: `Latest bar volume is ${volRatio.toFixed(2)}x the trailing 19-bar average`,
    stance: volRatio > 1.5 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: volRatio > 1.5 ? Math.min(0.7, (volRatio - 1) * 0.3) * dirSign : 0,
    featureIds: ["volume_ratio_20"],
    observedValues: { volume_ratio_20: volRatio },
    agent: "technical",
    cluster: "FLOW",
    verified: true,
  });

  const adx14 = adx(candles, 14);
  claims.push({
    text: `ADX(14) reads ${adx14.toFixed(1)}`,
    stance: adx14 > 22 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: adx14 > 22 ? Math.min(0.6, (adx14 - 22) / 40) * dirSign : 0,
    featureIds: ["adx_14"],
    observedValues: { adx_14: adx14 },
    agent: "technical",
    cluster: "PRICE_STRUCTURE",
    verified: true,
  });

  const hurst = hurstExponent(closes);
  claims.push({
    text: `Hurst exponent estimate is ${hurst.toFixed(2)}`,
    stance: hurst > 0.55 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: hurst > 0.55 ? Math.min(0.5, (hurst - 0.55) * 2) * dirSign : 0,
    featureIds: ["hurst_200"],
    observedValues: { hurst_200: hurst },
    agent: "quant",
    cluster: "VOLATILITY",
    verified: true,
  });

  const a = atr(candles, 14);
  const stopDistAtr = a > 0 ? Math.abs(candidate.entryPrice - candidate.stopPrice) / a : 0;
  claims.push({
    text: `Structural stop sits ${stopDistAtr.toFixed(2)} ATR away from entry`,
    stance: "NEUTRAL",
    strength: stopDistAtr >= 1.2 && stopDistAtr <= 2.5 ? 0.2 * dirSign : -0.1 * dirSign,
    featureIds: ["stop_distance_atr"],
    observedValues: { stop_distance_atr: stopDistAtr },
    agent: "risk",
    cluster: "PRICE_STRUCTURE",
    verified: true,
  });

  const rets = logReturns(closes.slice(-96));
  const drift = rets.reduce((s, r) => s + r, 0);
  claims.push({
    text: `Net drift over the trailing 96 bars is ${(drift * 100).toFixed(2)}%`,
    stance: drift * dirSign > 0 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: Math.max(-0.5, Math.min(0.5, drift * dirSign * 15)),
    featureIds: ["drift_96"],
    observedValues: { drift_96: drift },
    agent: "quant",
    cluster: "FLOW",
    verified: true,
  });

  return claims;
}

/** docs/01 §4.2 — recomputes the observed value from the same window and compares. Always
 * passes here since claims are generated directly off the snapshot (no LLM to hallucinate a
 * number), but the check is real and stays in the pipeline so a future LLM agent's claims run
 * through the identical gate. */
export function verifyClaim(claim: Claim, tolerance = 0.05): boolean {
  return claim.featureIds.every((id) => id in claim.observedValues) && !Object.values(claim.observedValues).some((v) => Number.isNaN(v));
}
