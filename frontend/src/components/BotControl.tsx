import { useState } from "react";
import { api, type BotState, type BotStats } from "../lib/api";

interface Props {
  bot: BotState | null;
  stats: BotStats | null;
  onChanged: () => void;
}

const INTERVAL_OPTIONS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
];

export default function BotControl({ bot, stats, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const running = bot?.running ?? false;
  const config = bot?.config;

  return (
    <div className="rounded-lg border border-bg-border bg-bg-panel p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-ink-faint">Signal bot</h3>
        <span
          className={
            "rounded-md px-2 py-0.5 text-xs font-medium " +
            (running ? "bg-bull/15 text-bull" : "bg-bg-raised text-ink-muted")
          }
        >
          {running ? "RUNNING" : "STOPPED"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={() => run(running ? api.botStop : api.botStart)}
          className={
            "rounded-md px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-50 " +
            (running ? "bg-bear hover:opacity-90" : "bg-bull hover:opacity-90")
          }
        >
          {running ? "Stop bot" : "Start bot"}
        </button>
        <button
          disabled={busy}
          onClick={() => run(api.botRunNow)}
          className="rounded-md bg-bg-raised px-3 py-1.5 text-sm font-medium text-ink transition hover:text-white disabled:opacity-50"
        >
          Run once
        </button>
      </div>

      {config && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">Interval</span>
            {INTERVAL_OPTIONS.map((opt) => (
              <button
                key={opt.ms}
                disabled={busy}
                onClick={() => run(() => api.botConfig({ intervalMs: opt.ms }))}
                className={
                  "rounded-md px-2 py-1 text-xs transition " +
                  (config.intervalMs === opt.ms
                    ? "bg-accent text-white"
                    : "bg-bg-raised text-ink-muted hover:text-ink")
                }
              >
                {opt.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={config.autoExecute}
              disabled={busy}
              onChange={(e) => run(() => api.botConfig({ autoExecute: e.target.checked }))}
            />
            Auto-execute signals as trades
          </label>
          <p className="text-xs text-ink-faint">
            {config.autoExecute
              ? `Opens trades on BUY/SELL, risking ${(config.riskPerTrade * 100).toFixed(1)}% of equity each.`
              : "Off — the bot only records decisions."}
          </p>

          <div className="text-xs text-ink-faint">
            EMA {config.strategy.emaFastPeriod}/{config.strategy.emaSlowPeriod} · RSI {config.strategy.rsiPeriod} (
            {config.strategy.rsiOversold}/{config.strategy.rsiOverbought}) · breakout{" "}
            {config.strategy.breakoutLookback} bars
          </div>
        </div>
      )}

      {stats && (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-bg-border pt-2 font-mono text-xs text-ink-muted">
          <span>{stats.totalDecisions} decisions</span>
          <span className="text-bull">{stats.counts.BUY} buy</span>
          <span className="text-bear">{stats.counts.SELL} sell</span>
          <span>{stats.counts.HOLD} hold</span>
          <span>{stats.executed} executed</span>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-bear">{error}</div>}
    </div>
  );
}
