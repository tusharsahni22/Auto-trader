import type { PipelineOutput } from "./pipeline.js";

/**
 * Plain-language, number-backed explanation for each veto/watch code, so the
 * UI can show *why* a tracked setup was not traded rather than just a label.
 */
export function explainReason(code: string, out: PipelineOutput): string {
  const c = out.candidate;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const r2 = (n: number) => n.toFixed(2);

  if (code === "G1_ARCHETYPE_REGIME_VETO") {
    return `${c?.archetype.replaceAll("_", " ") ?? "This setup"} is not allowed in a ${out.regime.label.replaceAll("_", " ")} market.`;
  }
  if (code === "G3_UNVERIFIED_EVIDENCE") {
    const dropped = out.evidence?.dropped.length ?? 0;
    return `${dropped} supporting signals failed verification against market data (limit: 30%).`;
  }
  if (code === "G4_CONFLICT") {
    return `Evidence clusters disagree (conflict ${r2(out.evidence?.conflict ?? 0)}, limit 0.35), so it is tracked as WATCH instead of traded.`;
  }
  if (code === "G5_INSUFFICIENT_EDGE") {
    const b = c?.targets[c.targets.length - 1]?.r ?? 2;
    const breakeven = 1 / (1 + b);
    const margin = out.calibrationStage === "A_UNCALIBRATED" ? 0.02 : 0.05;
    return `Estimated win chance ${pct(out.calibratedWinProb ?? 0)} is below the ${pct(breakeven + margin)} needed (breakeven ${pct(breakeven)} + ${pct(margin)} safety margin).`;
  }
  if (code === "G6_NEGATIVE_NET_EV") {
    const cost = out.costBreakdown;
    const costText = cost
      ? ` Costs: fees ${r2(cost.feesR)}R + slippage ${r2(cost.slippageR)}R + funding ${r2(cost.fundingR)}R = ${r2(cost.totalR)}R.`
      : "";
    return `Expected profit after costs is ${r2(out.evNetR ?? 0)}R, below the 0.15R minimum.${costText}`;
  }
  if (code === "G8_PORTFOLIO_HEAT") return "Total open risk is already at the portfolio limit (1.5% of equity).";
  if (code === "G9_CORRELATION_STACK") return "BTC and ETH move together; a same-direction trade is already open and adding this one would exceed the 1% correlated-risk limit.";
  if (code === "G12_CIRCUIT_BREAKER") return "Trading is paused: daily loss, drawdown or losing-streak limit was hit.";
  if (code === "EVENT_BLACKOUT") return "A major scheduled news event is minutes away, so new trades are paused.";
  if (code === "MIN_RISK_NOT_MET") {
    const s = out.sizing;
    return `Position size came out below the 0.1% minimum risk (limited by ${s?.bindingConstraint ?? "risk sizing"}).`;
  }
  if (code.startsWith("EXTREME_FUNDING")) {
    return `Funding rate ${((out.fundingRate ?? 0) * 100).toFixed(3)}% per 8h is at or above the ${((out.maxFundingRate ?? 0) * 100).toFixed(3)}% entry limit.`;
  }
  if (code === "G11_STALE_CALIBRATION_SIZE_CAPPED") return "Calibration is old, so position size is reduced.";
  return code;
}
