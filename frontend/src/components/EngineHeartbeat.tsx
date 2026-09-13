import { useEffect, useState } from "react";
import type { ScanInfo } from "../lib/types";

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/**
 * The archetype detectors are meant to fire rarely (NO_SETUP is the intended
 * common case — see docs/01 §4/PLAN.md §6). Without this, a correctly-running
 * engine that simply hasn't seen a qualifying setup yet looks indistinguishable
 * from a stalled one, since the opportunity feed only logs actual detections.
 */
export default function EngineHeartbeat({ scan }: { scan: ScanInfo | null }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!scan) {
    return <span className="text-xs text-ink-faint">waiting for first scan…</span>;
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-faint">
      <span className={"h-1.5 w-1.5 rounded-full " + (scan.hasCandidate ? "bg-warn" : "bg-ink-faint")} />
      {scan.hasCandidate ? "archetype pattern present" : "scanning — no setup"} · {timeAgo(scan.time)}
    </span>
  );
}
