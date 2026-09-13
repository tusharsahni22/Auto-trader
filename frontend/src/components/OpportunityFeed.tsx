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
                {o.vetoReasons.map((r) => (
                  <span key={r} className="rounded bg-bg-border px-1 py-0.5 text-[10px] text-ink-faint">
                    {r}
                  </span>
                ))}
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
