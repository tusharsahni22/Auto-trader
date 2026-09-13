import { useState } from "react";
import type { Asset, Direction, EngineState } from "../lib/types";
import { api } from "../lib/api";

interface Props {
  engine: EngineState | null;
  asset: Asset;
}

export default function EngineControls({ engine, asset }: Props) {
  const [busy, setBusy] = useState(false);
  const [forceDirection, setForceDirection] = useState<Direction>("LONG");
  const [forceError, setForceError] = useState<string | null>(null);
  const running = engine?.running ?? false;

  const handle = async (action: "start" | "stop") => {
    setBusy(true);
    try {
      if (action === "start") await api.startEngine();
      else await api.stopEngine();
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

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-3">
        <span className={"flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium " + (running ? "bg-bull-soft text-bull" : "bg-bg-raised text-ink-muted")}>
          <span className={"h-2 w-2 rounded-full " + (running ? "bg-bull animate-pulse" : "bg-ink-faint")} />
          {running ? "LIVE — PAPER" : "STOPPED"}
        </span>
        <button
          disabled={busy || running}
          onClick={() => handle("start")}
          className="rounded-md bg-bull px-4 py-2 text-sm font-semibold text-black disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
        >
          Start Engine
        </button>
        <button
          disabled={busy || !running}
          onClick={() => handle("stop")}
          className="rounded-md bg-bear px-4 py-2 text-sm font-semibold text-black disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
        >
          Stop Engine
        </button>
        <div className="flex items-center gap-1 rounded-md border border-bg-border bg-bg-raised p-1">
          <select
            value={forceDirection}
            onChange={(e) => setForceDirection(e.target.value as Direction)}
            className="rounded bg-transparent px-1.5 py-1 text-xs text-ink outline-none"
          >
            <option value="LONG">LONG</option>
            <option value="SHORT">SHORT</option>
          </select>
          <button
            disabled={busy || !running}
            onClick={handleForce}
            title="Bypasses archetype detection and risk gates — opens a real paper trade immediately for demo purposes"
            className="rounded-md bg-warn px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
          >
            Force Trade ({asset.replace("USDT", "")})
          </button>
        </div>
      </div>
      {forceError && <span className="text-xs text-bear">{forceError}</span>}
    </div>
  );
}
