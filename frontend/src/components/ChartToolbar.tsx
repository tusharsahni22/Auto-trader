import { Eye, EyeOff, Trash2 } from "lucide-react";
import clsx from "clsx";
import { localZoneLabel, type ChartTimezone } from "../lib/chartTime";

export const RESOLUTIONS = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
] as const;

export type Resolution = (typeof RESOLUTIONS)[number]["value"];

/**
 * Overlay presets, each with the colour it draws in so the legend and the
 * toggle agree. These are the same indicators the signal bot trades on, so
 * what is on screen matches what the bot sees.
 */
export const STRATEGY_PRESETS = [
  { id: "ema9", label: "EMA 9", dot: "#16c784" },
  { id: "ema21", label: "EMA 21", dot: "#f0b90b" },
  { id: "ema200", label: "EMA 200", dot: "#e5e7eb" },
  { id: "sma", label: "SMA 50/200", dot: "#a855f7" },
  { id: "breakout", label: "Breakout 20", dot: "#ea3943" },
  { id: "bollinger", label: "Bollinger", dot: "#22d3ee" },
  { id: "tradeLevels", label: "Trade levels", dot: "#3d8bfd" },
  { id: "signals", label: "Trade markers", dot: "#93a1ad" },
] as const;

export type PresetId = (typeof STRATEGY_PRESETS)[number]["id"];

interface Props {
  resolution: Resolution;
  onResolutionChange: (r: Resolution) => void;
  active: Record<PresetId, boolean>;
  onToggle: (id: PresetId) => void;
  onClearDrawings?: () => void;
  drawingCount?: number;
  timezone: ChartTimezone;
  onTimezoneChange: (tz: ChartTimezone) => void;
  source?: string | null;
  candleCount?: number;
}

export default function ChartToolbar({
  resolution,
  onResolutionChange,
  active,
  onToggle,
  onClearDrawings,
  drawingCount = 0,
  timezone,
  onTimezoneChange,
  source,
  candleCount,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-bg-border bg-bg-panel px-3 py-2">
      <div className="flex items-center gap-0.5 rounded-lg border border-bg-border bg-bg p-0.5">
        {RESOLUTIONS.map((r) => (
          <button
            key={r.value}
            onClick={() => onResolutionChange(r.value)}
            className={clsx(
              "rounded-md px-2.5 py-1 text-xs transition",
              resolution === r.value
                ? "bg-accent font-semibold text-black"
                : "text-ink-muted hover:bg-bg-raised hover:text-ink"
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {STRATEGY_PRESETS.map((p) => {
          const on = active[p.id];
          return (
            <button
              key={p.id}
              onClick={() => onToggle(p.id)}
              className={clsx(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition",
                on
                  ? "border-bg-border bg-bg-raised text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-muted"
              )}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: p.dot }} />
              {p.label}
              {on ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-bg-border bg-bg p-0.5"
          title="Timezone used for the time axis and crosshair"
        >
          {([
            { value: "local" as const, label: localZoneLabel() },
            { value: "utc" as const, label: "UTC" },
          ]).map((tz) => (
            <button
              key={tz.value}
              onClick={() => onTimezoneChange(tz.value)}
              className={clsx(
                "rounded-md px-2 py-1 text-[11px] font-medium transition",
                timezone === tz.value
                  ? "bg-accent text-black"
                  : "text-ink-muted hover:bg-bg-raised hover:text-ink"
              )}
            >
              {tz.label}
            </button>
          ))}
        </div>

        {drawingCount > 0 && onClearDrawings && (
          <button
            onClick={onClearDrawings}
            title="Clear drawn levels"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-faint transition hover:text-bear"
          >
            <Trash2 size={13} /> {drawingCount}
          </button>
        )}
        {source && (
          <span className="font-mono text-[11px] text-ink-faint">
            {candleCount ?? 0} bars · {source}
          </span>
        )}
      </div>
    </div>
  );
}
