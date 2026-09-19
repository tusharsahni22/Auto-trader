import type { Asset, Trade } from "../types.js";

/**
 * docs/03 §3-5 — correlation-adjusted portfolio heat, correlation stacking,
 * and a reduced circuit-breaker set. BTC/ETH correlation is taken as a
 * config constant (0.85, floored per §3.1) rather than an EWMA fit, since
 * that needs a return-series history this MVP is still accumulating.
 */

const BTC_ETH_CORRELATION = 0.85;
const MAX_PORTFOLIO_HEAT = 0.015; // 1.5% of equity, docs/03 §2.2
const CORRELATION_STACK_HEAT_LIMIT = 0.01;

export interface OpenRisk {
  asset: Asset;
  direction: "LONG" | "SHORT";
  riskPctOfEquity: number; // current, i.e. distance-to-stop based, not entry-based
}

function correlationBetween(a: Asset, b: Asset): number {
  if (a === b) return 1;
  return BTC_ETH_CORRELATION;
}

function signedWeight(r: OpenRisk): number {
  return r.direction === "LONG" ? r.riskPctOfEquity : -r.riskPctOfEquity;
}

/** docs/03 §3.1 — heat = sqrt(wᵀCw) over signed per-asset directional risk. */
export function computeHeat(openRisks: OpenRisk[]): { heat: number; nEff: number } {
  if (openRisks.length === 0) return { heat: 0, nEff: 0 };
  let wCw = 0;
  for (const ri of openRisks) {
    for (const rj of openRisks) {
      const wi = signedWeight(ri);
      const wj = signedWeight(rj);
      wCw += wi * wj * correlationBetween(ri.asset, rj.asset);
    }
  }
  const sumW = openRisks.reduce((s, r) => s + signedWeight(r), 0);
  const heat = Math.sqrt(Math.max(0, wCw));
  const nEff = wCw > 0 ? (sumW * sumW) / wCw : 0;
  return { heat, nEff };
}

export function openRiskFromTrade(t: Trade, currentPrice: number, equity: number): OpenRisk {
  const dirSign = t.direction === "LONG" ? 1 : -1;
  const distanceToStop = Math.max(0, (currentPrice - t.stopPrice) * dirSign);
  const riskUsd = distanceToStop * t.remainingQuantity;
  // FIX: Store as a true fraction of equity (0.005 = 0.5%), not raw USD.
  // The prior code stored raw USD here then divided by equity again inside
  // heatBudget, causing double-normalization and meaningless heat values.
  return { asset: t.asset, direction: t.direction, riskPctOfEquity: equity > 0 ? riskUsd / equity : 0 };
}

/** Returns the max additional risk-% the candidate can take without breaching MAX_PORTFOLIO_HEAT, or 0 if it must be vetoed. */
export function heatBudget(existing: OpenRisk[], candidateAsset: Asset, candidateDirection: "LONG" | "SHORT", equity: number): number {
  // FIX: existing already holds true fractions of equity — no further normalization needed.
  let lo = 0;
  let hi = MAX_PORTFOLIO_HEAT;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const { heat } = computeHeat([...existing, { asset: candidateAsset, direction: candidateDirection, riskPctOfEquity: mid }]);
    if (heat > MAX_PORTFOLIO_HEAT) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** docs/03 §4 — correlation stacking veto: same-direction correlated exposure already open, and adding more would push heat past 1.0%. */
export function correlationStackVeto(existing: OpenRisk[], candidateAsset: Asset, candidateDirection: "LONG" | "SHORT", equity: number): boolean {
  const hasCorrelatedSameDirection = existing.some(
    (r) => correlationBetween(r.asset, candidateAsset) > 0.75 && r.direction === candidateDirection && r.asset !== candidateAsset
  );
  if (!hasCorrelatedSameDirection) return false;
  const probeRisk = 0.005; // probe with 0.5% to see if adding this would breach heat
  const { heat } = computeHeat([...existing, { asset: candidateAsset, direction: candidateDirection, riskPctOfEquity: probeRisk }]);
  return heat > CORRELATION_STACK_HEAT_LIMIT;
}

export interface CircuitBreakerState {
  dailyLossTripped: boolean;
  consecutiveLosses: number;
  drawdownTripped: boolean;
}

/** docs/03 §5 — a reduced set: DAILY_LOSS, CONSECUTIVE_LOSSES, DRAWDOWN. The rest need feeds (news, cross-exchange, exchange errors) this MVP does not ingest. */
export function evaluateCircuitBreakers(
  equity: number,
  equityAtDayStart: number,
  equityPeak: number,
  recentTrades: Trade[]
): CircuitBreakerState {
  const dailyLossTripped = equity <= equityAtDayStart * (1 - 0.02);
  const drawdownTripped = equity <= equityPeak * (1 - 0.1);

  let consecutiveLosses = 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  
  for (let i = 0; i < recentTrades.length; i++) {
    const t = recentTrades[i];
    if (t.status !== "CLOSED" || t.rMultiple === null) break;
    // Do not count losses older than 24h to prevent permanent deadlocks
    if (t.exitTime && now - t.exitTime > oneDayMs) break;
    
    if (t.rMultiple < 0) consecutiveLosses++;
    else break;
  }

  return { dailyLossTripped, consecutiveLosses, drawdownTripped };
}

export { MAX_PORTFOLIO_HEAT };
