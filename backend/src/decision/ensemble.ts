import { ARCHETYPE_REGIME_MATRIX, type Archetype, type EvidenceGraph, type Regime } from "./types.js";
import { getArchetypeRegimeStats } from "../learning/stats.js";

const KAPPA = 1.0; // docs/01 §5.1 — scale constant; would be fitted during calibration once enough data exists.

function logit(p: number): number {
  const clamped = Math.min(0.999, Math.max(0.001, p));
  return Math.log(clamped / (1 - clamped));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export interface EnsembleResult {
  logOdds: number;
  rawScore: number; // sigmoid(logOdds), uncalibrated
  priorWinRate: number;
  priorN: number;
}

export function aggregate(archetype: Archetype, regime: Regime, evidence: EvidenceGraph): EnsembleResult {
  const cell = ARCHETYPE_REGIME_MATRIX[archetype][regime];
  const stats = getArchetypeRegimeStats(archetype, regime);
  // Cold start: no ledger data yet for this cell → assume a coin-flip prior,
  // which is the honest "we don't know" starting point docs/01 §8 asks for.
  const priorWinRate = stats && stats.n > 0 ? stats.winRate : 0.5;
  const priorN = stats?.n ?? 0;

  const lPrior = cell === "VETO" ? logit(0.05) : logit(priorWinRate);

  const N = evidence.clusters.length;
  const contributions = evidence.clusters.map((c) => c.weight * c.effectiveStrength * KAPPA);
  const nEff = evidence.nEffectiveSignals;
  const shrink = N > 0 ? nEff / N : 0;
  const sumSigned = contributions.reduce((s, l) => s + l, 0);

  const logOdds = lPrior + shrink * sumSigned;

  return { logOdds, rawScore: sigmoid(logOdds), priorWinRate, priorN };
}
