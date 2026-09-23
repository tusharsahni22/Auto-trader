import { Fragment, useEffect, useState } from "react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, type OrderHistory as OrderHistoryData, type OrderRow } from "../lib/api";

/**
 * One row per trade: when it opened and closed, side, prices, lots, why it was
 * taken, status, P&L and a running balance. The P/L column is NET — fee, GST and
 * TDS already removed — with the gross figure and full charge split in the
 * expanded row, so "what did this actually make" needs no arithmetic.
 */

const fmt = (n: number, dp = 2) => n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (n: number, dp = 2) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(dp)}`;
const tone = (n: number | null) => (n === null ? "text-ink-muted" : n > 0 ? "text-bull" : n < 0 ? "text-bear" : "text-ink-muted");

function when(ms: number | null) {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { day: "2-digit", month: "short" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function ChargeDetail({ row }: { row: OrderRow }) {
  const c = row.charges;
  const line = (label: string, value: string, hint?: string) => (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-ink-faint">
        {label}
        {hint && <span className="ml-1 text-[9px] text-ink-faint/70">{hint}</span>}
      </span>
      <span className="font-mono text-ink-muted">{value}</span>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-1 bg-bg-raised/60 px-4 py-3 text-[11px] md:grid-cols-3">
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">Entry leg</div>
        {line("Notional", `$${fmt(c.entry.notionalUsd)}`)}
        {line("Trading fee", `$${fmt(c.entry.feeUsd, 4)}`, c.entry.liquidity)}
        {line("GST", `$${fmt(c.entry.gstUsd, 4)}`, `${(c.rates.gstRate * 100).toFixed(0)}% of fee`)}
        {c.entry.tdsUsd > 0 && line("TDS", `$${fmt(c.entry.tdsUsd, 4)}`, `${(c.rates.tdsRate * 100).toFixed(2)}%`)}
      </div>

      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">Exit leg</div>
        {line("Notional", `$${fmt(c.exit.notionalUsd)}`)}
        {line("Trading fee", `$${fmt(c.exit.feeUsd, 4)}`, c.exit.liquidity)}
        {line("GST", `$${fmt(c.exit.gstUsd, 4)}`, `${(c.rates.gstRate * 100).toFixed(0)}% of fee`)}
        {c.exit.tdsUsd > 0 && line("TDS", `$${fmt(c.exit.tdsUsd, 4)}`, `${(c.rates.tdsRate * 100).toFixed(2)}%`)}
      </div>

      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">Result</div>
        {line("Gross P&L", signed(c.grossPnlUsd))}
        {line("Total charges", `-$${fmt(c.totalUsd, 4)}`, `₹${fmt(c.totalInr)}`)}
        <div className="flex items-baseline justify-between gap-3 border-t border-bg-border py-0.5">
          <span className="text-ink-muted">Net P&amp;L</span>
          <span className={clsx("font-mono font-semibold", tone(c.netPnlUsd))}>{signed(c.netPnlUsd)}</span>
        </div>
        {c.incomeTaxProvisionUsd > 0 && (
          <>
            {line("Tax provision", `-$${fmt(c.incomeTaxProvisionUsd)}`, `${(c.rates.effectiveIncomeTaxRate * 100).toFixed(1)}%`)}
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-ink-muted">After tax</span>
              <span className={clsx("font-mono", tone(c.afterTaxPnlUsd))}>{signed(c.afterTaxPnlUsd)}</span>
            </div>
          </>
        )}
        <p className="mt-1 text-[10px] leading-snug text-ink-faint">
          {c.estimated
            ? "Fees estimated from Delta's published rates; exchange-reported commission is used whenever the fill returns one."
            : "Fees taken from Delta's reported commission on the fills."}
        </p>
      </div>
    </div>
  );
}

export default function OrderHistory({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<OrderHistoryData | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .orderHistory(page, 10)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [page, refreshKey]);

  if (error) return <p className="px-3 py-4 text-xs text-bear">Could not load order history — {error}</p>;
  if (!data) return <p className="px-3 py-4 text-xs text-ink-faint">Loading…</p>;
  if (data.total === 0) return <p className="px-3 py-4 text-xs text-ink-faint">No trades recorded yet.</p>;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div>
          <div className="section-label">Order history</div>
          <p className="text-[10px] text-ink-faint">
            One row per trade — entry to exit. P/L is net of fee, GST and TDS. Click a row for the full charge split.
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-faint">{data.total} trades</span>
      </div>

      {/* Phones and tablets get a card per trade. The 10-column table needs ~900px, so on
          a phone it scrolled sideways and the column that matters most, P/L, sat
          off-screen. */}
      <div className="grid grid-cols-1 gap-2 px-2 pb-2 md:grid-cols-2 lg:hidden">
        {data.rows.map((r) => (
          <div key={r.id} className="overflow-hidden rounded-lg border border-bg-border bg-bg-raised/40">
            <button
              type="button"
              onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left"
              aria-expanded={expanded === r.id}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={clsx(
                      "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                      r.direction === "LONG" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
                    )}
                  >
                    {r.direction}
                  </span>
                  <span className="text-xs font-semibold text-ink">{r.asset.replace("USDT", "")}</span>
                  <span
                    className={clsx(
                      "rounded px-1.5 py-0.5 text-[10px]",
                      r.status === "OPEN" ? "bg-accent/15 text-accent" : "bg-bg-raised text-ink-muted"
                    )}
                  >
                    {r.status === "OPEN" ? "Open" : "Closed"}
                  </span>
                  {r.venue === "DELTA" && <span className="text-[9px] text-bull">live</span>}
                </div>
                <div className={clsx("shrink-0 text-right font-mono text-sm font-semibold", tone(r.netPnlUsd))}>
                  {r.netPnlUsd === null ? "—" : signed(r.netPnlUsd)}
                  {r.pnlPct !== null && r.netPnlUsd !== null && (
                    <div className="text-[10px] font-normal text-ink-faint">{r.pnlPct.toFixed(2)}%</div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-ink-muted">
                <span>
                  {fmt(r.entryPrice)} → {r.exitPrice ? fmt(r.exitPrice) : "—"}
                </span>
                <span className="text-ink-faint">{r.lots !== null ? `${r.lots} lots` : "—"}</span>
              </div>

              <div className="flex items-center justify-between gap-2 text-[10px] text-ink-faint">
                <span className="truncate">
                  {when(r.openedAt)} → {when(r.closedAt)}
                </span>
                <span className="shrink-0">Σ {signed(r.cumulativeNetUsd)}</span>
              </div>

              <div className="truncate text-[10px] text-ink-faint" title={r.reason}>
                {r.exitReason ? r.exitReason.replace(/_/g, " ").toLowerCase() : r.reason}
              </div>
            </button>
            {expanded === r.id && <ChargeDetail row={r} />}
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-y border-bg-border text-left text-[10px] uppercase tracking-wide text-ink-faint">
              <th className="px-3 py-1.5 font-medium">Opened</th>
              <th className="px-3 py-1.5 font-medium">Closed</th>
              <th className="px-3 py-1.5 font-medium">Side</th>
              <th className="px-3 py-1.5 text-right font-medium">Entry</th>
              <th className="px-3 py-1.5 text-right font-medium">Exit</th>
              <th className="px-3 py-1.5 text-right font-medium">Lots</th>
              <th className="px-3 py-1.5 font-medium">Reason</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
              <th className="px-3 py-1.5 text-right font-medium">P / L</th>
              <th className="px-3 py-1.5 text-right font-medium">Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              // The fragment is what `map` returns, so the key belongs on it — not on
              // the <tr> inside, which React does not see as the list item.
              <Fragment key={r.id}>
                <tr
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  className="cursor-pointer border-b border-bg-border/50 transition hover:bg-bg-raised"
                >
                  <td className="whitespace-nowrap px-3 py-1.5 text-ink-muted">{when(r.openedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-ink-muted">{when(r.closedAt)}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className={clsx(
                        "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                        r.direction === "LONG" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
                      )}
                    >
                      {r.direction}
                    </span>
                    <span className="ml-1.5 text-ink-faint">{r.asset.replace("USDT", "")}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink-muted">{fmt(r.entryPrice)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink-muted">{r.exitPrice ? fmt(r.exitPrice) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink-muted">
                    {r.lots ?? <span title="Simulated — never sized into whole Delta contracts">—</span>}
                  </td>
                  <td className="max-w-[240px] truncate px-3 py-1.5 text-ink-faint" title={r.reason}>
                    {r.exitReason ? `${r.exitReason.replace(/_/g, " ").toLowerCase()}` : r.reason}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={clsx(
                        "rounded px-1.5 py-0.5 text-[10px]",
                        r.status === "OPEN" ? "bg-accent/15 text-accent" : "bg-bg-raised text-ink-muted"
                      )}
                    >
                      {r.status === "OPEN" ? "Open" : "Closed"}
                    </span>
                    {r.venue === "DELTA" && <span className="ml-1 text-[9px] text-bull" title="Placed on Delta Exchange">live</span>}
                  </td>
                  <td className={clsx("px-3 py-1.5 text-right font-mono", tone(r.netPnlUsd))}>
                    {r.netPnlUsd === null ? "—" : signed(r.netPnlUsd)}
                    {r.pnlPct !== null && r.netPnlUsd !== null && (
                      <span className="ml-1 text-[10px] text-ink-faint">({r.pnlPct.toFixed(2)}%)</span>
                    )}
                  </td>
                  <td className={clsx("px-3 py-1.5 text-right font-mono", tone(r.cumulativeNetUsd))}>
                    {signed(r.cumulativeNetUsd)}
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr>
                    <td colSpan={10} className="p-0">
                      <ChargeDetail row={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-bg-border px-3 py-2 text-[11px] text-ink-faint">
        <span>
          Showing {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={data.page <= 1}
            className="flex items-center gap-0.5 rounded border border-bg-border px-2 py-1 transition enabled:hover:text-ink disabled:opacity-40"
          >
            <ChevronLeft size={11} /> Prev
          </button>
          <span className="px-1">
            Page {data.page} / {data.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
            disabled={data.page >= data.totalPages}
            className="flex items-center gap-0.5 rounded border border-bg-border px-2 py-1 transition enabled:hover:text-ink disabled:opacity-40"
          >
            Next <ChevronRight size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
