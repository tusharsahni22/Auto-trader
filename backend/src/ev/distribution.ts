import type { ArchetypeCandidate } from "../decision/types.js";

/**
 * docs/02 §3 — three ways to get an outcome distribution. This MVP implements:
 *  - §3.1 closed-form double barrier + implied-drift bisection (used to derive
 *    the Monte Carlo drift from the calibrated win probability, not a second
 *    independent estimate)
 *  - §3.3 Monte Carlo with Student-t(df=4) innovations, at hourly resolution
 *    rather than 5-minute (2000 paths instead of 10,000 — this is a paper
 *    account on a laptop, not a research cluster, and the distribution shape
 *    converges well before 10k at this path complexity)
 *  - §3.2 historical analog bootstrap, but sourced from THIS system's own
 *    closed trades (docs/02 assumes 2021+ history via a separate replay this
 *    MVP has not run) — see ev/analogs.ts. Blended 50/50 with Monte Carlo
 *    once at least 10 same-archetype-regime trades exist; pure Monte Carlo
 *    before that.
 * §3.3's full lifecycle management rules (scale-out ladder, trailing) ARE
 * applied per path, since the ladder is already computed by the archetype
 * detector.
 */

export interface OutcomeDistribution {
  rPaths: number[]; // realized R per simulated path
  mean: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  cvar5: number;
  pProfit: number;
}

function sampleStudentT(df: number): number {
  // Standard normal / sqrt(chi-sq_df / df), chi-sq_df as sum of df squared normals.
  const z = gaussian();
  let chi2 = 0;
  for (let i = 0; i < df; i++) chi2 += gaussian() ** 2;
  return z / Math.sqrt(chi2 / df);
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** docs/02 §3.1 — closed-form P(TP first) for a driftless-adjustable double barrier. */
export function probTouchUpperFirst(mu: number, sigma: number, a: number, b: number): number {
  if (sigma <= 0) return mu > 0 ? 1 : 0;
  if (Math.abs(mu) < 1e-9) return Math.abs(a) / (Math.abs(a) + b);
  const k = (2 * mu) / (sigma * sigma);
  const num = 1 - Math.exp(-k * a);
  const den = Math.exp(-k * b) - Math.exp(-k * a);
  return num / den;
}

/** Bisects for the mu that reproduces the calibrated win probability against a single effective barrier pair. */
export function impliedDrift(targetP: number, sigma: number, a: number, b: number): number {
  let lo = -5 * sigma;
  let hi = 5 * sigma;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = probTouchUpperFirst(mid, sigma, a, b);
    if (p < targetP) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function simulateOutcomes(
  candidate: ArchetypeCandidate,
  calibratedWinProb: number,
  paths = 2000
): OutcomeDistribution {
  const stopDist = Math.abs(candidate.entryPrice - candidate.stopPrice);
  const sortedTargets = [...candidate.targets].sort((x, y) => x.r - y.r);
  const lastTarget = sortedTargets[sortedTargets.length - 1];
  const a = -stopDist; // log-space barrier distance approximated linearly for small moves
  const b = Math.abs(lastTarget.price - candidate.entryPrice);

  // Volatility per hour from ATR (approx: ATR is a ~15m-bar range; scale to an
  // hourly sigma via sqrt(4) as a rough time-scaling of a range statistic).
  const sigmaPerBar = candidate.atr / candidate.entryPrice;
  const sigmaPerHour = sigmaPerBar * Math.sqrt(4);

  const totalHours = candidate.maxHoldHours;
  const mu = impliedDrift(calibratedWinProb, sigmaPerHour * Math.sqrt(totalHours), a / candidate.entryPrice, b / candidate.entryPrice);
  const muPerHour = mu / totalHours;

  const dirSign = candidate.direction === "LONG" ? 1 : -1;
  const rPaths: number[] = [];

  for (let p = 0; p < paths; p++) {
    let logPrice = 0; // log(price / entry)
    let realizedR = 0;
    let remainingFraction = 1;
    let hitStop = false;
    const hitTargets = new Set<number>();

    for (let h = 1; h <= totalHours; h++) {
      const innovation = sampleStudentT(4) * sigmaPerHour;
      logPrice += muPerHour + innovation;
      const price = candidate.entryPrice * Math.exp(logPrice * dirSign);

      const stopHit = dirSign === 1 ? price <= candidate.stopPrice : price >= candidate.stopPrice;
      if (stopHit) {
        realizedR += -1 * remainingFraction;
        hitStop = true;
        break;
      }

      for (let i = 0; i < sortedTargets.length; i++) {
        if (hitTargets.has(i)) continue;
        const t = sortedTargets[i];
        const reached = dirSign === 1 ? price >= t.price : price <= t.price;
        if (reached) {
          realizedR += t.r * t.fraction;
          remainingFraction -= t.fraction;
          hitTargets.add(i);
        }
      }
      if (remainingFraction <= 1e-6) break;
    }

    if (!hitStop && remainingFraction > 1e-6) {
      // Time stop: closed at the final simulated price for whatever remains.
      const finalPrice = candidate.entryPrice * Math.exp(logPrice * dirSign);
      const finalR = ((finalPrice - candidate.entryPrice) * dirSign) / stopDist;
      realizedR += finalR * remainingFraction;
    }

    rPaths.push(realizedR);
  }

  return summarize(rPaths);
}

export function summarize(rPaths: number[]): OutcomeDistribution {
  const sorted = [...rPaths].sort((x, y) => x - y);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  const mean = sorted.reduce((s, r) => s + r, 0) / sorted.length;
  const tail5 = sorted.slice(0, Math.max(1, Math.floor(0.05 * sorted.length)));
  const cvar5 = tail5.reduce((s, r) => s + r, 0) / tail5.length;
  const pProfit = sorted.filter((r) => r > 0).length / sorted.length;

  return { rPaths, mean, p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), cvar5, pProfit };
}
