import type { Sizing } from "../decision/types.js";

/**
 * docs/02 §7 — Kelly on the simulated outcome distribution, Bayesian
 * haircut via posterior resampling, then the constraint stack. Golden-
 * section search is overkill at this precision; a coarse grid search over
 * f is numerically identical for a hurdle this shaped and far simpler to
 * verify by hand.
 */

function expectedLogGrowth(f: number, rPaths: number[]): number {
  let sum = 0;
  for (const r of rPaths) {
    const wealth = 1 + f * r;
    if (wealth <= 0) return -Infinity;
    sum += Math.log(wealth);
  }
  return sum / rPaths.length;
}

function argmaxKelly(rPaths: number[]): number {
  let best = 0;
  let bestVal = -Infinity;
  for (let f = 0.005; f <= 0.5; f += 0.005) {
    const val = expectedLogGrowth(f, rPaths);
    if (val > bestVal) {
      bestVal = val;
      best = f;
    }
  }
  return best;
}

export interface SizingInputs {
  rPaths: number[];
  calibratedWinProb: number;
  calibratedWinProbCI90: [number, number];
  equity: number;
  entryPrice: number;
  stopPrice: number;
  dataConfidence: number;
  calibrationVintageDays: number;
  cellN: number;
  regimeConfidence: number;
  modelDisagreement: boolean;
  heatRemainingPct: number; // portfolio budget left, docs/03 §3
}

const MAX_RISK_PER_TRADE = 0.005; // 0.50% of equity, docs/03 §2.1
const MIN_RISK_PER_TRADE = 0.001; // 0.10%
const TARGET_DAILY_VOL_CONTRIBUTION = 0.0035; // docs/02 §7.5

export function computeSizing(inputs: SizingInputs): Sizing {
  // docs/02 §7.2 — Bayesian haircut: resample p from its posterior, recompute
  // Kelly at each draw, take the 25th percentile of the resulting f* values.
  const [ciLow, ciHigh] = inputs.calibratedWinProbCI90;
  const sd = (ciHigh - ciLow) / (2 * 1.645);
  const draws: number[] = [];
  for (let i = 0; i < 300; i++) {
    const z = gaussianSample();
    const pDraw = Math.min(0.99, Math.max(0.01, inputs.calibratedWinProb + z * sd));
    // Shift the realized-R sample mean toward pDraw by nudging every path's sign-weighted
    // outcome proportionally — an approximation to "recompute the distribution at p_s"
    // that avoids re-running the simulator 300x per opportunity.
    const shift = pDraw - inputs.calibratedWinProb;
    const shiftedPaths = inputs.rPaths.map((r) => r + shift * Math.abs(r));
    draws.push(argmaxKelly(shiftedPaths));
  }
  draws.sort((a, b) => a - b);
  const kellyFraction = draws[Math.floor(draws.length * 0.25)];
  let appliedFraction = 0.25 * kellyFraction; // quarter-Kelly, docs/02 §7.3

  const haircuts: string[] = [];
  if (inputs.modelDisagreement) {
    appliedFraction *= 0.6;
    haircuts.push("MODEL_DISAGREEMENT");
  }
  if (inputs.dataConfidence < 1.0) {
    appliedFraction *= inputs.dataConfidence;
    haircuts.push(`DATA_CONFIDENCE_${inputs.dataConfidence.toFixed(2)}`);
  }
  if (inputs.calibrationVintageDays > 45) {
    appliedFraction *= 0.5;
    haircuts.push("STALE_CALIBRATION");
  }
  if (inputs.cellN < 20) {
    appliedFraction *= 0.5;
    haircuts.push("LOW_SAMPLE_CELL");
  }
  if (inputs.regimeConfidence < 0.6) {
    appliedFraction *= 0.7;
    haircuts.push("LOW_REGIME_CONFIDENCE");
  }

  const stopDistPct = Math.abs(inputs.entryPrice - inputs.stopPrice) / inputs.entryPrice;
  const volTargetCap = stopDistPct > 0 ? TARGET_DAILY_VOL_CONTRIBUTION / stopDistPct : MAX_RISK_PER_TRADE;

  const constraints: [string, number][] = [
    ["MAX_RISK_PER_TRADE", MAX_RISK_PER_TRADE],
    ["KELLY", appliedFraction],
    ["VOL_TARGET", volTargetCap],
    ["PORTFOLIO_HEAT", inputs.heatRemainingPct],
  ];
  let bindingConstraint = constraints[0][0];
  let riskPct = Infinity;
  for (const [name, value] of constraints) {
    if (value < riskPct) {
      riskPct = value;
      bindingConstraint = name;
    }
  }
  riskPct = Math.max(0, riskPct);

  const riskUsd = inputs.equity * riskPct;
  const quantity = stopDistPct > 0 ? riskUsd / (inputs.entryPrice * stopDistPct) : 0;
  const notionalUSD = quantity * inputs.entryPrice;

  return {
    kellyFraction,
    appliedFraction,
    riskPctOfEquity: riskPct < MIN_RISK_PER_TRADE ? 0 : riskPct,
    notionalUSD,
    quantity,
    bindingConstraint,
    haircuts,
  };
}

function gaussianSample(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
