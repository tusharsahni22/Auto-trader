import type { RegimeSnapshot } from "../lib/types";

const REGIME_COLOR: Record<string, string> = {
  TRENDING_UP: "bg-bull-soft text-bull",
  TRENDING_DOWN: "bg-bear-soft text-bear",
  RANGE_BOUND: "bg-bg-raised text-ink-muted",
  LOW_VOL_COMPRESSION: "bg-accent-soft text-accent",
  HIGH_VOL_EXPANSION: "bg-warn/10 text-warn",
  POST_CAPITULATION: "bg-bear-soft text-bear",
};

export default function RegimeBadge({ regime, fundingRate }: { regime: RegimeSnapshot | null; fundingRate: number | null }) {
  if (!regime) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={"rounded px-2 py-1 font-medium " + (REGIME_COLOR[regime.label] ?? "bg-bg-raised text-ink-muted")}>
        {regime.label.replaceAll("_", " ")}
      </span>
      <span className="text-ink-faint">conf {(regime.confidence * 100).toFixed(0)}%</span>
      {fundingRate !== null && (
        <span className="text-ink-faint">funding {(fundingRate * 100).toFixed(4)}%/8h</span>
      )}
    </div>
  );
}
