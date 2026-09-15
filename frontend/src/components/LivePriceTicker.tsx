import { useEffect, useRef, useState } from "react";

/**
 * The candlestick chart updates once per 15m bar and is a poor way to prove
 * liveness to a human eye — most of a 15m candle's life it just looks
 * static. This is a large, twitchy readout that visibly changes on every
 * tick so there is no ambiguity about whether data is flowing.
 */
export default function LivePriceTicker({ price, asset }: { price: number | null; asset: string }) {
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const prevPrice = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (price === null) return;
    if (prevPrice.current !== null && price !== prevPrice.current) {
      setFlash(price > prevPrice.current ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 400);
      prevPrice.current = price;
      setLastUpdate(Date.now());
      return () => clearTimeout(t);
    }
    prevPrice.current = price;
    setLastUpdate(Date.now());
  }, [price]);

  const secsAgo = lastUpdate ? Math.max(0, Math.floor((Date.now() - lastUpdate) / 1000)) : null;
  const stale = secsAgo !== null && secsAgo > 20;

  return (
    <div className="flex items-baseline gap-2">
      <span className={"h-2 w-2 rounded-full " + (stale ? "bg-bear" : "bg-bull animate-pulse")} />
      <span
        className={
          "font-mono text-2xl font-semibold tabular-nums transition-colors duration-300 " +
          (flash === "up" ? "text-bull" : flash === "down" ? "text-bear" : "text-ink")
        }
      >
        {price !== null ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
      </span>
      <span className="text-xs text-ink-faint">
        {asset.replace("USDT", "")} · {secsAgo !== null ? `updated ${secsAgo}s ago` : "waiting for first tick"}
      </span>
    </div>
  );
}
