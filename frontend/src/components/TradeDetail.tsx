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

// Delta perpetual contract sizes (units of the coin per contract). Used only when the trade has no exchange fill to read from.
const CONTRACT_VALUE: Record<string, number> = { BTCUSDT: 0.001, ETHUSDT: 0.01 };

function signedUsd(n: number) {
  return (n >= 0 ? "+" : "-") + fmtUsd(Math.abs(n));
}

export default function TradeDetail({ trade }: { trade: Trade | null }) {
  if (!trade) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-bg-border bg-bg-panel p-6 text-sm text-ink-faint">
        Select a trade to see its detail.
      </div>
    );
  }

  const pnl = trade.pnlUsd ?? trade.realizedPnlUsd;
  const charges = trade.charges;
  // Lead with the net figure when it is known: the gross number is what the trade
  // looked like, the net is what it was actually worth.
  const headlinePnl = charges ? charges.netPnlUsd : pnl;
  const netTone = headlinePnl >= 0 ? "text-bull" : "text-bear";
  const [ciLow, ciHigh] = trade.calibratedWinProbCI90;

  // ── Position size ──────────────────────────────────────────────────────────
  const contractValue = CONTRACT_VALUE[trade.asset] ?? 0;
  const onExchange = trade.execution?.venue === "DELTA" && trade.execution.contracts !== undefined;
  const lots = onExchange ? trade.execution!.contracts! : contractValue > 0 ? Math.floor(trade.initialQuantity / contractValue) : null;
  const coin = trade.asset.replace("USDT", "");
  const notional = trade.entryPrice * trade.initialQuantity;
  const stopDistance = Math.abs(trade.entryPrice - trade.initialStopPrice);
  const riskUsd = stopDistance * trade.initialQuantity;
  const dirSign = trade.direction === "LONG" ? 1 : -1;

  // ── Exit plan: what each target books, using the engine's real rules ───────
  let cumulative = 0;
  const plan = trade.targets.map((t, i) => {
    const qty = trade.initialQuantity * t.fraction;
    const profit = qty * (t.price - trade.entryPrice) * dirSign;
    cumulative += profit;
    const lotsClosed = lots !== null && lots > 0 ? Math.max(1, Math.floor(lots * t.fraction)) : null;
    return { i, t, qty, profit, cumulative, lotsClosed };
  });
  const tp1Profit = plan[0]?.profit ?? 0;

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
        <div className="text-xs uppercase tracking-wide text-ink-faint">
          Trade P&amp;L {charges && <span className="normal-case text-ink-faint/70">· net of charges</span>}
        </div>
        <div className={"mt-1 font-mono text-2xl " + netTone}>{fmtUsd(headlinePnl)}</div>
        <div className={"text-xs " + netTone}>
          {trade.pnlPct !== null ? `${trade.pnlPct.toFixed(2)}%` : "—"}
          {trade.rMultiple !== null ? ` · ${trade.rMultiple.toFixed(2)}R` : ""}
          {charges && <span className="text-ink-faint"> · gross {signedUsd(pnl)}</span>}
        </div>
      </div>

      {/* Delta India charges every fill a trading fee, then 18% GST on that fee.
          Gains are taxed separately at 30% + 4% cess under s.115BBH, so the
          provision is shown apart from the charges that already left the wallet. */}
      {charges && (
        <div className="rounded-md border border-bg-border bg-bg-raised p-3">
          <div className="flex items-center justify-between text-xs text-ink-faint">
            <span>Charges &amp; tax {trade.status === "OPEN" && <span className="text-ink-faint/70">(if closed now)</span>}</span>
            <span className="rounded bg-bg-panel px-1.5 py-0.5 text-[10px]">
              {charges.estimated ? "estimated" : "from exchange"}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
            <div className="text-ink-faint">Trading fee</div>
            <div className="text-right font-mono text-ink-muted">
              {fmtUsd(charges.entry.feeUsd + charges.exit.feeUsd)}
            </div>

            <div className="text-ink-faint">GST @ {(charges.rates.gstRate * 100).toFixed(0)}% of fee</div>
            <div className="text-right font-mono text-ink-muted">
              {fmtUsd(charges.entry.gstUsd + charges.exit.gstUsd)}
            </div>

            {charges.entry.tdsUsd + charges.exit.tdsUsd > 0 && (
              <>
                <div className="text-ink-faint">TDS @ {(charges.rates.tdsRate * 100).toFixed(2)}%</div>
                <div className="text-right font-mono text-ink-muted">
                  {fmtUsd(charges.entry.tdsUsd + charges.exit.tdsUsd)}
                </div>
              </>
            )}

            <div className="border-t border-bg-border pt-1 text-ink-muted">Total charges</div>
            <div className="border-t border-bg-border pt-1 text-right font-mono text-warn">
              −{fmtUsd(charges.totalUsd)}{" "}
              <span className="text-[10px] text-ink-faint">₹{charges.totalInr.toFixed(0)}</span>
            </div>

            <div className="text-ink-muted">Net P&amp;L</div>
            <div className={"text-right font-mono font-semibold " + netTone}>{signedUsd(charges.netPnlUsd)}</div>

            {charges.incomeTaxProvisionUsd > 0 && (
              <>
                <div className="text-ink-faint">
                  Income tax @ {(charges.rates.effectiveIncomeTaxRate * 100).toFixed(1)}%
                </div>
                <div className="text-right font-mono text-bear">−{fmtUsd(charges.incomeTaxProvisionUsd)}</div>

                <div className="text-ink-muted">After tax</div>
                <div className={"text-right font-mono " + (charges.afterTaxPnlUsd >= 0 ? "text-bull" : "text-bear")}>
                  {signedUsd(charges.afterTaxPnlUsd)}
                </div>
              </>
            )}
          </div>

          <p className="mt-2 text-[10px] leading-snug text-ink-faint">
            {charges.incomeTaxProvisionUsd > 0
              ? `Section 115BBH: ${(charges.rates.incomeTaxRate * 100).toFixed(0)}% plus ${(charges.rates.cessRate * 100).toFixed(0)}% cess on the gain, with no set-off against losing trades. A provision to set aside, not a filing.`
              : "No income-tax provision on a losing trade — and under s.115BBH this loss cannot be set off against other gains either."}
          </p>
        </div>
      )}

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

      <div className="rounded-md border border-bg-border bg-bg-raised p-3">
        <div className="text-xs uppercase tracking-wide text-ink-faint">Position size</div>
        <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
          <div className="text-ink-faint">Lot size</div>
          <div className="text-right font-mono text-ink">
            {lots !== null ? `${lots} contract${lots === 1 ? "" : "s"}` : "—"}
            {contractValue > 0 && <span className="text-ink-faint"> × {contractValue} {coin}</span>}
          </div>
          <div className="text-ink-faint">Quantity</div>
          <div className="text-right font-mono text-ink">{trade.initialQuantity.toFixed(4)} {coin}</div>
          <div className="text-ink-faint">Position value (capital in market)</div>
          <div className="text-right font-mono text-ink">{fmtUsd(notional)}</div>
          <div className="text-ink-faint">Risk if stopped out</div>
          <div className="text-right font-mono text-bear">-{fmtUsd(riskUsd)}</div>
          <div className="text-ink-faint">Exchange protection</div>
          <div className={"text-right font-mono " + (trade.execution?.bracket?.status === "UNPROTECTED" ? "text-bear" : trade.execution?.bracket?.status === "PROTECTED" ? "text-bull" : "text-ink-muted")}>
            {trade.execution?.bracket?.status === "PROTECTED"
              ? `Stop on Delta @ ${trade.execution.bracket.slPrice?.toFixed(2)} · ${trade.execution.bracket.tps.filter((t) => t.orderId && !t.done).length} TP orders`
              : trade.execution?.bracket?.status === "UNPROTECTED"
                ? "NO STOP ON EXCHANGE"
                : onExchange ? "—" : "n/a (simulated)"}
          </div>
          <div className="text-ink-faint">Order</div>
          <div className="text-right font-mono text-ink-muted">
            {onExchange ? `Delta · ${trade.execution!.status}` : "Simulated (not on exchange)"}
          </div>
        </div>
        <div className="mt-2 text-[11px] text-ink-faint">
          Margin actually locked = position value ÷ your leverage setting on Delta. Lots are rounded down to whole contracts.
        </div>
      </div>

      <div className="rounded-md border border-bg-border bg-bg-raised p-3">
        <div className="text-xs uppercase tracking-wide text-ink-faint">Exit plan · targets &amp; stop</div>
        <div className="mt-2 space-y-2">
          {plan.map(({ i, t, qty, profit, cumulative: cum, lotsClosed }) => (
            <div key={i} className="rounded border border-bg-border px-2 py-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className={"font-semibold " + (t.hit ? "text-bull" : "text-ink")}>
                  TP{i + 1} @ {t.price.toFixed(2)} ({t.r.toFixed(2)}R) {t.hit && "✓ hit"}
                </span>
                <span className="font-mono text-bull">{signedUsd(profit)}</span>
              </div>
              <div className="mt-0.5 text-ink-muted">
                Books {(t.fraction * 100).toFixed(0)}% of the position ({qty.toFixed(4)} {coin}
                {lotsClosed !== null ? ` · ~${lotsClosed} lot${lotsClosed === 1 ? "" : "s"}` : ""}). Running total {signedUsd(cum)} before fees.
              </div>
              <div className="mt-0.5 text-ink-faint">
                {i === 0
                  ? "Then the stop moves to breakeven (entry), and afterwards trails 2.5 × ATR behind the best price."
                  : i < plan.length - 1
                    ? "Stop stays at the trailing level. It only ever tightens, never loosens."
                    : "Last target: closes the remaining position."}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-xs uppercase tracking-wide text-ink-faint">Scenarios</div>
        <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
          <div className="text-ink-muted">Stopped out before TP1</div>
          <div className="text-right font-mono text-bear">-{fmtUsd(riskUsd)}</div>
          <div className="text-ink-muted">TP1 hits, then stop at breakeven</div>
          <div className="text-right font-mono text-bull">{signedUsd(tp1Profit)}</div>
          {plan.length > 1 && (
            <>
              <div className="text-ink-muted">TP1 + TP2 hit, then stop at breakeven</div>
              <div className="text-right font-mono text-bull">{signedUsd(plan[1].cumulative)}</div>
            </>
          )}
          <div className="text-ink-muted">All targets hit</div>
          <div className="text-right font-mono text-bull">{signedUsd(plan[plan.length - 1]?.cumulative ?? 0)}</div>
        </div>
        <div className="mt-2 text-[11px] text-ink-faint">
          Current stop {trade.stopPrice.toFixed(2)}{trade.breakevenMoved ? " (moved to breakeven/trailing)" : " (original stop)"}. Trades also close on thesis decay or after {trade.maxHoldHours}h. Figures are before fees and slippage.
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
