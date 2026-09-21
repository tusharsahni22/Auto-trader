import { useEffect, useState } from "react";
import clsx from "clsx";
import { api, type AnalyticsSummary, type DailyPnl, type DecisionMix } from "../lib/api";

/**
 * Analytics & progress: realised P&L per day, what the engine decided, and how
 * the wins and losses split. Every money figure here is NET — after Delta's fee,
 * the 18% GST on that fee and any TDS — because a gross number flatters a system
 * that is actually losing money once costs land.
 */

const usd = (n: number, dp = 2) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const signed = (n: number, dp = 2) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(dp)}`;

const toneClass = (n: number) => (n > 0 ? "text-bull" : n < 0 ? "text-bear" : "text-ink-muted");

/** Horizontal bars, zero-centred, so losing days read as clearly as winning ones. */
function DailyBars({ data }: { data: DailyPnl }) {
  if (data.days.length === 0) {
    return <p className="px-3 py-6 text-xs text-ink-faint">No closed trades in this window yet.</p>;
  }

  const peak = Math.max(...data.days.map((d) => Math.abs(d.netUsd)), 0.01);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-[160px] items-end gap-[3px] overflow-x-auto px-1">
        {data.days.map((d) => {
          const height = Math.max(2, (Math.abs(d.netUsd) / peak) * 68);
          const positive = d.netUsd >= 0;
          return (
            <div
              key={d.date}
              className="group relative flex min-w-[10px] flex-1 flex-col justify-center"
              title={`${d.date}\nnet ${signed(d.netUsd)} · ${d.trades} trade${d.trades === 1 ? "" : "s"}\ncharges ${usd(d.chargesUsd)}`}
            >
              {/* Two stacked halves around a shared midline keeps the axis fixed. */}
              <div className="flex h-[70px] flex-col justify-end">
                {positive && <div className="w-full rounded-t-sm bg-bull/80" style={{ height: `${height}px` }} />}
              </div>
              <div className="h-px w-full bg-bg-border" />
              <div className="flex h-[70px] flex-col justify-start">
                {!positive && <div className="w-full rounded-b-sm bg-bear/80" style={{ height: `${height}px` }} />}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2 px-1 text-[11px] sm:grid-cols-4">
        {[
          ["Best day", signed(data.bestDayUsd), data.bestDayUsd],
          ["Worst day", signed(data.worstDayUsd), data.worstDayUsd],
          ["Green days", String(data.profitableDays), 1],
          ["Red days", String(data.losingDays), data.losingDays > 0 ? -1 : 0],
        ].map(([label, value, tone]) => (
          <div key={label as string} className="rounded border border-bg-border bg-bg-raised px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
            <div className={clsx("font-mono text-sm", toneClass(tone as number))}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A donut drawn with one SVG circle per slice, using stroke-dasharray.
 * Cheaper and more predictable than pulling in a charting dependency for this.
 */
function Donut({ slices, centre, caption }: { slices: { label: string; value: number; color: string }[]; centre: string; caption: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" className="h-[120px] w-[120px] shrink-0 -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#1a2029" strokeWidth="14" />
        {total > 0 &&
          slices.map((s) => {
            const length = (s.value / total) * circumference;
            const dash = <circle key={s.label} cx="60" cy="60" r={radius} fill="none" stroke={s.color} strokeWidth="14" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />;
            offset += length;
            return dash;
          })}
        <text x="60" y="60" textAnchor="middle" dominantBaseline="central" className="rotate-90 fill-ink font-mono text-[15px]" style={{ transformOrigin: "60px 60px" }}>
          {centre}
        </text>
      </svg>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {slices.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="truncate text-ink-muted">{s.label}</span>
            <span className="ml-auto font-mono text-ink">{s.value}</span>
            <span className="w-10 text-right tabular-nums text-ink-faint">
              {total > 0 ? `${((s.value / total) * 100).toFixed(0)}%` : "—"}
            </span>
          </div>
        ))}
        <p className="mt-1 text-[10px] leading-snug text-ink-faint">{caption}</p>
      </div>
    </div>
  );
}

export default function AnalyticsProgress({ refreshKey = 0 }: { refreshKey?: number }) {
  const [daily, setDaily] = useState<DailyPnl | null>(null);
  const [mix, setMix] = useState<DecisionMix | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    const load = () => {
      api.analyticsDaily(days).then(setDaily).catch(() => {});
      api.decisionMix(days).then(setMix).catch(() => {});
      api.analyticsSummary().then(setSummary).catch(() => {});
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [days, refreshKey]);

  const p = summary?.performance;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="section-label">Analytics &amp; progress</div>
        <div className="flex items-center gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={clsx(
                "rounded px-2 py-0.5 text-[10px] font-semibold transition",
                days === d ? "bg-accent text-black" : "bg-bg-raised text-ink-faint hover:text-ink"
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="panel p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-xs text-ink-muted">Realised P&amp;L per day, net of fees, GST and TDS</span>
          {p && <span className={clsx("font-mono text-sm", toneClass(p.netPnlUsd))}>{signed(p.netPnlUsd)} total</span>}
        </div>
        {daily ? <DailyBars data={daily} /> : <p className="py-6 text-xs text-ink-faint">Loading…</p>}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="panel p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Decision mix</div>
          {mix ? (
            <Donut
              centre={String(mix.totals.scans)}
              caption={`${mix.totals.scans} scans over ${mix.windowDays} days · ${mix.totals.long} long / ${mix.totals.short} short setups.`}
              slices={[
                { label: "Opened", value: mix.totals.open, color: "#16c784" },
                { label: "Watching", value: mix.totals.watch, color: "#f0b90b" },
                { label: "Vetoed", value: mix.totals.veto, color: "#ea3943" },
                { label: "No setup", value: mix.totals.noSetup, color: "#3a4756" },
              ]}
            />
          ) : (
            <p className="py-6 text-xs text-ink-faint">Loading…</p>
          )}
        </div>

        <div className="panel p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Win / loss</div>
          {p ? (
            <Donut
              centre={`${(p.winRate * 100).toFixed(0)}%`}
              caption={
                p.closedTrades === 0
                  ? "No closed trades yet."
                  : `${p.wins} of ${p.closedTrades} closed trades finished green after costs.`
              }
              slices={[
                { label: "Wins", value: p.wins, color: "#16c784" },
                { label: "Losses", value: p.losses, color: "#ea3943" },
              ]}
            />
          ) : (
            <p className="py-6 text-xs text-ink-faint">Loading…</p>
          )}
        </div>

        <div className="panel p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Performance</div>
          {p ? (
            <dl className="flex flex-col gap-1 text-[11px]">
              {[
                ["Win rate", `${(p.winRate * 100).toFixed(1)}%`, 0],
                ["Closed trades", String(p.closedTrades), 0],
                ["Avg win", signed(p.avgWinUsd), p.avgWinUsd],
                ["Avg loss", signed(p.avgLossUsd), p.avgLossUsd],
                ["Best trade", signed(p.bestTradeUsd), p.bestTradeUsd],
                ["Worst trade", signed(p.worstTradeUsd), p.worstTradeUsd],
                ["Expectancy / trade", signed(p.expectancyUsd), p.expectancyUsd],
                ["Profit factor", p.profitFactor === null ? "—" : p.profitFactor.toFixed(2), (p.profitFactor ?? 1) - 1],
                ["Avg R multiple", p.avgRMultiple.toFixed(2), p.avgRMultiple],
              ].map(([label, value, tone]) => (
                <div key={label as string} className="flex items-center justify-between gap-2 border-b border-bg-border/50 py-0.5 last:border-0">
                  <dt className="text-ink-faint">{label}</dt>
                  <dd className={clsx("font-mono", toneClass(tone as number))}>{value}</dd>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-2 rounded bg-bg-raised px-2 py-1">
                <dt className="text-ink-faint">Charges paid</dt>
                <dd className="font-mono text-warn">{usd(p.totalChargesUsd)}</dd>
              </div>
              <p className="mt-1 text-[10px] leading-snug text-ink-faint">
                Gross P&amp;L {signed(p.grossPnlUsd)} minus {usd(p.totalChargesUsd)} of fees, GST and TDS.
              </p>
            </dl>
          ) : (
            <p className="py-6 text-xs text-ink-faint">Loading…</p>
          )}
        </div>
      </div>

      {mix && mix.blockedBy.length > 0 && (
        <div className="panel p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Trades not taken · last {mix.windowDays} days
          </div>
          <div className="flex flex-col gap-1">
            {mix.blockedBy.slice(0, 8).map((b) => {
              const max = mix.blockedBy[0].count || 1;
              return (
                <div key={b.reason} className="flex items-center gap-2 text-[11px]">
                  <span className="w-44 shrink-0 truncate text-ink-muted" title={b.reason}>
                    {b.reason.replace(/_/g, " ").toLowerCase()}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-sm bg-bg-raised">
                    <div className="h-full rounded-sm bg-warn/70" style={{ width: `${(b.count / max) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right font-mono tabular-nums text-ink">{b.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
