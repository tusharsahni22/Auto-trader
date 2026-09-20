import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, Candle, EngineState, Opportunity, PnlPoint, RegimeSnapshot, ScanInfo, Trade } from "./lib/types";
import {
  api,
  type AssetIndicators,
  type BalanceInfo,
  type BotDecision,
  type BotState,
  type BotStats,
  type EngineRole,
} from "./lib/api";
import { useSocket } from "./lib/useSocket";
import { bollingerOverlays, breakoutOverlay, emaOverlay, smaOverlay } from "./lib/indicators";
import type { ChartTimezone } from "./lib/chartTime";
import PriceChart, { type ChartOverlay, type PriceLevel, type TradeMarker } from "./components/PriceChart";
import ChartToolbar, { type PresetId, type Resolution } from "./components/ChartToolbar";
import PnlChart from "./components/PnlChart";
import StatCards from "./components/StatCards";
import EngineControls from "./components/EngineControls";
import Filters, { FilterState } from "./components/Filters";
import TradeList from "./components/TradeList";
import TradeDetail from "./components/TradeDetail";
import OpportunityFeed from "./components/OpportunityFeed";
import ActivityPanel from "./components/ActivityPanel";
import RegimeBadge from "./components/RegimeBadge";
import EngineHeartbeat from "./components/EngineHeartbeat";
import LivePriceTicker from "./components/LivePriceTicker";
import NewsCalendar from "./components/NewsCalendar";
import ManualTradeEntry from "./components/ManualTradeEntry";
import ChartDrawingTools from "./components/ChartDrawingTools";
import OpenPositions from "./components/OpenPositions";
import BotControl from "./components/BotControl";
import BotDecisionLog from "./components/BotDecisionLog";
import IndicatorBar from "./components/IndicatorBar";

const ASSETS: Asset[] = ["BTCUSDT", "ETHUSDT"];

const DEFAULT_PRESETS: Record<PresetId, boolean> = {
  ema9: true,
  ema21: true,
  ema200: false,
  sma: false,
  breakout: true,
  bollinger: false,
  tradeLevels: true,
  signals: true,
};

type BottomTab = "trades" | "bot" | "activity";

export default function App() {
  const [asset, setAsset] = useState<Asset>("BTCUSDT");
  const [resolution, setResolution] = useState<Resolution>("15m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candleSource, setCandleSource] = useState<string | null>(null);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [engineRole, setEngineRole] = useState<EngineRole | undefined>();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [equityCurve, setEquityCurve] = useState<PnlPoint[]>([]);
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [filters, setFilters] = useState<FilterState>({ asset: "", status: "", direction: "" });
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [regime, setRegime] = useState<RegimeSnapshot | null>(null);
  const [fundingRate, setFundingRate] = useState<number | null>(null);
  const [scans, setScans] = useState<Record<string, ScanInfo>>({});
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [drawnLevels, setDrawnLevels] = useState<PriceLevel[]>([]);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [bot, setBot] = useState<BotState | null>(null);
  const [botStats, setBotStats] = useState<BotStats | null>(null);
  const [botDecisions, setBotDecisions] = useState<BotDecision[]>([]);
  const [assetIndicators, setAssetIndicators] = useState<AssetIndicators[]>([]);
  const [presets, setPresets] = useState<Record<PresetId, boolean>>(DEFAULT_PRESETS);
  const [bottomTab, setBottomTab] = useState<BottomTab>("trades");
  const [showTools, setShowTools] = useState(false);
  // Remembered so the choice survives a reload.
  const [timezone, setTimezone] = useState<ChartTimezone>(
    () => (localStorage.getItem("chartTimezone") as ChartTimezone) ?? "local"
  );

  useEffect(() => {
    localStorage.setItem("chartTimezone", timezone);
  }, [timezone]);

  // Read inside the socket callback, which would otherwise close over stale candles.
  const candlesRef = useRef<Candle[]>([]);
  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  const refreshTrades = () => api.trades().then(setTrades).catch(() => {});

  const refreshBot = () => {
    api
      .botStatus()
      .then((r) => {
        setBot(r.bot);
        setBotStats(r.stats);
      })
      .catch(() => {});
    api.botDecisions(50).then((r) => setBotDecisions(r.decisions)).catch(() => {});
    api.botIndicators().then((r) => setAssetIndicators(r.indicators)).catch(() => {});
  };

  useEffect(() => {
    api.status().then((s) => {
      setEngine(s.engine);
      setEngineRole(s.role);
      const byAsset: Record<string, ScanInfo> = {};
      for (const s2 of s.scans ?? []) byAsset[s2.asset] = s2;
      setScans(byAsset);
    });
    refreshTrades();
    api.equityCurve().then(setEquityCurve);
    api.opportunities().then(setOpportunities);

    const refreshBalance = () => api.balance().then(setBalance).catch(() => {});
    const refreshSharedState = () => {
      api.status().then((s) => {
        setEngine(s.engine);
        setEngineRole(s.role);
      }).catch(() => {});
      refreshTrades();
      api.equityCurve().then(setEquityCurve).catch(() => {});
    };
    refreshBalance();
    const balanceId = setInterval(refreshBalance, 30_000);
    const stateId = setInterval(refreshSharedState, 10_000);

    refreshBot();
    const botId = setInterval(refreshBot, 20_000);

    return () => {
      clearInterval(balanceId);
      clearInterval(stateId);
      clearInterval(botId);
    };
  }, []);

  // Candles follow both the asset and the chosen timeframe.
  useEffect(() => {
    setCandles([]);
    setLiveCandle(null);
    setCandleSource(null);
    api
      .marketCandles(asset, resolution, 500)
      .then((r) => {
        setCandles(r.candles);
        setCandleSource(r.source);
        if (r.candles.length) setLastPrice(r.candles[r.candles.length - 1].close);
      })
      .catch(() => setCandleSource("unavailable"));
  }, [asset, resolution]);

  useEffect(() => {
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
        setLiveCandle((prev) => {
          // Rebase onto the newest bar whenever a refetch has moved past the one
          // we were tracking, otherwise the chart gets an out-of-order update.
          const latest = candlesRef.current[candlesRef.current.length - 1];
          if (!latest) return prev;
          const base = prev && prev.time >= latest.time ? prev : latest;
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
      if (event === "trade_closed") api.equityCurve().then(setEquityCurve);
    }
    if (event === "equity") {
      setEngine((prev) => (prev ? { ...prev, equity: (payload as { equity: number }).equity } : prev));
    }
    if (event === "opportunity") {
      setOpportunities((prev) => [payload as Opportunity, ...prev].slice(0, 100));
    }
    if (event === "bot_decision") {
      setBotDecisions((prev) => [payload as BotDecision, ...prev].slice(0, 50));
      api.botIndicators().then((r) => setAssetIndicators(r.indicators)).catch(() => {});
    }
    if (event === "bot_state") setBot(payload as BotState);
    if (event === "scan") {
      const s = payload as ScanInfo;
      setScans((prev) => ({ ...prev, [s.asset]: s }));
    }
  });

  // Keep the chart and regime fresh without disturbing zoom/pan.
  useEffect(() => {
    const id = setInterval(() => {
      api
        .marketCandles(asset, resolution, 500)
        .then((r) => {
          setCandles(r.candles);
          setCandleSource(r.source);
        })
        .catch(() => {});
      api.regime(asset).then((r) => {
        setRegime(r.regime);
        setFundingRate(r.fundingRate);
      });
    }, 15_000);
    return () => clearInterval(id);
  }, [asset, resolution]);

  // Hand-drawn levels are per-asset; clear them when the chart switches.
  useEffect(() => {
    setDrawnLevels([]);
  }, [asset]);

  const togglePreset = (id: PresetId) => setPresets((prev) => ({ ...prev, [id]: !prev[id] }));

  const overlays = useMemo<ChartOverlay[]>(() => {
    if (candles.length === 0) return [];
    const out: ChartOverlay[] = [];

    if (presets.ema9)
      out.push({ id: "ema9", label: "EMA 9", color: "#16c784", points: emaOverlay(candles, 9), lineWidth: 1 });
    if (presets.ema21)
      out.push({ id: "ema21", label: "EMA 21", color: "#f0b90b", points: emaOverlay(candles, 21), lineWidth: 1 });
    if (presets.ema200)
      out.push({ id: "ema200", label: "EMA 200", color: "#e5e7eb", points: emaOverlay(candles, 200), lineWidth: 1 });

    if (presets.sma) {
      out.push({ id: "sma50", label: "SMA 50", color: "#3d8bfd", points: smaOverlay(candles, 50), lineWidth: 1 });
      out.push({ id: "sma200", label: "SMA 200", color: "#a855f7", points: smaOverlay(candles, 200), lineWidth: 1 });
    }

    if (presets.breakout) {
      out.push({
        id: "breakoutHigh",
        label: "Breakout high (20)",
        color: "#ea3943",
        points: breakoutOverlay(candles, 20, "max"),
        lineStyle: "dashed",
        lineWidth: 1,
      });
      out.push({
        id: "breakoutLow",
        label: "Breakout low (20)",
        color: "#16c784",
        points: breakoutOverlay(candles, 20, "min"),
        lineStyle: "dashed",
        lineWidth: 1,
      });
    }

    if (presets.bollinger) {
      const { upper, lower } = bollingerOverlays(candles, 20, 2);
      out.push({
        id: "bbUpper",
        label: "Bollinger upper",
        color: "#22d3ee",
        points: upper,
        lineStyle: "dashed",
        lineWidth: 1,
      });
      out.push({
        id: "bbLower",
        label: "Bollinger lower",
        color: "#22d3ee",
        points: lower,
        lineStyle: "dashed",
        lineWidth: 1,
      });
    }

    return out;
  }, [candles, presets]);

  const chartMarkers = useMemo<TradeMarker[]>(() => {
    if (!presets.signals) return [];
    return trades
      .filter((t) => t.asset === asset)
      .flatMap((t) => {
        const marks: TradeMarker[] = [
          {
            time: Math.floor(t.entryTime / 1000),
            price: t.entryPrice,
            kind: t.direction === "LONG" ? "entry_long" : "entry_short",
          },
        ];
        if (t.exitTime && t.exitPrice !== null) {
          marks.push({ time: Math.floor(t.exitTime / 1000), price: t.exitPrice, kind: "exit" });
        }
        return marks;
      });
  }, [trades, asset, presets.signals]);

  const chartLevels = useMemo<PriceLevel[]>(() => {
    const levels: PriceLevel[] = [...drawnLevels];
    if (presets.tradeLevels && selectedTrade?.asset === asset && selectedTrade.status === "OPEN") {
      levels.push({ price: selectedTrade.stopPrice, kind: "stop_loss", label: "Stop" });
      selectedTrade.targets.forEach((t, i) =>
        levels.push({ price: t.price, kind: "take_profit", label: `T${i + 1}` })
      );
    }
    return levels;
  }, [drawnLevels, selectedTrade, asset, presets.tradeLevels]);

  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (filters.asset && t.asset !== filters.asset) return false;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.direction && t.direction !== filters.direction) return false;
      return true;
    });
  }, [trades, filters]);

  const activeTrade = selectedTrade ?? trades.find((t) => t.status === "OPEN") ?? null;

  const bottomTabs: { id: BottomTab; label: string; count: number }[] = [
    { id: "trades", label: "Trades", count: filteredTrades.length },
    { id: "bot", label: "Bot decisions", count: botDecisions.length },
    { id: "activity", label: "Activity", count: opportunities.length },
  ];

  return (
    <div className="mx-auto flex min-h-screen max-w-[1700px] flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-bg-border bg-bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-ink">
              Auto Trader <span className="text-accent">·</span> BTC / ETH
            </h1>
            <p className="text-[11px] text-ink-faint">
              Archetype engine + EMA/RSI signal bot · Delta Exchange
            </p>
          </div>
          <div className="flex items-center gap-1">
            {ASSETS.map((a) => (
              <button
                key={a}
                onClick={() => setAsset(a)}
                className={
                  "rounded-md px-3 py-1.5 text-sm font-semibold transition " +
                  (asset === a ? "bg-accent text-black" : "bg-bg-raised text-ink-muted hover:text-ink")
                }
              >
                {a.replace("USDT", "")}
              </button>
            ))}
          </div>
        </div>
          <EngineControls engine={engine} asset={asset} role={engineRole} />
      </header>

      <StatCards engine={engine} trades={trades} balance={balance} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        {/* Chart column */}
        <div className="flex flex-col gap-3 xl:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <LivePriceTicker price={lastPrice} asset={asset} />
            <RegimeBadge regime={regime} fundingRate={fundingRate} />
          </div>

          <IndicatorBar indicators={assetIndicators.find((i) => i.asset === asset) ?? null} />

          <ChartToolbar
            resolution={resolution}
            onResolutionChange={setResolution}
            active={presets}
            onToggle={togglePreset}
            onClearDrawings={() => setDrawnLevels([])}
            drawingCount={drawnLevels.length}
            timezone={timezone}
            onTimezoneChange={setTimezone}
            source={candleSource}
            candleCount={candles.length}
          />

          <div className="h-[460px] overflow-hidden rounded-lg border border-bg-border bg-bg-panel">
            {candles.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-ink-faint">
                {candleSource === "unavailable" ? "Candle data unavailable" : "Loading candles…"}
              </div>
            ) : (
              <PriceChart
                candles={candles}
                liveCandle={liveCandle}
                markers={chartMarkers}
                priceLevels={chartLevels}
                overlays={overlays}
                timezone={timezone}
              />
            )}
          </div>

          {/* Tools are collapsed by default — they're for acting, not watching,
              so they shouldn't push the chart and positions down. */}
          <button
            onClick={() => setShowTools((v) => !v)}
            className="self-start rounded-md border border-bg-border bg-bg-panel px-3 py-1.5 text-xs text-ink-muted transition hover:text-ink"
          >
            {showTools ? "Hide" : "Show"} drawing &amp; manual entry tools
          </button>

          {showTools && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <ChartDrawingTools
                currentPrice={lastPrice}
                levels={drawnLevels}
                onAddLevel={(level) => setDrawnLevels((prev) => [...prev, level])}
                onRemoveLevel={(index) => setDrawnLevels((prev) => prev.filter((_, i) => i !== index))}
                onClearLevels={() => setDrawnLevels([])}
              />
              <ManualTradeEntry
                asset={asset}
                currentPrice={lastPrice}
                levels={drawnLevels}
                onTradeOpened={(trade) => {
                  setTrades((prev) => [trade, ...prev.filter((t) => t.id !== trade.id)]);
                  setSelectedTrade(trade);
                }}
              />
            </div>
          )}

          <OpenPositions
            activeAsset={asset}
            onSelect={(id) => setSelectedTrade(trades.find((t) => t.id === id) ?? null)}
            onChanged={() => {
              refreshTrades();
              api.equityCurve().then(setEquityCurve);
            }}
          />

          <div className="flex flex-col gap-2">
            <div className="section-label">Equity curve</div>
            <div className="h-[200px] rounded-lg border border-bg-border bg-bg-panel">
              <PnlChart points={equityCurve} timezone={timezone} />
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <div className="section-label">Active trade</div>
            <TradeDetail trade={activeTrade} />
          </div>

          <BotControl bot={bot} stats={botStats} onChanged={refreshBot} />

          <EngineHeartbeat scan={scans[asset] ?? null} />

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="section-label">Opportunities</div>
              <span className="text-[11px] text-ink-faint">{opportunities.length}</span>
            </div>
            <div className="h-[260px]">
              <OpportunityFeed opportunities={opportunities} />
            </div>
          </div>

          <NewsCalendar hoursAhead={48} assets={[asset.replace("USDT", "")]} />

          <div className="flex flex-col gap-2">
            <div className="section-label">Filters</div>
            <Filters value={filters} onChange={setFilters} />
          </div>
        </div>
      </div>

      {/* One tabbed strip instead of three stacked lists — the page ends at a
          predictable height regardless of how much history has accumulated. */}
      <div className="panel flex flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-bg-border px-2 py-1.5">
          {bottomTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setBottomTab(t.id)}
              className={
                "flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition " +
                (bottomTab === t.id
                  ? "border border-bg-border bg-bg-raised text-ink"
                  : "border border-transparent text-ink-faint hover:text-ink-muted")
              }
            >
              {t.label}
              <span className="text-[10px] font-normal text-ink-faint">{t.count}</span>
            </button>
          ))}
        </div>

        <div className="max-h-[420px] overflow-auto">
          {bottomTab === "trades" && (
            <TradeList trades={filteredTrades} onSelect={setSelectedTrade} selectedId={selectedTrade?.id} />
          )}
          {bottomTab === "bot" && <BotDecisionLog decisions={botDecisions} />}
          {bottomTab === "activity" && <ActivityPanel active={bottomTab === "activity"} />}
        </div>
      </div>
    </div>
  );
}
