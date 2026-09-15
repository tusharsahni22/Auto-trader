import type { ArchetypeCandidate, Claim } from "./types.js";
import type { FeatureSnapshot } from "./snapshot.js";

/**
 * docs/01 §4.1 — the free, always-on "rules" agent. Deterministic claims
 * computed straight from the verified feature snapshot rather than a model
 * call — this is what runs even with every paid/free LLM agent disabled
 * (docs/03 §5's PROVIDER_OUTAGE philosophy: the deterministic core works
 * with zero AI). See agents/ for the LLM-backed providers that supplement
 * this with real research when enabled.
 */

export function generateRuleClaims(snapshot: FeatureSnapshot, candidate: ArchetypeCandidate): Claim[] {
  const v = snapshot.values;
  const dirSign = candidate.direction === "LONG" ? 1 : -1;
  const claims: Claim[] = [];

  claims.push({
    text: `Realized vol sits at the ${(v.rv_30d_rank * 100).toFixed(0)}th percentile of its trailing window`,
    stance: v.rv_30d_rank < 0.3 ? "BULLISH" : v.rv_30d_rank > 0.7 ? "BEARISH" : "NEUTRAL",
    strength: v.rv_30d_rank < 0.3 ? 0.5 : v.rv_30d_rank > 0.7 ? -0.3 : 0.1,
    featureIds: ["rv_30d_rank"],
    observedValues: { rv_30d_rank: v.rv_30d_rank },
    agent: "rules:quant",
    cluster: "VOLATILITY",
    verified: true,
  });

  claims.push({
    text: `Bollinger bandwidth is ${(v.bollinger_bandwidth * 100).toFixed(2)}% of price`,
    stance: v.bollinger_bandwidth < 0.03 ? "BULLISH" : "NEUTRAL",
    strength: v.bollinger_bandwidth < 0.03 ? 0.4 * dirSign : 0,
    featureIds: ["bollinger_bandwidth"],
    observedValues: { bollinger_bandwidth: v.bollinger_bandwidth },
    agent: "rules:technical",
    cluster: "PRICE_STRUCTURE",
    verified: true,
  });

  claims.push({
    text: `Latest bar volume is ${v.volume_ratio_20.toFixed(2)}x the trailing 19-bar average`,
    stance: v.volume_ratio_20 > 1.5 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: v.volume_ratio_20 > 1.5 ? Math.min(0.7, (v.volume_ratio_20 - 1) * 0.3) * dirSign : 0,
    featureIds: ["volume_ratio_20"],
    observedValues: { volume_ratio_20: v.volume_ratio_20 },
    agent: "rules:technical",
    cluster: "FLOW",
    verified: true,
  });

  claims.push({
    text: `ADX(14) reads ${v.adx_14.toFixed(1)}`,
    stance: v.adx_14 > 22 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: v.adx_14 > 22 ? Math.min(0.6, (v.adx_14 - 22) / 40) * dirSign : 0,
    featureIds: ["adx_14"],
    observedValues: { adx_14: v.adx_14 },
    agent: "rules:technical",
    cluster: "PRICE_STRUCTURE",
    verified: true,
  });

  claims.push({
    text: `Hurst exponent estimate is ${v.hurst_200.toFixed(2)}`,
    stance: v.hurst_200 > 0.55 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: v.hurst_200 > 0.55 ? Math.min(0.5, (v.hurst_200 - 0.55) * 2) * dirSign : 0,
    featureIds: ["hurst_200"],
    observedValues: { hurst_200: v.hurst_200 },
    agent: "rules:quant",
    cluster: "VOLATILITY",
    verified: true,
  });

  claims.push({
    text: `Structural stop sits ${v.stop_distance_atr.toFixed(2)} ATR away from entry`,
    stance: "NEUTRAL",
    strength: v.stop_distance_atr >= 1.2 && v.stop_distance_atr <= 2.5 ? 0.2 * dirSign : -0.1 * dirSign,
    featureIds: ["stop_distance_atr"],
    observedValues: { stop_distance_atr: v.stop_distance_atr },
    agent: "rules:risk",
    cluster: "PRICE_STRUCTURE",
    verified: true,
  });

  claims.push({
    text: `Net drift over the trailing 96 bars is ${(v.drift_96 * 100).toFixed(2)}%`,
    stance: v.drift_96 * dirSign > 0 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
    strength: Math.max(-0.5, Math.min(0.5, v.drift_96 * dirSign * 15)),
    featureIds: ["drift_96"],
    observedValues: { drift_96: v.drift_96 },
    agent: "rules:quant",
    cluster: "FLOW",
    verified: true,
  });

  if (Math.abs(v.news_sentiment_score) > 0.05) {
    claims.push({
      text: `Keyword-scored headline sentiment is ${v.news_sentiment_score > 0 ? "net bullish" : "net bearish"} (${v.news_sentiment_score.toFixed(2)})`,
      stance: v.news_sentiment_score * dirSign > 0 ? (candidate.direction === "LONG" ? "BULLISH" : "BEARISH") : "NEUTRAL",
      strength: Math.max(-0.5, Math.min(0.5, v.news_sentiment_score * dirSign)),
      featureIds: ["news_sentiment_score"],
      observedValues: { news_sentiment_score: v.news_sentiment_score },
      agent: "rules:news",
      cluster: "NEWS",
      verified: true,
    });
  }

  if (v.hours_to_next_tier1_event < 24) {
    claims.push({
      text: `A tier-1 macro event is ${v.hours_to_next_tier1_event.toFixed(1)}h away`,
      stance: "NEUTRAL",
      strength: 0,
      featureIds: ["hours_to_next_tier1_event"],
      observedValues: { hours_to_next_tier1_event: v.hours_to_next_tier1_event },
      agent: "rules:event",
      cluster: "EVENT",
      verified: true,
    });
  }

  return claims;
}

/**
 * docs/01 §4.2 — citation verification against the canonical snapshot, not
 * just internal self-consistency. This is what makes the check meaningful
 * once LLM-backed agents (agents/) are enabled: a model that invents a
 * number, or cites a featureId that doesn't exist in the snapshot, gets
 * its claim dropped here — logged to droppedClaims by evidence.ts.
 */
export function verifyClaim(claim: Claim, snapshot: FeatureSnapshot, tolerance = 0.05): { ok: true } | { ok: false; reason: "MISSING_FEATURE" | "CITATION_MISMATCH"; claimedValue?: number; actualValue?: number } {
  for (const id of claim.featureIds) {
    if (!(id in snapshot.values)) return { ok: false, reason: "MISSING_FEATURE" };
    const claimed = claim.observedValues[id];
    if (claimed === undefined || Number.isNaN(claimed)) return { ok: false, reason: "MISSING_FEATURE" };
    const actual = snapshot.values[id];
    const denom = Math.max(Math.abs(actual), 1e-6);
    if (Math.abs(claimed - actual) / denom > tolerance) {
      return { ok: false, reason: "CITATION_MISMATCH", claimedValue: claimed, actualValue: actual };
    }
  }
  return { ok: true };
}
