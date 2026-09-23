import { useState } from "react";
import { Lock } from "lucide-react";
import type { Asset, Direction, EngineState } from "../lib/types";
import type { EngineRole, LiveTradingStatus, StopBlocker } from "../lib/api";
import { api } from "../lib/api";

interface Props {
  engine: EngineState | null;
  asset: Asset;
  role?: EngineRole;
  live?: LiveTradingStatus;
  /** Everything ongoing that makes stopping unsafe; empty means the engine may be stopped. */
  stopBlockers?: StopBlocker[];
}

/**
 * Engine start/stop and the manual force-trade control.
 *
 * Stop is locked while anything is ongoing. Stopping halts new entries but does not
 * walk away from what is open, so the lock is about not doing it blind: the reason
 * is spelled out in visible text (a tooltip is invisible on a phone) and the server
 * enforces the same rule, so a second tab or a stale page cannot bypass it.
 */
export default function EngineControls({ engine, asset, role, live, stopBlockers = [] }: Props) {
  const [busy, setBusy] = useState(false);
  const [forceDirection, setForceDirection] = useState<Direction>("LONG");
  const [forceError, setForceError] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const running = engine?.running ?? false;
  const canControl = role ? role.isLeader : true;
  const locked = running && stopBlockers.length > 0;

  const handle = async (action: "start" | "stop") => {
    setBusy(true);
    setEngineError(null);
    try {
      if (action === "start") await api.startEngine();
      else await api.stopEngine();
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : "Engine request failed");
    } finally {
      setBusy(false);
    }
  };

  const handleForce = async () => {
    setBusy(true);
    setForceError(null);
    try {
      await api.forceTrade(asset, forceDirection);
    } catch (e) {
      setForceError(e instanceof Error ? e.message : "Failed to force trade");
    } finally {
      setBusy(false);
    }
  };

  // "LIVE — PAPER" used to be shown whatever the engine was really doing. Say which
  // it is, so a simulated run can never be mistaken for one placing real orders.
  const modeLabel = !running ? "STOPPED" : live?.enabled ? "RUNNING · LIVE ORDERS" : "RUNNING · SIMULATED";

  const btn =
    "min-h-[40px] flex-1 rounded-md px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:flex-none";

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
      <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:gap-3">
        <span
          className={
            "flex w-full items-center justify-center gap-2 rounded-full px-3 py-1 text-xs font-medium sm:w-auto " +
            (running ? (live?.enabled ? "bg-bull-soft text-bull" : "bg-warn-soft text-warn") : "bg-bg-raised text-ink-muted")
          }
        >
          <span
            className={
              "h-2 w-2 rounded-full " + (running ? (live?.enabled ? "animate-pulse bg-bull" : "animate-pulse bg-warn") : "bg-ink-faint")
            }
          />
          {modeLabel}
        </span>

        <button disabled={busy || running || !canControl} onClick={() => handle("start")} className={btn + " bg-bull"}>
          Start Engine
        </button>

        <button
          disabled={busy || !running || !canControl || locked}
          onClick={() => handle("stop")}
          aria-describedby={locked ? "stop-locked-reason" : undefined}
          className={btn + " flex items-center justify-center gap-1.5 bg-bear"}
        >
          {locked && <Lock size={13} aria-hidden />}
          Stop Engine
        </button>

        <div className="flex w-full items-center gap-1 rounded-md border border-bg-border bg-bg-raised p-1 sm:w-auto">
          <select
            value={forceDirection}
            onChange={(e) => setForceDirection(e.target.value as Direction)}
            className="rounded bg-transparent px-1.5 py-1 text-xs text-ink outline-none"
          >
            <option value="LONG">LONG</option>
            <option value="SHORT">SHORT</option>
          </select>
          <button
            disabled={busy || !running || !canControl}
            onClick={handleForce}
            title="Bypasses archetype detection and risk gates and opens a trade immediately, for demo purposes"
            className="min-h-[36px] flex-1 rounded-md bg-warn px-3 py-1.5 text-xs font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:flex-none"
          >
            Force Trade ({asset.replace("USDT", "")})
          </button>
        </div>
      </div>

      {locked && (
        <div
          id="stop-locked-reason"
          role="status"
          className="flex w-full items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-snug text-warn sm:max-w-md"
        >
          <Lock size={13} className="mt-px shrink-0" aria-hidden />
          <div>
            <strong>Stop is locked — {stopBlockers.length === 1 ? "a trade is" : `${stopBlockers.length} trades are`} ongoing.</strong>
            <ul className="mt-0.5 text-warn/90">
              {stopBlockers.map((b, i) => (
                <li key={i}>• {b.detail}</li>
              ))}
            </ul>
            <p className="mt-1 text-warn/70">
              Close {stopBlockers.length === 1 ? "it" : "them"} first — the button unlocks by itself. Stopping now would leave{" "}
              {stopBlockers.length === 1 ? "it" : "them"} unattended.
            </p>
          </div>
        </div>
      )}

      {forceError && <span className="text-xs text-bear sm:text-right">{forceError}</span>}
      {engineError && <span className="max-w-xl text-xs text-bear sm:text-right">{engineError}</span>}
      {role && !role.isLeader && (
        <span className="max-w-xl text-xs text-ink-faint sm:text-right">
          Read-only instance. Start the engine at the {role.leaderId} deployment.
        </span>
      )}
    </div>
  );
}
