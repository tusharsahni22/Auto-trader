import type { Candle, Trade, TradeFill } from "../types.js";
import { atr } from "../lib/indicators.js";
import { generateRuleClaims } from "../decision/claims.js";
import { buildEvidenceGraph } from "../decision/evidence.js";
import { buildFeatureSnapshot } from "../decision/snapshot.js";
import { CLUSTER_WEIGHTS } from "../decision/types.js";

/**
 * docs/04 — post-entry management. Implements: thesis decay (§2), a
 * mechanical PRICE/STRUCTURE invalidation (§3 — NEWS/EVENT/DERIVATIVE
 * invalidations need feeds this MVP does not ingest), the scale-out
 * ladder already computed at detection time (§4), breakeven-at-+1.3R
 * (§5.1), an ATR chandelier trail after TP1 (§5.2, one method for all
 * three archetypes rather than the per-archetype table, since the
 * distinction matters less than having a trail at all at this stage),
 * and a hard time stop (§6 — the soft hazard-curve stop needs the
 * analog set this system hasn't accumulated yet).
 */

const BREAKEVEN_TRIGGER_R = 1.3;
const CHANDELIER_ATR_MULT = 2.5;

export interface ManagedResult {
  trade: Trade;
  closed: boolean;
  newFills: TradeFill[];
}

function rMultiple(entry: number, stop: number, price: number, direction: "LONG" | "SHORT"): number {
  const stopDist = Math.abs(entry - stop);
  if (stopDist === 0) return 0;
  const dirSign = direction === "LONG" ? 1 : -1;
  return ((price - entry) * dirSign) / stopDist;
}

export function computeThesisDecay(trade: Trade, candles: Candle[]): number {
  const a = atr(candles, 14);
  if (a === 0 || Object.keys(trade.entryClusterStrengths).length === 0) return 1;
  const pseudoCandidate = {
    archetype: trade.archetype,
    direction: trade.direction,
    asset: trade.asset,
    entryPrice: candles[candles.length - 1].close,
    stopPrice: trade.stopPrice,
    targets: trade.targets,
    maxHoldHours: trade.maxHoldHours,
    structuralReason: "",
    atr: a,
  };
  const snapshot = buildFeatureSnapshot(candles, pseudoCandidate, "RANGE_BOUND");
  const claims = generateRuleClaims(snapshot, pseudoCandidate);
  const evidence = buildEvidenceGraph(claims, snapshot);

  let weightedNow = 0;
  let weightSum = 0;
  for (const cluster of evidence.clusters) {
    const entryStrength = trade.entryClusterStrengths[cluster.cluster];
    if (entryStrength === undefined || entryStrength === 0) continue;
    const ratio = Math.max(0, Math.min(1.2, cluster.effectiveStrength / entryStrength));
    weightedNow += cluster.weight * ratio;
    weightSum += cluster.weight;
  }
  return weightSum > 0 ? weightedNow / weightSum : 1;
}

function applyFill(trade: Trade, price: number, fraction: number, reason: string, time: number): number {
  const qty = trade.initialQuantity * fraction;
  const dirSign = trade.direction === "LONG" ? 1 : -1;
  const pnl = (price - trade.entryPrice) * dirSign * qty;
  trade.fills.push({ time, price, fraction, reason, pnlUsd: pnl });
  trade.realizedPnlUsd += pnl;
  trade.remainingQuantity = Math.max(0, trade.remainingQuantity - qty);
  return pnl;
}

export function finalizeClose(trade: Trade, price: number, reason: string, time: number) {
  if (trade.remainingQuantity > 1e-9) {
    applyFill(trade, price, trade.remainingQuantity / trade.initialQuantity, reason, time);
  }
  trade.status = "CLOSED";
  trade.exitTime = time;
  const totalQty = trade.initialQuantity;
  trade.exitPrice = trade.entryPrice + (trade.realizedPnlUsd / totalQty) * (trade.direction === "LONG" ? 1 : -1);
  trade.pnlUsd = trade.realizedPnlUsd;
  trade.pnlPct = (trade.realizedPnlUsd / (trade.entryPrice * totalQty)) * 100;
  const stopDist = Math.abs(trade.entryPrice - trade.initialStopPrice) * totalQty;
  trade.rMultiple = stopDist > 0 ? trade.realizedPnlUsd / stopDist : 0;
  trade.exitReason = reason;
}

/** Replace the estimated close with the exchange's actual weighted fill and P&L. */
export function applyExchangeClose(trade: Trade, fillPrice: number, exchangePnl?: number, feeUsd = 0) {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return;
  trade.exitPrice = fillPrice;
  if (exchangePnl !== undefined && Number.isFinite(exchangePnl)) {
    trade.realizedPnlUsd = exchangePnl - feeUsd - (trade.execution?.entryFeeUsd ?? 0);
    trade.pnlUsd = trade.realizedPnlUsd;
    trade.pnlPct = (trade.realizedPnlUsd / (trade.entryPrice * trade.initialQuantity)) * 100;
    const stopDist = Math.abs(trade.entryPrice - trade.initialStopPrice) * trade.initialQuantity;
    trade.rMultiple = stopDist > 0 ? trade.realizedPnlUsd / stopDist : 0;
  }
}

export function manageTrade(trade: Trade, candles: Candle[], nowMs: number): ManagedResult {
  const price = candles[candles.length - 1].close;
  const dirSign = trade.direction === "LONG" ? 1 : -1;
  const newFills: TradeFill[] = [];
  const before = trade.fills.length;

  const currentR = rMultiple(trade.entryPrice, trade.initialStopPrice, price, trade.direction);
  trade.maxFavorableExcursionR = Math.max(trade.maxFavorableExcursionR, currentR);
  trade.maxAdverseExcursionR = Math.min(trade.maxAdverseExcursionR, currentR);

  // Mechanical PRICE/STRUCTURE invalidation: stop hit.
  const stopHit = dirSign === 1 ? price <= trade.stopPrice : price >= trade.stopPrice;
  if (stopHit) {
    finalizeClose(trade, trade.stopPrice, "STOP_HIT", nowMs);
    return { trade, closed: true, newFills: trade.fills.slice(before) };
  }

  // Scale-out ladder (docs/04 §4).
  for (const target of trade.targets) {
    if (target.hit) continue;
    const reached = dirSign === 1 ? price >= target.price : price <= target.price;
    if (reached) {
      target.hit = true;
      target.hitTime = nowMs;
      applyFill(trade, target.price, target.fraction, "TARGET_HIT", nowMs);
    }
  }
  if (trade.remainingQuantity <= 1e-9) {
    finalizeClose(trade, price, "TARGET_HIT", nowMs);
    return { trade, closed: true, newFills: trade.fills.slice(before) };
  }

  const tp1 = trade.targets[0];
  const tp1Hit = tp1?.hit ?? false;

  // Breakeven (docs/04 §5.1) and chandelier trail (§5.2), after TP1 only, one-directional.
  if (tp1Hit) {
    const a = atr(candles, 14);
    if (!trade.breakevenMoved) {
      const be = trade.entryPrice;
      trade.stopPrice = dirSign === 1 ? Math.max(trade.stopPrice, be) : Math.min(trade.stopPrice, be);
      trade.breakevenMoved = true;
    }
    if (a > 0) {
      const recentCloses = candles.slice(-20).map((c) => c.close);
      const extreme = dirSign === 1 ? Math.max(...recentCloses) : Math.min(...recentCloses);
      const trail = dirSign === 1 ? extreme - CHANDELIER_ATR_MULT * a : extreme + CHANDELIER_ATR_MULT * a;
      trade.stopPrice = dirSign === 1 ? Math.max(trade.stopPrice, trail) : Math.min(trade.stopPrice, trail);
    }
  }

  // Thesis decay (docs/04 §2).
  trade.thesisDecay = computeThesisDecay(trade, candles);
  if (trade.thesisDecay < 0.3) {
    finalizeClose(trade, price, "THESIS_INVALIDATED", nowMs);
    return { trade, closed: true, newFills: trade.fills.slice(before) };
  }
  if (trade.thesisDecay < 0.6) {
    const tighter = dirSign === 1 ? price - 1.2 * atr(candles, 14) : price + 1.2 * atr(candles, 14);
    trade.stopPrice = dirSign === 1 ? Math.max(trade.stopPrice, tighter) : Math.min(trade.stopPrice, tighter);
  }

  // Hard time stop (docs/04 §6.2).
  if (nowMs - trade.entryTime > trade.maxHoldHours * 3600 * 1000) {
    finalizeClose(trade, price, "TIME_STOP", nowMs);
    return { trade, closed: true, newFills: trade.fills.slice(before) };
  }

  return { trade, closed: false, newFills: trade.fills.slice(before) };
}
