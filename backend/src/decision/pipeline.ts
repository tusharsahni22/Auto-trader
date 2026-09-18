import type { Candle } from "../types.js";
import { classifyRegime } from "./regime.js";
import { detectArchetypes } from "./archetypes.js";
import { generateRuleClaims } from "./claims.js";
import { buildEvidenceGraph } from "./evidence.js";
import { buildFeatureSnapshot } from "./snapshot.js";
import { aggregate } from "./ensemble.js";
import { calibrate } from "./calibration.js";
import { evaluateGates, type GateContext } from "./gates.js";
import { computeExpectedValue } from "../ev/index.js";
import { computeSizing } from "../ev/sizing.js";
import { getFundingRate, getMarketFeedHealth } from "../marketData.js";
import { getPlattFittedAt } from "../learning/stats.js";
import type { OpenRisk } from "../risk/portfolio.js";
import type { ArchetypeCandidate, EvidenceGraph, RegimeSnapshot } from "./types.js";

/**
 * docs/01 §1 — the strictly ordered pipeline: features -> regime ->
 * archetype -> claims -> evidence graph -> aggregation -> calibration ->
 * gates. This module is the orchestrator; every stage it calls lives in
 * its own file with the specific simplifications noted there.
 */

const MIN_RISK_PER_TRADE = 0.001; // mirrors ev/sizing.ts's floor

export interface PipelineOutput {
  decision: "OPEN" | "WATCH" | "VETO" | "NONE";
  asset: string;
  regime: RegimeSnapshot;
  candidate?: ArchetypeCandidate;
  evidence?: EvidenceGraph;
  rawScore?: number;
  calibratedWinProb?: number;
  calibratedWinProbCI90?: [number, number];
  calibrationStage?: string;
  evNetR?: number;
  evNetUsd?: number;
  costBreakdown?: { feesR: number; slippageR: number; fundingR: number; totalR: number };
  distributionR?: { p5: number; p25: number; p50: number; p75: number; p95: number };
  sizing?: ReturnType<typeof computeSizing>;
  vetoReasons: string[];
  entryClusterStrengths?: Record<string, number>;
}

export interface ScoreOptions {
  /** Skips G1-G12 entirely and forces a minimum-viable size — used only by the manual "force trade" debug/demo path, never by the live scanning loop. */
  bypassGatesAndForceSize?: boolean;
}

/** Everything downstream of "we have a candidate": claims -> evidence -> ensemble -> calibration -> EV -> gates -> sizing. */
export function scoreCandidate(
  asset: string,
  candles: Candle[],
  candidate: ArchetypeCandidate,
  regime: RegimeSnapshot,
  equity: number,
  existingOpenRisk: OpenRisk[],
  circuitBreakerTripped: boolean,
  nowMs: number,
  options: ScoreOptions = {}
): PipelineOutput {
  const snapshot = buildFeatureSnapshot(candles, candidate, regime.label);
  const claims = generateRuleClaims(snapshot, candidate);
  const evidence = buildEvidenceGraph(claims, snapshot);
  const ensemble = aggregate(candidate.archetype, regime.label, evidence);
  const calibration = calibrate(ensemble.rawScore, ensemble.priorWinRate, ensemble.priorN);

  const feed = getMarketFeedHealth(asset as "BTCUSDT" | "ETHUSDT");
  const fundingRate = getFundingRate(asset as "BTCUSDT" | "ETHUSDT");
  const liveExecution = process.env.LIVE_TRADING === "true";
  const dataConfidence = !feed.fresh ? 0 : feed.source === "delta" ? 0.98 : 0.65;
  const nominalRiskUsd = equity * 0.005;
  const { ev, distribution, modelDisagreement } = computeExpectedValue(candidate, calibration.calibratedWinProb, fundingRate, nominalRiskUsd);

  const fittedAt = getPlattFittedAt();
  const calibrationVintageDays = fittedAt ? (nowMs - fittedAt) / (1000 * 60 * 60 * 24) : 0;

  const gateCtx: GateContext = {
    candidate,
    regime,
    evidence,
    calibration,
    ev,
    dataConfidence,
    calibrationVintageDays,
    existingOpenRisk,
    equity,
    circuitBreakerTripped,
  };
  const gates = options.bypassGatesAndForceSize
    ? { passed: true, downgradeToWatch: false, reasons: ["MANUAL_FORCE_OPEN_BYPASSED_GATES"], heatBudgetPct: 0.005 }
    : evaluateGates(gateCtx);

  const entryClusterStrengths = Object.fromEntries(evidence.clusters.map((c) => [c.cluster, c.effectiveStrength]));

  const base: PipelineOutput = {
    decision: "VETO",
    asset,
    regime,
    candidate,
    evidence,
    rawScore: ensemble.rawScore,
    calibratedWinProb: calibration.calibratedWinProb,
    calibratedWinProbCI90: calibration.calibratedWinProbCI90,
    calibrationStage: calibration.stage,
    evNetR: ev.netR,
    evNetUsd: ev.netUSD,
    costBreakdown: ev.costBreakdown,
    distributionR: ev.distributionR,
    vetoReasons: gates.reasons,
    entryClusterStrengths,
  };

  if (liveExecution && feed.source !== "delta") {
    return { ...base, decision: "VETO", vetoReasons: ["DELTA_FEED_REQUIRED", `FEED_SOURCE_${feed.source.toUpperCase()}`] };
  }
  if (!feed.fresh) {
    return { ...base, decision: "VETO", vetoReasons: ["DATA_STALE"] };
  }
  const maxFundingRate = Number(process.env.MAX_ENTRY_FUNDING_RATE ?? 0.003);
  if (Math.abs(fundingRate) >= maxFundingRate) {
    return { ...base, decision: "VETO", vetoReasons: [`EXTREME_FUNDING_${fundingRate.toFixed(6)}`] };
  }
  const hoursToEvent = snapshot.values.hours_to_next_tier1_event;
  const blackoutHours = Number(process.env.NEWS_BLACKOUT_HOURS ?? 0.25);
  if (Number.isFinite(hoursToEvent) && hoursToEvent >= 0 && hoursToEvent <= blackoutHours) {
    return { ...base, decision: "VETO", vetoReasons: ["EVENT_BLACKOUT"] };
  }

  if (!gates.passed) {
    return { ...base, decision: gates.downgradeToWatch ? "WATCH" : "VETO" };
  }

  const sizing = computeSizing({
    rPaths: distribution.rPaths,
    calibratedWinProb: calibration.calibratedWinProb,
    calibratedWinProbCI90: calibration.calibratedWinProbCI90,
    equity,
    entryPrice: candidate.entryPrice,
    stopPrice: candidate.stopPrice,
    dataConfidence,
    calibrationVintageDays,
    cellN: calibration.n,
    regimeConfidence: regime.confidence,
    modelDisagreement,
    heatRemainingPct: gates.heatBudgetPct,
  });

  if (sizing.riskPctOfEquity <= 0) {
    if (!options.bypassGatesAndForceSize) {
      return { ...base, decision: "VETO", vetoReasons: [...gates.reasons, "MIN_RISK_NOT_MET"] };
    }
    // Forced path: the honest sizing math said "don't take this" (thin/negative
    // edge, or a constraint binding at zero) — override with the floor size
    // rather than silently producing a 0-quantity "open" trade.
    const floorRisk = MIN_RISK_PER_TRADE;
    const stopDistPct = Math.abs(candidate.entryPrice - candidate.stopPrice) / candidate.entryPrice;
    sizing.riskPctOfEquity = floorRisk;
    sizing.quantity = (equity * floorRisk) / (candidate.entryPrice * stopDistPct);
    sizing.notionalUSD = sizing.quantity * candidate.entryPrice;
    sizing.bindingConstraint = "MANUAL_FORCE_FLOOR";
    sizing.haircuts = [...sizing.haircuts, "FORCED_MIN_SIZE"];
  }

  return { ...base, decision: "OPEN", sizing, evNetUsd: ev.netR * sizing.riskPctOfEquity * equity };
}

export function runPipeline(
  asset: string,
  candles: Candle[],
  equity: number,
  existingOpenRisk: OpenRisk[],
  circuitBreakerTripped: boolean,
  nowMs: number
): PipelineOutput {
  const regime = classifyRegime(asset, candles, nowMs);
  const candidates = detectArchetypes(asset, candles, regime.label);

  if (candidates.length === 0) {
    return { decision: "NONE", asset, regime, vetoReasons: [] };
  }

  // Score every candidate and select the best risk-adjusted net EV. Detector
  // order is not a trading priority and must never decide which setup wins.
  const scored = candidates.map((candidate) =>
    scoreCandidate(asset, candles, candidate, regime, equity, existingOpenRisk, circuitBreakerTripped, nowMs)
  );
  const viable = scored.filter((out) => out.decision === "OPEN");
  if (viable.length > 0) {
    return viable.sort((a, b) => (b.evNetR ?? -Infinity) - (a.evNetR ?? -Infinity))[0];
  }
  return scored.sort((a, b) => (b.evNetR ?? -Infinity) - (a.evNetR ?? -Infinity))[0];
}
