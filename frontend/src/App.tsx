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
  type LedgerHealth,
  type LiveTradingStatus,
  type StopBlocker,
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
import AnalyticsProgress from "./components/AnalyticsProgress";
import OrderHistory from "./components/OrderHistory";
import TrainingMonitor from "./components/TrainingMonitor";
import SystemStatus from "./components/SystemStatus";

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

type BottomTab = "orders" | "trades" | "training" | "bot" | "activity" | "research";

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
  const [bottomTab, setBottomTab] = useState<BottomTab>("orders");
  const [showTools, setShowTools] = useState(false);
  const [live, setLive] = useState<LiveTradingStatus | undefined>();
  const [ledger, setLedger] = useState<LedgerHealth | undefined>();
  const [serverBlockers, setServerBlockers] = useState<StopBlocker[]>([]);
  /** Bumped when a trade opens or closes so the analytics panels refetch at once. */
  const [analyticsKey, setAnalyticsKey] = useState(0);
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

  const refreshTrades = () => api.trades().then((t) => setTrades(t || [])).catch(() => {});

  const refreshBot = () => {
    api
      .botStatus()
      .then((r) => {
        if (!r) return;
        setBot(r.bot);
        setBotStats(r.stats);
      })
      .catch(() => {});
    api.botDecisions(50).then((r) => setBotDecisions(r?.decisions || [])).catch(() => {});
    api.botIndicators().then((r) => setAssetIndicators(r?.indicators || [])).catch(() => {});
  };

  useEffect(() => {
    api.status().then((s) => {
      if (!s) return;
      setEngine(s.engine);
      setEngineRole(s.role);
      setLive(s.live);
      setLedger(s.ledger);
      setServerBlockers(s.stopBlockers ?? []);
      const byAsset: Record<string, ScanInfo> = {};
      for (const s2 of s.scans ?? []) byAsset[s2.asset] = s2;
      setScans(byAsset);
    }).catch(() => {});
    refreshTrades();
    api.equityCurve().then((t) => setEquityCurve(t || [])).catch(() => {});
    api.opportunities().then((t) => setOpportunities(t || [])).catch(() => {});

    const refreshBalance = () => api.balance().then(setBalance).catch(() => {});
    const refreshSharedState = () => {
      api.status().then((s) => {
        if (!s) return;
        setEngine(s.engine);
        setEngineRole(s.role);
        setLive(s.live);
        setLedger(s.ledger);
        setServerBlockers(s.stopBlockers ?? []);
      }).catch(() => {});
      refreshTrades();
      api.equityCurve().then((t) => setEquityCurve(t || [])).catch(() => {});
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
        if (!r) return;
        setCandles(r.candles);
        setCandleSource(r.source);
        if (r.candles.length) setLastPrice(r.candles[r.candles.length - 1].close);
      })
      .catch(() => setCandleSource("unavailable"));
  }, [asset, resolution]);

  useEffect(() => {
    api.regime(asset).then((r) => {
      if (!r) return;
      setRegime(r.regime);
      setFundingRate(r.fundingRate);
    }).catch(() => {});
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
      if (event === "trade_closed") api.equityCurve().then((t) => setEquityCurve(t || [])).catch(() => {});
      // P&L, win rate, order history and the training monitor all change on any
      // trade event, so refresh them together instead of waiting for their polls.
      setAnalyticsKey((k) => k + 1);
    }
    if (event === "equity") {
      setEngine((prev) => (prev ? { ...prev, equity: (payload as { equity: number }).equity } : prev));
    }
    if (event === "opportunity") {
      setOpportunities((prev) => [payload as Opportunity, ...prev].slice(0, 100));
    }
    if (event === "bot_decision") {
      setBotDecisions((prev) => [payload as BotDecision, ...prev].slice(0, 50));
      api.botIndicators().then((r) => setAssetIndicators(r?.indicators || [])).catch(() => {});
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
          if (!r) return;
          setCandles(r.candles);
          setCandleSource(r.source);
        })
        .catch(() => {});
      api.regime(asset).then((r) => {
        if (!r) return;
        setRegime(r.regime);
        setFundingRate(r.fundingRate);
      }).catch(() => {});
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

  // Open trades come from the live trade list, so the lock engages the instant a trade
  // opens and releases the instant it closes, rather than on the next status poll. The
  // other two kinds (a failed exchange close, a Delta position nothing manages) exist
  // only server-side, so they are taken from /api/status.
  const stopBlockers = useMemo<StopBlocker[]>(
    () => [
      ...trades
        .filter((t) => t.status === "OPEN")
        .map((t): StopBlocker => ({ kind: "OPEN_TRADE", detail: `${t.direction} ${t.asset.replace("USDT", "")} is open` })),
      ...serverBlockers.filter((x) => x.kind !== "OPEN_TRADE"),
    ],
    [trades, serverBlockers]
  );

  const bottomTabs: { id: BottomTab; label: string; count: number }[] = [
    { id: "orders", label: "Order history", count: trades.length },
    { id: "trades", label: "Trades", count: filteredTrades.length },
    { id: "training", label: "Training monitor", count: 0 },
    { id: "bot", label: "Bot decisions", count: botDecisions.length },
    { id: "activity", label: "Activity", count: opportunities.length },
    { id: "research", label: "Research", count: 0 },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1700px] flex-col gap-3 p-2 sm:gap-4 sm:p-4">
      <header className="flex flex-col gap-3 rounded-lg border border-bg-border bg-bg-panel px-3 py-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:px-4">
        <div className="flex items-center justify-between gap-3 sm:flex-wrap sm:justify-start sm:gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight text-ink">
              Auto Trader <span className="text-accent">·</span> BTC / ETH
            </h1>
            <p className="hidden text-[11px] text-ink-faint sm:block">
              Archetype engine + EMA/RSI signal bot · Delta Exchange
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
        <EngineControls engine={engine} asset={asset} role={engineRole} live={live} stopBlockers={stopBlockers} />
      </header>

      <SystemStatus live={live} ledger={ledger} />

      {/* Open positions sit above everything else: an open position is the only
          thing on this page that is currently costing or making money. */}
      <OpenPositions
        activeAsset={asset}
        onSelect={(id) => setSelectedTrade(trades.find((t) => t.id === id) ?? null)}
        onChanged={() => {
          refreshTrades();
          api.equityCurve().then((t) => setEquityCurve(t || [])).catch(() => {});
          setAnalyticsKey((k) => k + 1);
        }}
      />

      <StatCards engine={engine} trades={trades} balance={balance} />

      <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-4">
        {/* Chart column */}
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-3">
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

          <div className="h-[300px] overflow-hidden rounded-lg border border-bg-border bg-bg-panel sm:h-[400px] lg:h-[460px]">
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

          {/* Fixed height equity curve to prevent infinite height expansion loop with grid */}
          <div className="flex flex-col gap-2">
            <div className="section-label">Equity curve</div>
            <div className="h-[200px] rounded-lg border border-bg-border bg-bg-panel">
              <PnlChart points={equityCurve} timezone={timezone} />
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-2">
            <div className="section-label">Active trade</div>
            {/* Capped so one trade with a long exit plan cannot make this column
                taller than the chart and reintroduce a blank hole under it. */}
            <div className="max-h-[560px] overflow-auto rounded-lg">
              <TradeDetail trade={activeTrade} />
            </div>
          </div>

          <BotControl bot={bot} stats={botStats} onChanged={refreshBot} />

          <EngineHeartbeat scan={scans[asset] ?? null} />

          <div className="flex flex-col gap-2 xl:flex-1">
            <div className="flex items-center justify-between">
              <div className="section-label">Opportunities</div>
              <span className="text-[11px] text-ink-faint">{opportunities.length}</span>
            </div>
            <div className="h-[260px] xl:h-full xl:min-h-[260px]">
              <OpportunityFeed opportunities={opportunities} />
            </div>
          </div>
        </div>
      </div>

      {/* Headlines and the scheduled macro calendar answer different questions, so they
          are separate panels. They used to sit in the sidebar, which made it ~600px
          taller than the chart column and left a blank hole under the equity curve. */}
      <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2">
        <NewsCalendar mode="news" hoursAhead={48} assets={[asset.replace("USDT", "")]} />
        <NewsCalendar mode="calendar" hoursAhead={72} assets={[asset.replace("USDT", "")]} />
      </div>

      <AnalyticsProgress refreshKey={analyticsKey} />

      {/* One tabbed strip instead of three stacked lists — the page ends at a
          predictable height regardless of how much history has accumulated. */}
      <div className="panel flex flex-col overflow-hidden">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-bg-border px-2 py-1.5">
          {bottomTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setBottomTab(t.id)}
              className={
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition sm:py-1 " +
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

        <div className="overflow-auto sm:max-h-[520px]">
          {bottomTab === "orders" && <OrderHistory refreshKey={analyticsKey} />}
          {bottomTab === "training" && <TrainingMonitor refreshKey={analyticsKey} />}
          {bottomTab === "trades" && (
            <>
              <div className="border-b border-bg-border px-3 py-2">
                <Filters value={filters} onChange={setFilters} />
              </div>
              <TradeList trades={filteredTrades} onSelect={setSelectedTrade} selectedId={selectedTrade?.id} />
            </>
          )}
          {bottomTab === "bot" && <BotDecisionLog decisions={botDecisions} />}
          {bottomTab === "activity" && <ActivityPanel active={bottomTab === "activity"} />}
          {bottomTab === "research" && (
            <iframe title="Strategy research dashboard" src="/api/research/dashboard" className="h-[600px] w-full border-0 sm:h-[820px]" />
          )}
        </div>
      </div>
    </div>
  );
}
