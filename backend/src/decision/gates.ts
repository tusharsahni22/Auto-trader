import { ARCHETYPE_REGIME_MATRIX, type ArchetypeCandidate, type CalibrationResult, type EvidenceGraph, type ExpectedValue, type RegimeSnapshot } from "./types.js";
import type { Asset } from "../types.js";
import { correlationStackVeto, heatBudget, type OpenRisk } from "../risk/portfolio.js";

/**
 * docs/01 §7 — hard gates, evaluated in order, first failure wins. This MVP
 * implements G1, G2 (approximated — see below), G3, G4, G5, G6, G8, G9, G11.
 * G7 (event blackout) and G10 (liquidity depth) are skipped: this system has
 * no macro calendar feed and no L2 orderbook feed, so those checks cannot be
 * evaluated honestly rather than being faked with a constant.
 */

export interface GateContext {
  candidate: ArchetypeCandidate;
  regime: RegimeSnapshot;
  evidence: EvidenceGraph;
  calibration: CalibrationResult;
  ev: ExpectedValue;
  dataConfidence: number;
  calibrationVintageDays: number;
  existingOpenRisk: OpenRisk[];
  equity: number;
  circuitBreakerTripped: boolean;
}

export interface GateResult {
  passed: boolean;
  downgradeToWatch: boolean;
  reasons: string[];
  heatBudgetPct: number;
}

export function evaluateGates(ctx: GateContext): GateResult {
  const reasons: string[] = [];

  const cell = ARCHETYPE_REGIME_MATRIX[ctx.candidate.archetype][ctx.regime.label];
  if (cell === "VETO") {
    return { passed: false, downgradeToWatch: false, reasons: ["G1_ARCHETYPE_REGIME_VETO"], heatBudgetPct: 0 };
  }

  if (ctx.dataConfidence < 0.7) {
    return { passed: false, downgradeToWatch: false, reasons: ["G2_DATA_CONFIDENCE"], heatBudgetPct: 0 };
  }

  const rejectedFraction = ctx.evidence.dropped.length / Math.max(1, ctx.evidence.admitted.length + ctx.evidence.dropped.length);
  if (rejectedFraction > 0.3) {
    return { passed: false, downgradeToWatch: false, reasons: ["G3_UNVERIFIED_EVIDENCE"], heatBudgetPct: 0 };
  }

  if (ctx.evidence.conflict > 0.35) {
    reasons.push("G4_CONFLICT");
    return { passed: false, downgradeToWatch: true, reasons, heatBudgetPct: 0 };
  }

  const b = ctx.candidate.targets[ctx.candidate.targets.length - 1]?.r ?? 2;
  const breakevenP = 1 / (1 + b);
  if (ctx.calibration.calibratedWinProb < breakevenP + 0.05) {
    return { passed: false, downgradeToWatch: false, reasons: ["G5_INSUFFICIENT_EDGE"], heatBudgetPct: 0 };
  }

  if (ctx.ev.netR < 0.15) {
    return { passed: false, downgradeToWatch: false, reasons: ["G6_NEGATIVE_NET_EV"], heatBudgetPct: 0 };
  }

  const asset = ctx.candidate.asset as Asset;
  if (correlationStackVeto(ctx.existingOpenRisk, asset, ctx.candidate.direction, ctx.equity)) {
    return { passed: false, downgradeToWatch: false, reasons: ["G9_CORRELATION_STACK"], heatBudgetPct: 0 };
  }

  const budget = heatBudget(ctx.existingOpenRisk, asset, ctx.candidate.direction, ctx.equity);
  if (budget < 0.001) {
    return { passed: false, downgradeToWatch: false, reasons: ["G8_PORTFOLIO_HEAT"], heatBudgetPct: 0 };
  }

  if (ctx.circuitBreakerTripped) {
    return { passed: false, downgradeToWatch: false, reasons: ["G12_CIRCUIT_BREAKER"], heatBudgetPct: 0 };
  }

  if (ctx.calibrationVintageDays > 45) reasons.push("G11_STALE_CALIBRATION_SIZE_CAPPED");

  return { passed: true, downgradeToWatch: false, reasons, heatBudgetPct: budget };
}
