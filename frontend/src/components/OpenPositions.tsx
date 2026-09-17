import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Check, Loader2, Pencil, X } from "lucide-react";
import clsx from "clsx";
import { api, type Position } from "../lib/api";

const money = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

interface Props {
  activeAsset?: string;
  onSelect?: (tradeId: string) => void;
  onChanged?: () => void;
}

export default function OpenPositions({ activeAsset, onSelect, onChanged }: Props) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [totalUnrealized, setTotalUnrealized] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [editStop, setEditStop] = useState<string | null>(null);
  const [stopInput, setStopInput] = useState("");
  // Keyed by position so a failure surfaces on its own card rather than in a
  // single shared banner that hides which position actually failed.
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const fetchData = async () => {
    try {
      const r = await api.positions();
      setPositions(r.positions);
      setTotalUnrealized(r.totalUnrealized);
    } catch {
      /* keep the last good render */
    }
  };

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, []);

  const closePosition = async (p: Position) => {
    const pnl = money(p.unrealized);
    if (!window.confirm(`Close ${p.symbol} ${p.side} at market?\n\nCurrent unrealised P&L: ${pnl}`)) return;

    setBusy(p.id);
    setError(null);
    try {
      await api.closePosition(p.id);
      await fetchData();
      onChanged?.();
    } catch (e: any) {
      setError({ id: p.id, message: e?.message ?? "Close failed" });
    } finally {
      setBusy(null);
    }
  };

  const saveStop = async (p: Position) => {
    const price = parseFloat(stopInput);
    if (!Number.isFinite(price) || price <= 0) {
      setError({ id: p.id, message: "Enter a valid stop price" });
      return;
    }
    setBusy(p.id);
    setError(null);
    try {
      await api.updateStop(p.id, price);
      setEditStop(null);
      await fetchData();
      onChanged?.();
    } catch (e: any) {
      setError({ id: p.id, message: e?.message ?? "Stop update failed" });
    } finally {
      setBusy(null);
    }
  };

  if (positions.length === 0) {
    return (
      <div className="panel p-4 text-xs text-ink-faint">
        No open positions. The engine and bot will open them here as setups qualify.
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-label">Open positions</h2>
        <span className="text-xs text-ink-faint">
          {positions.length} live · total unrealised{" "}
          <span className={clsx("font-mono font-semibold", totalUnrealized >= 0 ? "text-bull" : "text-bear")}>
            {money(totalUnrealized)}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
        {positions.map((p) => (
          <div
            key={p.id}
            onClick={() => onSelect?.(p.id)}
            className={clsx(
              "flex h-full cursor-pointer flex-col rounded-lg border bg-bg-raised p-3 transition",
              p.symbol === activeAsset ? "border-accent/50" : "border-bg-border hover:border-ink-faint/40"
            )}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-ink">{p.symbol.replace("USDT", "")}</span>
                <span
                  className={clsx(
                    "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-semibold",
                    p.side === "LONG" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
                  )}
                >
                  {p.side === "LONG" ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                  {p.side}
                </span>
                <span className="font-mono text-[11px] text-ink-faint">{p.size}</span>
                {p.execution && (
                  <span
                    title={
                      p.execution.venue === "DELTA"
                        ? `Delta order ${p.execution.orderId ?? ""} · ${p.execution.contracts ?? 0} contracts${p.execution.error ? " · " + p.execution.error : ""}`
                        : "Local paper trade — never sent to the exchange"
                    }
                    className={clsx(
                      "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
                      p.execution.venue === "DELTA"
                        ? p.execution.status === "FILLED"
                          ? "bg-accent/15 text-accent"
                          : "bg-warn/15 text-warn"
                        : "bg-bg-border/60 text-ink-faint"
                    )}
                  >
                    {p.execution.venue === "DELTA" ? `Delta ${p.execution.status}` : "Paper"}
                  </span>
                )}
              </div>
              <span
                className={clsx(
                  "font-mono text-sm font-bold tabular-nums",
                  p.unrealized >= 0 ? "text-bull" : "text-bear"
                )}
              >
                {money(p.unrealized)}
                <span className="ml-1 text-[11px] text-ink-faint">
                  ({p.pnlPct > 0 ? "+" : ""}
                  {p.pnlPct.toFixed(2)}%)
                </span>
              </span>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <div className="text-ink-faint">Entry</div>
                <div className="font-mono text-ink-muted">${p.entry.toLocaleString()}</div>
                {p.execution?.priceShift != null && Math.abs(p.execution.priceShift) > 0.01 && (
                  <div
                    className="text-[9px] text-warn"
                    title="Delta filled away from the local feed price; the setup was shifted onto the real fill."
                  >
                    {p.execution.priceShift > 0 ? "+" : ""}
                    {p.execution.priceShift.toFixed(1)} vs feed
                  </div>
                )}
              </div>
              <div>
                <div className="text-ink-faint">Mark</div>
                <div className="font-mono text-ink-muted">${p.mark.toLocaleString()}</div>
              </div>
              <div>
                <div className="flex items-center gap-1 text-ink-faint">
                  Stop
                  {editStop !== p.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditStop(p.id);
                        setStopInput(String(p.sl));
                        setError(null);
                      }}
                      title="Edit stop loss"
                      className="text-ink-faint hover:text-ink"
                    >
                      <Pencil size={10} />
                    </button>
                  )}
                </div>
                {editStop === p.id ? (
                  <div className="mt-0.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      type="number"
                      step="any"
                      value={stopInput}
                      onChange={(e) => setStopInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveStop(p);
                        if (e.key === "Escape") setEditStop(null);
                      }}
                      className="w-20 rounded border border-bg-border bg-bg-panel px-1 py-0.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
                    />
                    <button
                      onClick={() => saveStop(p)}
                      disabled={busy === p.id}
                      className="text-bull hover:opacity-80 disabled:opacity-50"
                    >
                      {busy === p.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    </button>
                    <button onClick={() => setEditStop(null)} className="text-ink-faint hover:text-ink">
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className="font-mono text-bear">${p.sl.toLocaleString()}</div>
                )}
              </div>
            </div>

            {p.tps.length > 0 && (
              <div className="mt-1.5 text-[11px]">
                <span className="text-ink-faint">Targets: </span>
                <span className="font-mono text-bull">
                  {p.tps.map((t) => `$${t.toLocaleString()}`).join(" · ")}
                </span>
              </div>
            )}

            <div className="mt-1.5 text-[11px]">
              <span className="text-ink-faint">R multiple: </span>
              <span className={clsx("font-mono", p.rMultiple >= 0 ? "text-bull" : "text-bear")}>
                {p.rMultiple >= 0 ? "+" : ""}
                {p.rMultiple.toFixed(2)}R
              </span>
            </div>

            {error?.id === p.id && (
              <div className="mt-1.5 rounded border border-bear/30 bg-bear/10 px-2 py-1 text-[10px] text-bear">
                {error.message}
              </div>
            )}

            {/* mt-auto keeps the button flush with the bottom of every card */}
            <div className="mt-auto pt-3">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closePosition(p);
                }}
                disabled={busy === p.id}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-bear/30 bg-bear/10 py-2 text-[11px] font-semibold text-bear transition hover:bg-bear/20 disabled:opacity-50"
              >
                {busy === p.id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Close position
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
