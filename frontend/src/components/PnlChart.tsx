import { useEffect, useRef } from "react";
import { AreaData, ColorType, createChart, IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { PnlPoint } from "../lib/types";

interface Props {
  points: PnlPoint[];
}

export default function PnlChart({ points }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

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
      autoSize: true,
    });
    const series = chart.addAreaSeries({
      lineColor: "#3d8bfd",
      topColor: "rgba(61,139,253,0.35)",
      bottomColor: "rgba(61,139,253,0.02)",
      lineWidth: 2,
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
    if (!seriesRef.current) return;
    const data: AreaData[] = points.map((p) => ({ time: p.time as Time, value: p.equity }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} className="h-full w-full" />;
}
