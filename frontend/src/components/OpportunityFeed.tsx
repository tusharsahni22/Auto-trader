import type { Opportunity } from "../lib/types";

const DECISION_STYLE: Record<Opportunity["decision"], string> = {
  OPEN: "bg-bull-soft text-bull",
  WATCH: "bg-warn/10 text-warn",
  VETO: "bg-bear-soft text-bear",
  NONE: "bg-bg-raised text-ink-faint",
};

const REASON_LABEL: Record<string, string> = {
  G1_ARCHETYPE_REGIME_VETO: "Market conditions don't suit this pattern",
  G2_DATA_CONFIDENCE: "Data feed unreliable",
  G3_UNVERIFIED_EVIDENCE: "Unverified signals",
  G4_CONFLICT: "Conflicting signals",
  G5_INSUFFICIENT_EDGE: "Win probability too low",
  G6_NEGATIVE_NET_EV: "Costs eat the expected profit",
  G8_PORTFOLIO_HEAT: "Risk limit reached",
  G9_CORRELATION_STACK: "Correlated trade already open",
  G11_STALE_CALIBRATION_SIZE_CAPPED: "Needs calibration",
  G12_CIRCUIT_BREAKER: "Circuit breaker tripped",
  DELTA_FEED_REQUIRED: "Delta data required for live trading",
  DATA_STALE: "Market data stale",
  EVENT_BLACKOUT: "Major news event blackout",
  MIN_RISK_NOT_MET: "Trade size too small",
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
            {o.setupReason && (
              <div className="mt-1.5 text-[11px] text-ink-muted">
                <span className="font-semibold text-ink">Why tracked: </span>
                {o.setupReason}
              </div>
            )}
            {o.decision === "OPEN" && (
              <div className="mt-1.5 text-[11px] text-bull">
                <span className="font-semibold">Why taken: </span>
                passed every safety gate with a positive expected profit after costs.
              </div>
            )}
            {o.vetoReasons.length > 0 && (
              <div className="mt-1.5 flex flex-col gap-1">
                <div className="text-[11px] font-semibold text-ink">
                  {o.decision === "OPEN" ? "Notes:" : o.decision === "WATCH" ? "Why watching, not trading:" : "Why not traded:"}
                </div>
                {o.vetoReasons.map((r, i) => {
                  if (r.startsWith("FEED_SOURCE")) return null;
                  const label = REASON_LABEL[r] ?? (r.startsWith("EXTREME_FUNDING") ? "Extreme funding fee" : r);
                  const detail = o.vetoDetails?.[i];
                  return (
                    <div key={r} className="rounded bg-bg-border px-1.5 py-1 text-[11px]">
                      <span className="font-semibold text-bear">{label}</span>
                      {detail && <span className="text-ink-muted"> — {detail}</span>}
                    </div>
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
