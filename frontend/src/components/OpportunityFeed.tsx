import type { Opportunity } from "../lib/types";

const DECISION_STYLE: Record<Opportunity["decision"], string> = {
  OPEN: "bg-bull-soft text-bull",
  WATCH: "bg-warn/10 text-warn",
  VETO: "bg-bear-soft text-bear",
  NONE: "bg-bg-raised text-ink-faint",
};

export default function OpportunityFeed({ opportunities }: { opportunities: Opportunity[] }) {
  return (
    <div className="flex h-full flex-col overflow-auto rounded-lg border border-bg-border bg-bg-panel p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-ink-faint">
        Opportunity feed ({opportunities.length})
      </div>
      <div className="flex flex-col gap-1.5">
        {opportunities.map((o) => (
          <div key={o.id} className="rounded-md border border-bg-border bg-bg-raised px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-mono text-ink">
                {o.asset.replace("USDT", "")} · {o.direction}
              </span>
              <span className={"rounded px-1.5 py-0.5 font-semibold " + DECISION_STYLE[o.decision]}>{o.decision}</span>
            </div>
            <div className="mt-1 text-ink-muted">
              {o.archetype.replaceAll("_", " ")} in {o.regime.replaceAll("_", " ")}
            </div>
            <div className="mt-1 flex items-center justify-between text-ink-faint">
              <span>p(win) {(o.calibratedWinProb * 100).toFixed(0)}% · EV {o.evNetR.toFixed(2)}R</span>
              <span>{new Date(o.time).toLocaleTimeString()}</span>
            </div>
            {o.vetoReasons.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {o.vetoReasons.map((r) => {
                  let text = r;
                  if (r === "G1_ARCHETYPE_REGIME_VETO") text = "Market trend opposes pattern";
                  else if (r === "G2_DATA_CONFIDENCE") text = "Data feed unreliable";
                  else if (r === "G3_UNVERIFIED_EVIDENCE") text = "Unverified signals";
                  else if (r === "G4_CONFLICT") text = "Conflicting signals";
                  else if (r === "G5_INSUFFICIENT_EDGE") text = "Win probability too low";
                  else if (r === "G6_NEGATIVE_NET_EV") text = "Fees eat all profits";
                  else if (r === "G8_PORTFOLIO_HEAT") text = "Risk limit reached";
                  else if (r === "G9_CORRELATION_STACK") text = "Correlated trade already open";
                  else if (r === "G11_STALE_CALIBRATION_SIZE_CAPPED") text = "Needs calibration";
                  else if (r === "G12_CIRCUIT_BREAKER") text = "Circuit breaker tripped";
                  else if (r === "DELTA_FEED_REQUIRED") text = "Delta data required for live trading";
                  else if (r === "DATA_STALE") text = "Market data stale";
                  else if (r === "EVENT_BLACKOUT") text = "Major news event blackout";
                  else if (r === "MIN_RISK_NOT_MET") text = "Trade size too small";
                  else if (r.startsWith("EXTREME_FUNDING")) text = `Extreme funding fee: ${(Number(r.split("_")[2]) * 100).toFixed(2)}%`;
                  else if (r.startsWith("FEED_SOURCE")) return null; // hide this redundant tag

                  return (
                    <span key={r} className="rounded bg-bg-border px-1.5 py-0.5 text-[10px] font-medium text-bear-soft">
                      {text}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {opportunities.length === 0 && (
          <div className="py-6 text-center text-xs text-ink-faint">
            No opportunities scored yet — the engine emits one every time an archetype detector fires.
          </div>
        )}
      </div>
    </div>
  );
}
