import type { BotDecision } from "../lib/api";

function signalClass(signal: BotDecision["signal"]) {
  if (signal === "BUY") return "text-bull";
  if (signal === "SELL") return "text-bear";
  return "text-ink-muted";
}

interface Props {
  decisions: BotDecision[];
}

export default function BotDecisionLog({ decisions }: Props) {
  if (decisions.length === 0) {
    return (
      <div className="rounded-lg border border-bg-border bg-bg-panel p-4 text-xs text-ink-faint">
        No bot decisions yet — start the bot or run it once.
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-bg-border bg-bg-panel">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-bg-panel text-ink-faint">
          <tr className="border-b border-bg-border">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Asset</th>
            <th className="px-3 py-2 font-medium">Signal</th>
            <th className="px-3 py-2 font-medium">Conf.</th>
            <th className="px-3 py-2 font-medium">RSI</th>
            <th className="px-3 py-2 font-medium">Price</th>
            <th className="px-3 py-2 font-medium">Reasons</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d) => (
            <tr key={d.id} className="border-b border-bg-border/50 align-top">
              <td className="whitespace-nowrap px-3 py-2 font-mono text-ink-muted">
                {new Date(d.time).toLocaleTimeString()}
              </td>
              <td className="px-3 py-2 text-ink">{d.asset.replace("USDT", "")}</td>
              <td className={"px-3 py-2 font-medium " + signalClass(d.signal)}>
                {d.signal}
                {d.executed && <span className="ml-1 text-ink-faint">· filled</span>}
                {d.executionError && <span className="ml-1 text-bear">· {d.executionError}</span>}
              </td>
              <td className="px-3 py-2 font-mono text-ink-muted">{(d.confidence * 100).toFixed(0)}%</td>
              <td className="px-3 py-2 font-mono text-ink-muted">
                {d.indicators.rsi === null ? "—" : d.indicators.rsi.toFixed(1)}
              </td>
              <td className="px-3 py-2 font-mono text-ink-muted">{d.indicators.price.toFixed(2)}</td>
              <td className="px-3 py-2 text-ink-faint">{d.reasons.join(" · ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
