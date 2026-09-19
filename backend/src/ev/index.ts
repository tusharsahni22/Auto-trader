import type { ArchetypeCandidate, ExpectedValue } from "../decision/types.js";
import { estimateCosts } from "./costs.js";
import { simulateOutcomes, summarize, type OutcomeDistribution } from "./distribution.js";
import { getClosedTradeRMultiples } from "../learning/stats.js";

/** docs/02 §6 — expected value, net of costs, plus the full distribution the UI shows. */
export function computeExpectedValue(
  candidate: ArchetypeCandidate,
  calibratedWinProb: number,
  fundingRatePer8h: number,
  riskUsd: number
): { ev: ExpectedValue; distribution: OutcomeDistribution; modelDisagreement: boolean } {
  const stopDistPct = Math.abs(candidate.entryPrice - candidate.stopPrice) / candidate.entryPrice;
  // FIX: Use 35% of maxHoldHours as the expected hold duration instead of 50%.
  // Most trades resolve at targets or stops well before the hard time-stop, so
  // 50% was overstating funding costs and causing the G6 EV gate to veto
  // genuinely profitable setups.
  const costs = estimateCosts(stopDistPct, candidate.maxHoldHours * 0.35, fundingRatePer8h, candidate.direction);

  const monteCarlo = simulateOutcomes(candidate, calibratedWinProb);

  // docs/02 §3.2 — bootstrap from historical analogs. This MVP has no 2021+
  // replay, so "analogs" means this system's own closed trades in the same
  // archetype; blended 50/50 with Monte Carlo once there are >= 10 of them.
  const ledgerRs = getClosedTradeRMultiples(candidate.archetype);
  let distribution = monteCarlo;
  let modelDisagreement = false;
  if (ledgerRs.length >= 10) {
    const bootstrapSample: number[] = [];
    for (let i = 0; i < 1000; i++) bootstrapSample.push(ledgerRs[Math.floor(Math.random() * ledgerRs.length)]);
    const bootstrap = summarize(bootstrapSample);
    modelDisagreement = Math.abs(bootstrap.mean - monteCarlo.mean) > 0.3;
    const blendedPaths = [...monteCarlo.rPaths.slice(0, 1000), ...bootstrapSample];
    distribution = summarize(blendedPaths);
  }

  const grossR = distribution.mean;
  const netR = grossR - costs.totalR;
  const b = candidate.targets[candidate.targets.length - 1]?.r ?? 2;
  const breakevenP = (1 + costs.totalR) / (1 + b);

  const ev: ExpectedValue = {
    grossR,
    costR: costs.totalR,
    netR,
    netUSD: netR * riskUsd,
    pProfit: distribution.pProfit,
    breakevenP,
    distributionR: { p5: distribution.p5, p25: distribution.p25, p50: distribution.p50, p75: distribution.p75, p95: distribution.p95 },
    cvar5R: distribution.cvar5,
    expectedHoldHours: candidate.maxHoldHours / 2,
    costBreakdown: costs,
  };

  return { ev, distribution, modelDisagreement };
}
