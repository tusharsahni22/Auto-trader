import type { Trade } from "../lib/types";

interface Props {
  trades: Trade[];
  onSelect: (t: Trade) => void;
  selectedId?: string;
}

function fmtUsd(n: number | null) {
  if (n === null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export default function TradeList({ trades, onSelect, selectedId }: Props) {
  return (
    <div className="overflow-auto rounded-lg border border-bg-border bg-bg-panel">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-bg-raised text-xs uppercase text-ink-faint">
          <tr>
            <th className="px-2 py-2 sm:px-3">Asset</th>
            <th className="hidden px-2 py-2 sm:px-3 md:table-cell">Archetype</th>
            <th className="px-2 py-2 sm:px-3">Dir</th>
            <th className="px-2 py-2 sm:px-3">Entry</th>
            <th className="hidden px-2 py-2 sm:px-3 sm:table-cell">Exit</th>
            <th className="px-2 py-2 sm:px-3">Status</th>
            <th className="px-2 py-2 sm:px-3">P&L</th>
            <th className="hidden px-2 py-2 sm:px-3 sm:table-cell">R</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const pnl = t.status === "CLOSED" ? t.pnlUsd ?? 0 : t.realizedPnlUsd;
            const pnlTone = pnl > 0 ? "text-bull" : pnl < 0 ? "text-bear" : "text-ink-muted";
            return (
              <tr
                key={t.id}
                onClick={() => onSelect(t)}
                className={
                  "cursor-pointer border-t border-bg-border transition hover:bg-bg-raised " +
                  (selectedId === t.id ? "bg-bg-raised" : "")
                }
              >
                <td className="px-2 py-2 sm:px-3 font-mono">{t.asset.replace("USDT", "")}</td>
                <td className="hidden px-2 py-2 sm:px-3 text-xs text-ink-muted md:table-cell">{t.archetype.replaceAll("_", " ")}</td>
                <td className="px-2 py-2 sm:px-3">
                  <span className={"rounded px-1.5 py-0.5 text-xs font-semibold " + (t.direction === "LONG" ? "bg-bull-soft text-bull" : "bg-bear-soft text-bear")}>
                    {t.direction}
                  </span>
                </td>
                <td className="px-2 py-2 sm:px-3 font-mono">{t.entryPrice.toFixed(2)}</td>
                <td className="hidden px-2 py-2 sm:px-3 font-mono sm:table-cell">{t.exitPrice ? t.exitPrice.toFixed(2) : "—"}</td>
                <td className="px-2 py-2 sm:px-3 text-xs">
                  <span className={"rounded px-1.5 py-0.5 " + (t.status === "OPEN" ? "bg-accent-soft text-accent" : "bg-bg-raised text-ink-muted")}>
                    {t.status}
                  </span>
                </td>
                <td className={"px-2 py-2 sm:px-3 font-mono " + pnlTone}>{fmtUsd(pnl)}</td>
                <td className={"hidden px-2 py-2 sm:px-3 font-mono sm:table-cell " + pnlTone}>{t.rMultiple !== null ? `${t.rMultiple.toFixed(2)}R` : "—"}</td>
              </tr>
            );
          })}
          {trades.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-8 text-center text-ink-faint">
                No trades match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
