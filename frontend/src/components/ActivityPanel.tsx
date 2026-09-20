import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ActivityData, ActivityRow, DayDetail } from "../lib/types";

type View = "day" | "week" | "month";

const REASON_LABEL: Record<string, string> = {
  G1_ARCHETYPE_REGIME_VETO: "Market doesn't suit pattern",
  G3_UNVERIFIED_EVIDENCE: "Unverified signals",
  G4_CONFLICT: "Conflicting signals",
  G5_INSUFFICIENT_EDGE: "Win probability too low",
  G6_NEGATIVE_NET_EV: "Costs eat the profit",
  G8_PORTFOLIO_HEAT: "Risk limit reached",
  G9_CORRELATION_STACK: "Correlated trade open",
  G12_CIRCUIT_BREAKER: "Circuit breaker",
  EVENT_BLACKOUT: "News blackout",
  MIN_RISK_NOT_MET: "Size too small",
  SETUP_DISABLED: "Setup paused",
  LIQUIDITY_GATE: "Order book thin/wide",
  EXTREME_FUNDING: "Extreme funding",
};

const DECISION_STYLE: Record<string, string> = {
  OPEN: "bg-bull-soft text-bull",
  WATCH: "bg-warn/10 text-warn",
  VETO: "bg-bear-soft text-bear",
};

function usd(n: number) {
  return (n >= 0 ? "+" : "-") + Math.abs(n).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function topEntries(obj: Record<string, number>, limit = 6): [string, number][] {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function Breakdown({ row }: { row: ActivityRow }) {
  const archetypes = Object.entries(row.byArchetype).sort((a, b) => b[1].found - a[1].found);
  return (
    <div className="grid gap-4 p-3 text-xs md:grid-cols-3">
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">By strategy</div>
        {archetypes.length === 0 && <div className="text-ink-faint">none</div>}
        {archetypes.map(([name, v]) => (
          <div key={name} className="flex justify-between">
            <span className="text-ink-muted">{name.replaceAll("_", " ")}</span>
            <span className="font-mono text-ink">
              {v.found} found · {v.open} taken
            </span>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">Why setups were not traded</div>
        {topEntries(row.vetoReasons).length === 0 && <div className="text-ink-faint">none</div>}
        {topEntries(row.vetoReasons).map(([code, n]) => (
          <div key={code} className="flex justify-between">
            <span className="text-ink-muted">{REASON_LABEL[code] ?? code}</span>
            <span className="font-mono text-ink">{n}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">Scans &amp; trades</div>
        <div className="flex justify-between"><span className="text-ink-muted">Scans run</span><span className="font-mono text-ink">{row.scans}</span></div>
        <div className="flex justify-between"><span className="text-ink-muted">Scans with no setup</span><span className="font-mono text-ink">{row.noSetup}</span></div>
        <div className="flex justify-between"><span className="text-ink-muted">Long / short setups</span><span className="font-mono text-ink">{row.byDirection.LONG} / {row.byDirection.SHORT}</span></div>
        <div className="flex justify-between"><span className="text-ink-muted">BTC / ETH setups</span><span className="font-mono text-ink">{row.byAsset.BTCUSDT ?? 0} / {row.byAsset.ETHUSDT ?? 0}</span></div>
        <div className="flex justify-between"><span className="text-ink-muted">Trades closed</span><span className="font-mono text-ink">{row.tradesClosed} ({row.wins}W / {row.losses}L)</span></div>
        {topEntries(row.exitReasons).map(([reason, n]) => (
          <div key={reason} className="flex justify-between text-ink-faint">
            <span>· {reason.replaceAll("_", " ").toLowerCase()}</span>
            <span className="font-mono">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DayList({ date }: { date: string }) {
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.activityDay(date).then((d) => !cancelled && setDetail(d)).catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [date]);

  if (error) return <div className="p-3 text-xs text-bear">{error}</div>;
  if (!detail) return <div className="p-3 text-xs text-ink-faint">Loading…</div>;
  if (detail.opportunities.length === 0) return <div className="p-3 text-xs text-ink-faint">No setups were logged this day.</div>;

  return (
    <div className="border-t border-bg-border">
      <div className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Every setup on {date}</div>
      <table className="w-full text-xs">
        <tbody>
          {detail.opportunities.map((o) => (
            <tr key={o.id} className="border-t border-bg-border align-top">
              <td className="whitespace-nowrap px-3 py-1.5 font-mono text-ink-faint">{new Date(o.time).toLocaleTimeString()}</td>
              <td className="px-2 py-1.5 font-mono text-ink">
                {o.asset.replace("USDT", "")} {o.direction}
              </td>
              <td className="px-2 py-1.5 text-ink-muted">{o.archetype.replaceAll("_", " ")}</td>
              <td className="px-2 py-1.5">
                <span className={"rounded px-1.5 py-0.5 font-semibold " + (DECISION_STYLE[o.decision] ?? "")}>{o.decision}</span>
              </td>
              <td className="px-2 py-1.5 text-ink-muted">
                {o.vetoDetails && o.vetoDetails.length > 0
                  ? o.vetoDetails.join(" ")
                  : o.vetoReasons.length > 0
                    ? o.vetoReasons.map((r) => REASON_LABEL[r] ?? r).join(", ")
                    : "Passed every check"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, view, depth = 0 }: { row: ActivityRow; view: View; depth?: number }) {
  const [open, setOpen] = useState(false);
  const isDay = row.key.length === 10;
  const pnlTone = row.pnlUsd > 0 ? "text-bull" : row.pnlUsd < 0 ? "text-bear" : "text-ink-muted";
  return (
    <>
      <tr
        onClick={() => setOpen((v) => !v)}
        className={"cursor-pointer border-t border-bg-border transition hover:bg-bg-raised " + (depth > 0 ? "bg-bg-raised/40" : "")}
      >
        <td className="px-3 py-1.5 text-ink" style={{ paddingLeft: 12 + depth * 16 }}>
          <span className="mr-1 text-ink-faint">{open ? "▾" : "▸"}</span>
          {row.label}
        </td>
        <td className="px-2 py-1.5 text-right font-mono text-ink">{row.opportunities}</td>
        <td className="px-2 py-1.5 text-right font-mono text-bull">{row.open}</td>
        <td className="px-2 py-1.5 text-right font-mono text-warn">{row.watch}</td>
        <td className="px-2 py-1.5 text-right font-mono text-bear">{row.veto}</td>
        <td className="px-2 py-1.5 text-right font-mono text-ink">{row.tradesOpened}</td>
        <td className="px-2 py-1.5 text-right font-mono text-ink-muted">
          {row.wins}W / {row.losses}L
        </td>
        <td className={"px-3 py-1.5 text-right font-mono " + pnlTone}>{row.tradesClosed > 0 ? usd(row.pnlUsd) : "—"}</td>
      </tr>
      {open && (
        <tr className="bg-bg-raised/30">
          <td colSpan={8} className="p-0">
            <Breakdown row={row} />
            {isDay && <DayList date={row.key} />}
            {!isDay && row.children && (
              <div className="border-t border-bg-border">
                <div className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Day by day</div>
                <table className="w-full text-xs">
                  <tbody>
                    {row.children.map((child) => (
                      <Row key={child.key} row={child} view={view} depth={depth + 1} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function ActivityPanel({ active }: { active: boolean }) {
  const [view, setView] = useState<View>("day");
  const [data, setData] = useState<ActivityData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () =>
      api
        .activity(120)
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((e) => !cancelled && setError(String(e.message ?? e)));
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);

  const rows = data ? (view === "day" ? data.days : view === "week" ? data.weeks : data.months) : [];
  const total = data?.total;
  const today = data?.days.find((d) => d.key === new Date().toLocaleDateString("en-CA"));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex gap-1">
          {(["day", "week", "month"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={
                "rounded px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider " +
                (view === v ? "border border-bg-border bg-bg-raised text-ink" : "border border-transparent text-ink-faint hover:text-ink-muted")
              }
            >
              {v === "day" ? "Daily" : v === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
        {today && (
          <div className="text-xs text-ink-muted">
            Today: <span className="font-mono text-ink">{today.opportunities}</span> setups ·{" "}
            <span className="font-mono text-bull">{today.open}</span> taken · <span className="font-mono text-warn">{today.watch}</span> watch ·{" "}
            <span className="font-mono text-bear">{today.veto}</span> vetoed
          </div>
        )}
      </div>

      {error && <div className="px-3 pb-2 text-xs text-bear">{error}</div>}
      {!data && !error && <div className="px-3 pb-3 text-xs text-ink-faint">Loading…</div>}

      {data && (
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-bg-raised text-[11px] uppercase text-ink-faint">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">{view === "day" ? "Day" : view === "week" ? "Week" : "Month"}</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Setups the engine found">Setups</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Passed every check and taken">Taken</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Interesting but conflicting signals">Watch</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Blocked by a safety check">Vetoed</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Trades opened in the period">Trades</th>
              <th className="px-2 py-1.5 text-right font-medium">Result</th>
              <th className="px-3 py-1.5 text-right font-medium">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {total && (
              <tr className="border-t border-bg-border bg-bg-raised/60 font-semibold">
                <td className="px-3 py-1.5 text-ink">All ({data.days.length} days)</td>
                <td className="px-2 py-1.5 text-right font-mono text-ink">{total.opportunities}</td>
                <td className="px-2 py-1.5 text-right font-mono text-bull">{total.open}</td>
                <td className="px-2 py-1.5 text-right font-mono text-warn">{total.watch}</td>
                <td className="px-2 py-1.5 text-right font-mono text-bear">{total.veto}</td>
                <td className="px-2 py-1.5 text-right font-mono text-ink">{total.tradesOpened}</td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-muted">{total.wins}W / {total.losses}L</td>
                <td className={"px-3 py-1.5 text-right font-mono " + (total.pnlUsd >= 0 ? "text-bull" : "text-bear")}>{total.tradesClosed > 0 ? usd(total.pnlUsd) : "—"}</td>
              </tr>
            )}
            {rows.map((row) => (
              <Row key={row.key} row={row} view={view} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-ink-faint">
                  No activity recorded yet. Counting starts from the moment the engine next scans.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
