import type { Trade } from "../lib/types";

function fmtUsd(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function fmtTime(ms: number | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

const STAGE_LABEL: Record<string, string> = {
  A_UNCALIBRATED: "Stage A · uncalibrated",
  B_COLD_START: "Stage B · cold start",
  C_PLATT: "Stage C · Platt-calibrated",
};

export default function TradeDetail({ trade }: { trade: Trade | null }) {
  if (!trade) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-bg-border bg-bg-panel p-6 text-sm text-ink-faint">
        Select a trade to see its detail.
      </div>
    );
  }

  const pnl = trade.pnlUsd ?? trade.realizedPnlUsd;
  const tone = pnl >= 0 ? "text-bull" : "text-bear";
  const [ciLow, ciHigh] = trade.calibratedWinProbCI90;

  const rows: [string, string][] = [
    ["Archetype", trade.archetype.replaceAll("_", " ")],
    ["Regime", trade.regime.replaceAll("_", " ")],
    ["Direction", trade.direction],
    ["Status", trade.status],
    ["Entry price", trade.entryPrice.toFixed(2)],
    ["Entry time", fmtTime(trade.entryTime)],
    ["Stop price", trade.stopPrice.toFixed(2)],
    ["Remaining qty", `${trade.remainingQuantity.toFixed(6)} / ${trade.initialQuantity.toFixed(6)}`],
    ["Exit reason", trade.exitReason ?? "—"],
    ["Thesis decay", trade.thesisDecay.toFixed(2)],
    ["MFE / MAE (R)", `${trade.maxFavorableExcursionR.toFixed(2)} / ${trade.maxAdverseExcursionR.toFixed(2)}`],
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto rounded-lg border border-bg-border bg-bg-panel p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-ink-faint">Trade P&amp;L</div>
        <div className={"mt-1 font-mono text-2xl " + tone}>{fmtUsd(pnl)}</div>
        <div className={"text-xs " + tone}>
          {trade.pnlPct !== null ? `${trade.pnlPct.toFixed(2)}%` : "—"}
          {trade.rMultiple !== null ? ` · ${trade.rMultiple.toFixed(2)}R` : ""}
        </div>
      </div>

      <div className="rounded-md border border-bg-border bg-bg-raised p-3">
        <div className="flex items-center justify-between text-xs text-ink-faint">
          <span>Calibrated win probability</span>
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">{STAGE_LABEL[trade.calibrationStage] ?? trade.calibrationStage}</span>
        </div>
        <div className="mt-1 font-mono text-lg text-ink">
          {fmtPct(trade.calibratedWinProb)}{" "}
          <span className="text-xs text-ink-faint">
            (90% CI {fmtPct(ciLow)}–{fmtPct(ciHigh)}, n={trade.nEffectiveSignals ? trade.nEffectiveSignals.toFixed(1) : "0"} eff. signals)
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
          <div className="text-ink-faint">Net EV</div>
          <div className={"text-right font-mono " + (trade.evNetR >= 0 ? "text-bull" : "text-bear")}>
            {trade.evNetR.toFixed(2)}R · {fmtUsd(trade.evNetUsd)}
          </div>
          <div className="text-ink-faint">Cost drag</div>
          <div className="text-right font-mono text-ink-muted">{trade.costBreakdown.totalR.toFixed(2)}R</div>
          <div className="text-ink-faint">— fees</div>
          <div className="text-right font-mono text-ink-faint">{trade.costBreakdown.feesR.toFixed(3)}R</div>
          <div className="text-ink-faint">— slippage</div>
          <div className="text-right font-mono text-ink-faint">{trade.costBreakdown.slippageR.toFixed(3)}R</div>
          <div className="text-ink-faint">— funding</div>
          <div className="text-right font-mono text-ink-faint">{trade.costBreakdown.fundingR.toFixed(3)}R</div>
        </div>
      </div>

      <div className="rounded-md border border-bg-border bg-bg-raised p-3">
        <div className="text-xs text-ink-faint">Evidence &amp; conflict</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {trade.evidenceClusters.map((c) => (
            <span key={c} className="rounded bg-bg-border px-1.5 py-0.5 text-[11px] text-ink-muted">
              {c}
            </span>
          ))}
        </div>
        <div className="mt-2 text-xs text-ink-faint">
          Conflict {(trade.conflict * 100).toFixed(0)}% · {trade.evidenceClusters.length} clusters
        </div>
      </div>

      <div className="rounded-md border border-bg-border bg-bg-raised p-3">
        <div className="text-xs text-ink-faint">Sizing</div>
        <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
          <div className="text-ink-faint">Kelly / applied</div>
          <div className="text-right font-mono text-ink">
            {(trade.kellyFraction * 100).toFixed(1)}% / {(trade.appliedFraction * 100).toFixed(1)}%
          </div>
          <div className="text-ink-faint">Bound by</div>
          <div className="text-right font-mono text-ink">{trade.bindingConstraint}</div>
        </div>
        {trade.haircuts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {trade.haircuts.map((h) => (
              <span key={h} className="rounded bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">
                {h}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-ink-faint">Target ladder</div>
        <div className="mt-1 space-y-1">
          {trade.targets.map((t, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className={t.hit ? "text-bull" : "text-ink-muted"}>
                TP{i + 1} · {(t.fraction * 100).toFixed(0)}% @ {t.r.toFixed(2)}R
              </span>
              <span className="font-mono text-ink">{t.price.toFixed(2)}</span>
              {t.hit && <span className="text-bull">✓</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <div className="text-ink-faint">{k}</div>
            <div className="text-right font-mono text-ink">{v}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-ink-faint">Signal reason</div>
        <div className="mt-1 text-sm text-ink-muted">{trade.reason}</div>
      </div>
    </div>
  );
}
