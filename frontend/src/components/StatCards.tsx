import type { EngineState, Trade } from "../lib/types";

function fmtUsd(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

interface Props {
  engine: EngineState | null;
  trades: Trade[];
}

export default function StatCards({ engine, trades }: Props) {
  const closed = trades.filter((t) => t.status === "CLOSED");
  const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const netPnl = closed.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
  const equity = engine?.equity ?? 0;
  const startEquity = engine?.startingEquity ?? 0;
  const equityChangePct = startEquity ? ((equity - startEquity) / startEquity) * 100 : 0;

  const cards = [
    {
      label: "Equity",
      value: fmtUsd(equity),
      sub: `${equityChangePct >= 0 ? "+" : ""}${equityChangePct.toFixed(2)}%`,
      tone: equityChangePct >= 0 ? "bull" : "bear",
    },
    {
      label: "Net P&L (closed)",
      value: fmtUsd(netPnl),
      sub: `${closed.length} closed trades`,
      tone: netPnl >= 0 ? "bull" : "bear",
    },
    {
      label: "Win rate",
      value: `${winRate.toFixed(1)}%`,
      sub: `${wins.length}/${closed.length} wins`,
      tone: "neutral",
    },
    {
      label: "Open positions",
      value: String(engine?.openPositions ?? 0),
      sub: engine?.running ? "Engine running" : "Engine stopped",
      tone: engine?.running ? "bull" : "neutral",
    },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg border border-bg-border bg-bg-panel p-4">
          <div className="text-xs uppercase tracking-wide text-ink-faint">{c.label}</div>
          <div className="mt-1 font-mono text-xl text-ink">{c.value}</div>
          <div
            className={
              "mt-1 text-xs " +
              (c.tone === "bull" ? "text-bull" : c.tone === "bear" ? "text-bear" : "text-ink-muted")
            }
          >
            {c.sub}
          </div>
        </div>
      ))}
    </div>
  );
}
