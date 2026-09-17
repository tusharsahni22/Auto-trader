import { useEffect, useRef } from "react";
import {
  CandlestickData,
  ColorType,
  createChart,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineData,
  LineStyle,
  SeriesMarker,
  Time,
} from "lightweight-charts";
import type { Candle } from "../lib/types";
import type { OverlayPoint } from "../lib/indicators";
import { makeCrosshairFormatter, makeTickFormatter, type ChartTimezone } from "../lib/chartTime";

export interface TradeMarker {
  time: number;
  price: number;
  kind: "entry_long" | "entry_short" | "exit" | "stop" | "target" | "setup_detected";
  label?: string;
  color?: string;
}

export interface PriceLevel {
  price: number;
  kind: "stop_loss" | "take_profit" | "support" | "resistance";
  color?: string;
  label?: string;
}

export interface ChartOverlay {
  id: string;
  label: string;
  color: string;
  points: OverlayPoint[];
  lineStyle?: "solid" | "dashed";
  lineWidth?: 1 | 2;
}

interface Props {
  candles: Candle[];
  liveCandle: Candle | null;
  markers?: TradeMarker[];
  priceLevels?: PriceLevel[];
  overlays?: ChartOverlay[];
  showSetupSignals?: boolean;
  timezone?: ChartTimezone;
}

const RECENT_BARS_VISIBLE = 96;

export default function PriceChart({
  candles,
  liveCandle,
  markers = [],
  priceLevels = [],
  overlays = [],
  showSetupSignals = true,
  timezone = "local",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLineRefs = useRef<IPriceLine[]>([]);
  const overlayRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const lastBarTimeRef = useRef<number | null>(null);
  const wasEmptyRef = useRef(true);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0b0d10" },
        textColor: "#93a1ad",
        fontFamily: "ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "#141a21" },
        horzLines: { color: "#141a21" },
      },
      rightPriceScale: { borderColor: "#1e242c" },
      timeScale: {
        borderColor: "#1e242c",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: makeTickFormatter(timezone),
      },
      localization: { timeFormatter: makeCrosshairFormatter(timezone) },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#16c784",
      downColor: "#ea3943",
      borderVisible: false,
      wickUpColor: "#16c784",
      wickDownColor: "#ea3943",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLineRefs.current = [];
      overlayRefs.current.clear();
      lastBarTimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { tickMarkFormatter: makeTickFormatter(timezone) },
      localization: { timeFormatter: makeCrosshairFormatter(timezone) },
    });
  }, [timezone]);

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
    lastBarTimeRef.current = candles[candles.length - 1].time;
    // Only auto-scroll to the recent window on a fresh load (mount, asset or
    // timeframe switch — all go through an empty `candles` first). Once data is
    // on screen, periodic refetches shouldn't yank the user's zoom/pan back.
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
    // lightweight-charts throws if update() is handed a bar older than the last
    // one in the series, which takes down the whole dashboard. A live tick that
    // lags a candle refetch is normal, so drop it rather than crash.
    if (lastBarTimeRef.current !== null && liveCandle.time < lastBarTimeRef.current) return;
    seriesRef.current.update({
      time: liveCandle.time as Time,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
    });
    lastBarTimeRef.current = liveCandle.time;
  }, [liveCandle]);

  // Indicator overlays (EMA/SMA lines, breakout bands)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const wanted = new Set(overlays.map((o) => o.id));
    for (const [id, series] of overlayRefs.current) {
      if (!wanted.has(id)) {
        chart.removeSeries(series);
        overlayRefs.current.delete(id);
      }
    }

    for (const overlay of overlays) {
      let series = overlayRefs.current.get(overlay.id);
      if (!series) {
        series = chart.addLineSeries({
          color: overlay.color,
          lineWidth: overlay.lineWidth ?? 2,
          lineStyle: overlay.lineStyle === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        overlayRefs.current.set(overlay.id, series);
      }
      series.setData(
        overlay.points.map((p) => ({ time: p.time as Time, value: p.value })) as LineData[]
      );
    }
  }, [overlays]);

  useEffect(() => {
    if (!seriesRef.current) return;

    const chartMarkersWithTime = markers.map((m) => {
      let position: "aboveBar" | "belowBar" = "aboveBar";
      let color = "#16c784";
      let shape: "arrowUp" | "arrowDown" | "circle" | "square" = "circle";
      let text = m.label || "";

      switch (m.kind) {
        case "entry_long":
          position = "belowBar";
          color = "#16c784";
          shape = "arrowUp";
          text = text || "LONG";
          break;
        case "entry_short":
          position = "aboveBar";
          color = "#ea3943";
          shape = "arrowDown";
          text = text || "SHORT";
          break;
        case "exit":
          color = "#f0b90b";
          shape = "circle";
          text = text || "EXIT";
          break;
        case "stop":
          position = "belowBar";
          color = "#ea3943";
          shape = "arrowDown";
          text = text || "STOP";
          break;
        case "target":
          position = "aboveBar";
          color = "#16c784";
          shape = "circle";
          text = text || "TARGET";
          break;
        case "setup_detected":
          color = "#f0b90b";
          shape = "circle";
          text = text || "SETUP";
          break;
      }

      return { sourceTime: m.time, time: m.time as Time, position, color: m.color || color, shape, text };
    });

    // lightweight-charts requires markers to be strictly ordered by time. Trade
    // events can arrive newest-first and several events can share one candle, so
    // sort them and keep the first marker for each candle timestamp.
    chartMarkersWithTime.sort((a, b) => a.sourceTime - b.sourceTime);
    const seenTimes = new Set<number>();
    const chartMarkers: SeriesMarker<Time>[] = chartMarkersWithTime.filter((marker) => {
      if (seenTimes.has(marker.sourceTime)) return false;
      seenTimes.add(marker.sourceTime);
      return true;
    }).map(({ sourceTime: _sourceTime, ...marker }) => marker);

    seriesRef.current.setMarkers(chartMarkers);
  }, [markers]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of priceLineRefs.current) series.removePriceLine(line);
    priceLineRefs.current = [];

    priceLevels.forEach((level) => {
      let color = "#93a1ad";
      let lineStyle = LineStyle.Dashed;

      switch (level.kind) {
        case "stop_loss":
          color = "#ea3943";
          lineStyle = LineStyle.Solid;
          break;
        case "take_profit":
          color = "#16c784";
          lineStyle = LineStyle.Solid;
          break;
        case "support":
          color = "#16c784";
          lineStyle = LineStyle.Dashed;
          break;
        case "resistance":
          color = "#ea3943";
          lineStyle = LineStyle.Dashed;
          break;
      }

      priceLineRefs.current.push(
        series.createPriceLine({
          price: level.price,
          color: level.color || color,
          lineWidth: 2,
          lineStyle,
          axisLabelVisible: true,
          title: level.label || level.kind.toUpperCase(),
        })
      );
    });
  }, [priceLevels]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {overlays.length > 0 && (
        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1">
          {overlays.map((o) => (
            <span key={o.id} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: o.color }} />
              {o.label}
            </span>
          ))}
        </div>
      )}

      {showSetupSignals && markers.some((m) => m.kind === "setup_detected") && (
        <div className="absolute right-3 top-3 rounded-md border border-warn/50 bg-warn/15 px-3 py-1.5 text-xs font-medium text-warn backdrop-blur-sm">
          Setup detected
        </div>
      )}
    </div>
  );
}
