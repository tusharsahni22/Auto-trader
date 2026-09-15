import { useEffect, useRef } from "react";
import { CandlestickData, ColorType, createChart, IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { Candle } from "../lib/types";

interface Props {
  candles: Candle[];
  liveCandle: Candle | null;
  markers?: { time: number; price: number; kind: "entry" | "exit" | "stop" | "target"; label: string }[];
}

const RECENT_BARS_VISIBLE = 96; // ~24h at 15m — enough to actually see live price movement, unlike fitContent's multi-day view

export default function PriceChart({ candles, liveCandle }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const wasEmptyRef = useRef(true);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#11151d" },
        textColor: "#8b93a7",
        fontFamily: "ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "#1a2029" },
        horzLines: { color: "#1a2029" },
      },
      rightPriceScale: { borderColor: "#232936" },
      timeScale: { borderColor: "#232936", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    const data: CandlestickData[] = candles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    seriesRef.current.setData(data);
    // Only auto-scroll to the recent window on a fresh load (mount, or asset
    // switch — both go through an empty `candles` first). Once the user has
    // data on screen, periodic refetches shouldn't yank their zoom/pan back.
    if (wasEmptyRef.current) {
      const from = Math.max(0, data.length - RECENT_BARS_VISIBLE);
      chartRef.current?.timeScale().setVisibleLogicalRange({ from, to: data.length - 1 + 2 });
      wasEmptyRef.current = false;
    }
  }, [candles]);

  useEffect(() => {
    if (candles.length === 0) wasEmptyRef.current = true;
  }, [candles.length]);

  useEffect(() => {
    if (!seriesRef.current || !liveCandle) return;
    seriesRef.current.update({
      time: liveCandle.time as Time,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
    });
  }, [liveCandle]);

  return <div ref={containerRef} className="h-full w-full" />;
}
