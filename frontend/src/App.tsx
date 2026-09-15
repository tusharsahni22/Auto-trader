import { useEffect, useMemo, useState } from "react";
import type { Asset, Candle, EngineState, Opportunity, PnlPoint, RegimeSnapshot, ScanInfo, Trade } from "./lib/types";
import { api } from "./lib/api";
import { useSocket } from "./lib/useSocket";
import PriceChart from "./components/PriceChart";
import PnlChart from "./components/PnlChart";
import StatCards from "./components/StatCards";
import EngineControls from "./components/EngineControls";
import Filters, { FilterState } from "./components/Filters";
import TradeList from "./components/TradeList";
import TradeDetail from "./components/TradeDetail";
import OpportunityFeed from "./components/OpportunityFeed";
import RegimeBadge from "./components/RegimeBadge";
import EngineHeartbeat from "./components/EngineHeartbeat";
import LivePriceTicker from "./components/LivePriceTicker";

const ASSETS: Asset[] = ["BTCUSDT", "ETHUSDT"];

export default function App() {
  const [asset, setAsset] = useState<Asset>("BTCUSDT");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [equityCurve, setEquityCurve] = useState<PnlPoint[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [filters, setFilters] = useState<FilterState>({ asset: "", status: "", direction: "" });
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [regime, setRegime] = useState<RegimeSnapshot | null>(null);
  const [fundingRate, setFundingRate] = useState<number | null>(null);
  const [scans, setScans] = useState<Record<string, ScanInfo>>({});
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  useEffect(() => {
    api.status().then((s) => {
      setEngine(s.engine);
      const byAsset: Record<string, ScanInfo> = {};
      for (const s2 of s.scans ?? []) byAsset[s2.asset] = s2;
      setScans(byAsset);
    });
    api.trades().then(setTrades);
    api.equityCurve().then(setEquityCurve);
    api.opportunities().then(setOpportunities);
  }, []);

  useEffect(() => {
    setCandles([]);
    setLiveCandle(null);
    setLastPrice(null);
    api.candles(asset).then((c) => {
      setCandles(c);
      if (c.length) setLastPrice(c[c.length - 1].close);
    });
    api.regime(asset).then((r) => {
      setRegime(r.regime);
      setFundingRate(r.fundingRate);
    });
  }, [asset]);

  useSocket((event, payload) => {
    if (event === "engine_state") setEngine(payload as EngineState);
    if (event === "price") {
      const p = payload as { asset: Asset; price: number; time: number };
      if (p.asset === asset) {
        setLastPrice(p.price);
        // lightweight candle nudge; full candle detail comes from periodic refetch
        setLiveCandle((prev) => {
          const base = prev ?? candles[candles.length - 1];
          if (!base) return prev;
          return { ...base, close: p.price, high: Math.max(base.high, p.price), low: Math.min(base.low, p.price) };
        });
      }
    }
    if (event === "trade_opened" || event === "trade_closed" || event === "trade_updated") {
      const t = payload as Trade;
      setTrades((prev) => {
        const idx = prev.findIndex((x) => x.id === t.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = t;
          return next;
        }
        return [t, ...prev];
      });
      setSelectedTrade((prev) => (prev && prev.id === t.id ? t : prev));
      if (event === "trade_closed") {
        api.equityCurve().then(setEquityCurve);
      }
    }
    if (event === "equity") {
      setEngine((prev) => (prev ? { ...prev, equity: (payload as { equity: number }).equity } : prev));
    }
    if (event === "opportunity") {
      const o = payload as Opportunity;
      setOpportunities((prev) => [o, ...prev].slice(0, 100));
    }
    if (event === "scan") {
      const s = payload as ScanInfo;
      setScans((prev) => ({ ...prev, [s.asset]: s }));
    }
  });

  // refetch candles + regime periodically to keep the chart and regime badge accurate
  useEffect(() => {
    const id = setInterval(() => {
      api.candles(asset).then(setCandles);
      api.regime(asset).then((r) => {
        setRegime(r.regime);
        setFundingRate(r.fundingRate);
      });
    }, 15000);
    return () => clearInterval(id);
  }, [asset]);

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (filters.asset && t.asset !== filters.asset) return false;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.direction && t.direction !== filters.direction) return false;
      return true;
    });
  }, [trades, filters]);

  return (
    <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Auto Trader — BTC/ETH Opportunity Engine</h1>
          <p className="text-xs text-ink-faint">Paper trading · live data via Binance · regime + archetype decision engine</p>
        </div>
        <EngineControls engine={engine} asset={asset} />
      </header>

      <StatCards engine={engine} trades={trades} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-2 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {ASSETS.map((a) => (
                <button
                  key={a}
                  onClick={() => setAsset(a)}
                  className={
                    "rounded-md px-3 py-1.5 text-sm font-medium transition " +
                    (asset === a ? "bg-accent text-white" : "bg-bg-raised text-ink-muted hover:text-ink")
                  }
                >
                  {a.replace("USDT", "")}
                </button>
              ))}
            </div>
            <RegimeBadge regime={regime} fundingRate={fundingRate} />
          </div>
          <LivePriceTicker price={lastPrice} asset={asset} />
          <EngineHeartbeat scan={scans[asset] ?? null} />
          <div className="h-[380px] rounded-lg border border-bg-border bg-bg-panel">
            <PriceChart candles={candles} liveCandle={liveCandle} />
          </div>
          <div className="text-xs uppercase tracking-wide text-ink-faint">Equity curve</div>
          <div className="h-[220px] rounded-lg border border-bg-border bg-bg-panel">
            <PnlChart points={equityCurve} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs uppercase tracking-wide text-ink-faint">Trade detail</div>
          <div className="h-[420px]">
            <TradeDetail trade={selectedTrade} />
          </div>
          <div className="text-xs uppercase tracking-wide text-ink-faint">Filters</div>
          <Filters value={filters} onChange={setFilters} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-2 lg:col-span-2">
          <div className="text-xs uppercase tracking-wide text-ink-faint">
            Trades ({filteredTrades.length})
          </div>
          <div className="max-h-[420px] overflow-auto">
            <TradeList trades={filteredTrades} onSelect={setSelectedTrade} selectedId={selectedTrade?.id} />
          </div>
        </div>
        <div className="h-[460px]">
          <OpportunityFeed opportunities={opportunities} />
        </div>
      </div>
    </div>
  );
}
