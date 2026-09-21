import { useEffect, useState } from "react";
import clsx from "clsx";
import { api, type TaxPosition, type TrainingMonitor as TrainingData } from "../lib/api";

/**
 * Training monitor: how much of the strategy's theoretical edge survives contact
 * with the exchange, and what India's tax rules leave of what remains.
 *
 * Strategy P&L is what the decisions were worth at the prices they were made at.
 * Execution P&L is what the wallet actually shows. The gap between them — slippage
 * plus fees, GST and TDS — is what decides whether a marginally-positive strategy
 * is worth running at all.
 */

const signed = (n: number, dp = 2) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(dp)}`;
const usd = (n: number, dp = 2) => `$${Math.abs(n).toFixed(dp)}`;
const tone = (n: number) => (n > 0 ? "text-bull" : n < 0 ? "text-bear" : "text-ink-muted");

function Stat({ label, value, sub, valueTone }: { label: string; value: string; sub?: string; valueTone?: string }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-raised px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={clsx("mt-0.5 font-mono text-lg", valueTone ?? "text-ink")}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] leading-snug text-ink-faint">{sub}</div>}
    </div>
  );
}

export default function TrainingMonitor({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<TrainingData | null>(null);
  const [tax, setTax] = useState<TaxPosition | null>(null);

  useEffect(() => {
    const load = () => {
      api.trainingMonitor().then(setData).catch(() => {});
      api.taxPosition().then(setTax).catch(() => {});
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [refreshKey]);

  if (!data) return <p className="px-3 py-4 text-xs text-ink-faint">Loading…</p>;

  const noData = data.strategyPnlUsd === 0 && data.executionPnlUsd === 0 && data.scoredTrades === 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <div className="section-label">Training monitor</div>
        <p className="text-[10px] text-ink-faint">
          What the strategy was worth on paper versus what reached the wallet. The gap is the real cost of trading.
        </p>
      </div>

      {noData && (
        <p className="rounded border border-bg-border bg-bg-raised px-3 py-2 text-[11px] text-ink-faint">
          No closed trades to learn from yet. These figures fill in as trades complete.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat
          label="Strategy P&L"
          value={signed(data.strategyPnlUsd)}
          valueTone={tone(data.strategyPnlUsd)}
          sub="What the decisions were worth at the prices they were made at."
        />
        <Stat
          label="Execution P&L"
          value={signed(data.executionPnlUsd)}
          valueTone={tone(data.executionPnlUsd)}
          sub="What the wallet actually shows, after every charge."
        />
        <Stat
          label="Cost of trading"
          value={usd(data.chargeCostUsd)}
          valueTone="text-warn"
          sub={`Fees, GST and TDS${data.slippageUsd !== 0 ? ` · slippage ${signed(data.slippageUsd)}` : ""}.`}
        />
        <Stat
          label="Decision win rate"
          value={`${(data.decisionWinRate * 100).toFixed(1)}%`}
          sub={
            data.scoredTrades === 0
              ? "No scored trades yet."
              : `Engine predicted ${(data.predictedWinRate * 100).toFixed(1)}% across ${data.scoredTrades} trades.`
          }
        />
      </div>

      {data.scoredTrades > 0 && (
        <div
          className={clsx(
            "rounded border px-3 py-2 text-[11px] leading-snug",
            data.calibrationGap > 0.1
              ? "border-warn/40 bg-warn/10 text-warn"
              : "border-bg-border bg-bg-raised text-ink-muted"
          )}
        >
          {data.calibrationGap > 0.1 ? (
            <>
              <strong>Over-confident.</strong> The engine predicted a {(data.predictedWinRate * 100).toFixed(1)}% win rate
              and delivered {(data.decisionWinRate * 100).toFixed(1)}% — a {(data.calibrationGap * 100).toFixed(1)} point
              shortfall. The calibration layer shrinks scores to close it, but with only {data.scoredTrades} closed trades
              the estimate is still noisy.
            </>
          ) : data.calibrationGap < -0.1 ? (
            <>
              <strong>Under-confident.</strong> The engine predicted {(data.predictedWinRate * 100).toFixed(1)}% and
              delivered {(data.decisionWinRate * 100).toFixed(1)}%. Pleasant, but not yet evidence of skill — with{" "}
              {data.scoredTrades} closed trade{data.scoredTrades === 1 ? "" : "s"} a run of luck looks exactly like this.
            </>
          ) : (
            <>
              Predicted {(data.predictedWinRate * 100).toFixed(1)}% versus {(data.decisionWinRate * 100).toFixed(1)}%
              delivered over {data.scoredTrades} trade{data.scoredTrades === 1 ? "" : "s"} — within the noise band for a
              sample this small.
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-bg-border">
          <div className="border-b border-bg-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Execution mix
          </div>
          <div className="flex flex-col gap-1 px-3 py-2 text-[11px]">
            <div className="flex justify-between">
              <span className="text-ink-faint">Placed on Delta</span>
              <span className="font-mono text-ink">{data.liveTrades}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-faint">Simulated only</span>
              <span className="font-mono text-ink">{data.simulatedTrades}</span>
            </div>
            <div className="flex justify-between border-t border-bg-border/60 pt-1">
              <span className="text-ink-faint">Lost between decision and wallet</span>
              <span className={clsx("font-mono", tone(-Math.abs(data.executionGapUsd)))}>
                {usd(data.executionGapUsd)}
              </span>
            </div>
          </div>
        </div>

        {tax && (
          <div className="rounded-lg border border-bg-border">
            <div className="border-b border-bg-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              India tax position · {tax.financialYear}
            </div>
            <div className="flex flex-col gap-1 px-3 py-2 text-[11px]">
              <div className="flex justify-between">
                <span className="text-ink-faint">Taxable gains ({tax.winningTrades} winners)</span>
                <span className="font-mono text-ink">{usd(tax.taxableGainUsd)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-faint">Losses (not deductible)</span>
                <span className="font-mono text-ink-muted">{usd(tax.totalLossUsd)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-faint">Tax at {(tax.effectiveRate * 100).toFixed(1)}%</span>
                <span className="font-mono text-bear">
                  {usd(tax.estimatedTaxUsd)} <span className="text-ink-faint">/ ₹{tax.estimatedTaxInr.toFixed(0)}</span>
                </span>
              </div>
              <div className="flex justify-between border-t border-bg-border/60 pt-1">
                <span className="text-ink-muted">After tax</span>
                <span className={clsx("font-mono font-semibold", tone(tax.afterTaxUsd))}>{signed(tax.afterTaxUsd)}</span>
              </div>
              <p className="mt-1 text-[10px] leading-snug text-ink-faint">
                Section 115BBH taxes each gain at {(tax.rates.incomeTaxRate * 100).toFixed(0)}% plus a{" "}
                {(tax.rates.cessRate * 100).toFixed(0)}% cess and does not allow losses to be set off, so the base is the
                winners alone. A provision for planning, not a filing.
              </p>

              {/* Say which numbers are live and which are fallbacks, so an unreachable
                  feed shows as stale rather than passing for a current quote. */}
              {tax.provenance && (
                <p className="text-[10px] leading-snug text-ink-faint">
                  Fees{" "}
                  <span className={tax.provenance.fees.source === "delta" ? "text-bull" : "text-warn"}>
                    {tax.provenance.fees.source === "delta" ? "live from Delta" : "from config"}
                  </span>
                  {" · "}USD/INR {tax.rates.usdInr.toFixed(2)}{" "}
                  <span className={tax.provenance.usdInr.source === "config" ? "text-warn" : "text-bull"}>
                    {tax.provenance.usdInr.source === "config"
                      ? "from config (feed unreachable)"
                      : `live, ${
                          tax.provenance.usdInr.fetchedAt
                            ? new Date(tax.provenance.usdInr.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                            : "—"
                        }`}
                  </span>
                  {" · "}GST and tax rates are statutory, set in the Union Budget.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {data.recentClosed.length > 0 && (
        <div className="rounded-lg border border-bg-border">
          <div className="border-b border-bg-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Recent closed trades
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint">
                  <th className="px-3 py-1 font-medium">Closed</th>
                  <th className="px-3 py-1 font-medium">Side</th>
                  <th className="px-3 py-1 text-right font-medium">Mark in → out</th>
                  <th className="px-3 py-1 text-right font-medium">Strategy</th>
                  <th className="px-3 py-1 text-right font-medium">Charges</th>
                  <th className="px-3 py-1 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {data.recentClosed.map((t) => (
                  <tr key={t.id} className="border-t border-bg-border/50">
                    <td className="whitespace-nowrap px-3 py-1 text-ink-muted">
                      {t.closedAt
                        ? new Date(t.closedAt).toLocaleString([], {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—"}
                    </td>
                    <td className="px-3 py-1">
                      <span className={t.direction === "LONG" ? "text-bull" : "text-bear"}>{t.direction}</span>
                      <span className="ml-1 text-ink-faint">{t.asset.replace("USDT", "")}</span>
                    </td>
                    <td className="px-3 py-1 text-right font-mono text-ink-muted">
                      {t.entryPrice.toFixed(2)} → {t.exitPrice?.toFixed(2) ?? "—"}
                    </td>
                    <td className={clsx("px-3 py-1 text-right font-mono", tone(t.grossPnlUsd))}>
                      {signed(t.grossPnlUsd)}
                    </td>
                    <td className="px-3 py-1 text-right font-mono text-warn">-{usd(t.chargesUsd, 4)}</td>
                    <td className={clsx("px-3 py-1 text-right font-mono font-semibold", tone(t.netPnlUsd))}>
                      {signed(t.netPnlUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
