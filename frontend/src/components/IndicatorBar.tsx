import type { AssetIndicators, BotSignal } from "../lib/api";

function signalTone(signal: BotSignal) {
  if (signal === "BUY") return "bg-bull/15 text-bull border-bull/40";
  if (signal === "SELL") return "bg-bear/15 text-bear border-bear/40";
  return "bg-bg-raised text-ink-muted border-bg-border";
}

function rsiTone(value: number) {
  if (value >= 70) return "text-bear";
  if (value <= 30) return "text-bull";
  return "text-ink";
}

interface Props {
  indicators: AssetIndicators | null;
}

export default function IndicatorBar({ indicators }: Props) {
  if (!indicators?.indicators) {
    return (
      <div className="rounded-lg border border-bg-border bg-bg-panel px-3 py-2 text-xs text-ink-faint">
        Indicators warming up…
      </div>
    );
  }

  const { emaFast, emaSlow, rsi, breakoutHigh, breakoutLow, trend } = indicators.indicators;

  const badges = [
    {
      label: "Signal",
      value: indicators.signal,
      className: "border " + signalTone(indicators.signal),
    },
    {
      label: "Trend",
      value: trend,
      className:
        "border " +
        (trend === "UP"
          ? "bg-bull/15 text-bull border-bull/40"
          : trend === "DOWN"
            ? "bg-bear/15 text-bear border-bear/40"
            : "bg-bg-raised text-ink-muted border-bg-border"),
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-3 py-2">
      {badges.map((b) => (
        <span key={b.label} className={"rounded-md px-2 py-1 text-xs font-medium " + b.className}>
          <span className="mr-1 opacity-60">{b.label}</span>
          {b.value}
        </span>
      ))}

      <span className="rounded-md border border-bg-border bg-bg-raised px-2 py-1 font-mono text-xs">
        <span className="mr-1 text-ink-faint">RSI</span>
        <span className={rsi === null ? "text-ink-faint" : rsiTone(rsi)}>
          {rsi === null ? "—" : rsi.toFixed(1)}
        </span>
      </span>

      <span className="rounded-md border border-bg-border bg-bg-raised px-2 py-1 font-mono text-xs text-ink-muted">
        <span className="mr-1 text-ink-faint">EMA</span>
        {emaFast === null ? "—" : emaFast.toFixed(2)} / {emaSlow === null ? "—" : emaSlow.toFixed(2)}
      </span>

      <span className="rounded-md border border-bg-border bg-bg-raised px-2 py-1 font-mono text-xs text-ink-muted">
        <span className="mr-1 text-ink-faint">Range</span>
        {breakoutLow === null ? "—" : breakoutLow.toFixed(2)} – {breakoutHigh === null ? "—" : breakoutHigh.toFixed(2)}
      </span>
    </div>
  );
}
