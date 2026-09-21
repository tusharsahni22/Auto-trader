import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Database, Radio } from "lucide-react";
import type { LedgerHealth, LiveTradingStatus } from "../lib/api";

/**
 * Two things that used to fail silently, made visible.
 *
 * Live trading: the engine keeps running and filling trades in simulation when
 * LIVE_TRADING is off or the API keys are missing, and the dashboard looked
 * identical either way — so "why is nothing on the exchange?" needed a log dive.
 *
 * Ledger sync: trade rows live in a local JSON file and in MongoDB. When a Mongo
 * write failed the counts silently diverged, and trades could disappear from the
 * list. `pendingSync` shows the gap rather than hiding it.
 */
export default function SystemStatus({ live, ledger }: { live?: LiveTradingStatus; ledger?: LedgerHealth }) {
  if (!live && !ledger) return null;

  const ledgerProblem = Boolean(ledger && (ledger.lastPersistError || ledger.error || (ledger.pendingSync ?? 0) > 0));

  return (
    <div className="flex flex-col gap-2">
      {live && !live.enabled && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <div className="min-w-0">
            <strong>Simulated trading — nothing is being sent to Delta.</strong>
            <ul className="mt-1 flex flex-col gap-0.5">
              {live.blockers.map((b) => (
                <li key={b} className="text-warn/90">
                  • {b}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-warn/70">{live.note}</p>
          </div>
        </div>
      )}

      {live?.enabled && (
        <div className="flex items-center gap-2 rounded-lg border border-bull/30 bg-bull/10 px-3 py-1.5 text-[11px] text-bull">
          <Radio size={13} className="shrink-0" />
          <span>
            <strong>Live</strong> — orders are placed on Delta Exchange as{" "}
            {live.entryOrderType === "MARKET" ? "market orders" : "limit orders at the mark"}.
            {live.entryOrderType === "LIMIT" && live.limitOrderTimeoutMs && (
              <span className="text-bull/70">
                {" "}
                An entry that has not filled within {Math.round(live.limitOrderTimeoutMs / 1000)}s is cancelled — set
                DELTA_ENTRY_ORDER_TYPE=market if entries keep expiring.
              </span>
            )}
          </span>
          <CheckCircle2 size={12} className="ml-auto shrink-0" />
        </div>
      )}

      {ledger && (
        <div
          className={clsx(
            "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px]",
            ledgerProblem ? "border-bear/40 bg-bear/10 text-bear" : "border-bg-border bg-bg-panel text-ink-faint"
          )}
        >
          <Database size={12} className="shrink-0" />
          <span>
            Ledger: <span className="font-mono text-ink">{ledger.trades}</span> trades here
            {ledger.remoteTrades !== null && (
              <>
                , <span className="font-mono text-ink">{ledger.remoteTrades}</span> in MongoDB
              </>
            )}
            {!ledger.mongoConnected && " · MongoDB not connected (local file only)"}
          </span>
          {ledgerProblem && (
            <span className="ml-auto truncate" title={ledger.lastPersistError ?? ledger.error ?? ""}>
              {(ledger.pendingSync ?? 0) > 0
                ? `${ledger.pendingSync} row(s) not yet synced`
                : ledger.lastPersistError ?? ledger.error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
