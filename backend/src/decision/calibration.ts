import type { CalibrationResult } from "./types.js";
import { getPlattParams, setPlattParams } from "../learning/stats.js";
import { loadOutcomes } from "../learning/outcomeLog.js";
import { sigmoid } from "./ensemble.js";

/**
 * docs/01 §6 — calibration by sample size. This MVP implements Stage A
 * (uncalibrated) and Stage C (Platt scaling); isotonic regression (n >= 300)
 * is not implemented since a fresh paper account will not see 300 closed
 * trades for a long time — the stage will simply never advance past Platt
 * until it does, which is the honest behaviour the doc asks for rather
 * than a fake upgrade.
 */

function logit(p: number): number {
  const c = Math.min(0.999, Math.max(0.001, p));
  return Math.log(c / (1 - c));
}

/** Fits p = sigmoid(a*logit(rawScore) + b) by gradient descent (MLE on log-loss). */
export function fitPlatt(samples: { rawScore: number; win: boolean }[]): { a: number; b: number } {
  let a = 1;
  let b = 0;
  const lr = 0.05;
  const xs = samples.map((s) => logit(s.rawScore));
  const ys = samples.map((s) => (s.win ? 1 : 0));
  for (let iter = 0; iter < 500; iter++) {
    let gradA = 0;
    let gradB = 0;
    for (let i = 0; i < xs.length; i++) {
      const pred = sigmoid(a * xs[i] + b);
      const err = pred - ys[i];
      gradA += err * xs[i];
      gradB += err;
    }
    gradA /= xs.length;
    gradB /= xs.length;
    a -= lr * gradA;
    b -= lr * gradB;
  }
  return { a, b };
}

export function refitCalibration() {
  const samples = loadOutcomes();
  if (samples.length < 50) return;
  const { a, b } = fitPlatt(samples);
  setPlattParams(a, b, samples.length);
}

/** Beta(k+0.5, n-k+0.5) posterior mean and an approximate 90% CI via a normal approximation. */
// Prior strength: a small cell (e.g. 2 wins from 2 trades) is pulled toward 50% instead of jumping to 83%.
const PRIOR_STRENGTH = 20;

function betaPosterior(wins: number, n: number): { mean: number; ci90: [number, number] } {
  const alpha = wins + PRIOR_STRENGTH / 2;
  const beta = n - wins + PRIOR_STRENGTH / 2;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  const z = 1.645;
  return { mean, ci90: [Math.max(0, mean - z * sd), Math.min(1, mean + z * sd)] };
}

export function calibrate(rawScore: number, priorWinRate: number, priorN: number): CalibrationResult {
  const platt = getPlattParams();

  if (!platt || platt.n < 50) {
    // Stage A/B — no calibration fit yet. Use the archetype/regime base rate
    // (or a flat 50% with zero samples) and a wide CI, per docs/01 §8 Stage A/B.
    const wins = Math.round(priorWinRate * priorN);
    const { mean, ci90 } = priorN > 0 ? betaPosterior(wins, priorN) : { mean: 0.5, ci90: [0.15, 0.85] as [number, number] };
    return {
      stage: priorN > 0 ? "B_COLD_START" : "A_UNCALIBRATED",
      rawScore,
      calibratedWinProb: mean,
      calibratedWinProbCI90: ci90,
      n: priorN,
      wins,
    };
  }

  const l = logit(rawScore);
  const p = sigmoid(platt.a * l + platt.b);
  const wins = Math.round(p * platt.n);
  const { ci90 } = betaPosterior(wins, platt.n);
  return {
    stage: "C_PLATT",
    rawScore,
    calibratedWinProb: p,
    calibratedWinProbCI90: ci90,
    n: platt.n,
    wins,
  };
}
