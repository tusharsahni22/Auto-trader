import type { ActivityData, DayDetail, Asset, Candle, Direction, EngineState, Opportunity, PnlPoint, RegimeSnapshot, ScanInfo, Trade } from "./types";

export type BotSignal = "BUY" | "SELL" | "HOLD";

export interface IndicatorSnapshot {
  price: number;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  breakoutHigh: number | null;
  breakoutLow: number | null;
  trend: "UP" | "DOWN" | "FLAT";
}

export interface BotDecision {
  id: string;
  asset: Asset;
  time: number;
  signal: BotSignal;
  confidence: number;
  reasons: string[];
  indicators: IndicatorSnapshot;
  executed: boolean;
  executionError?: string;
  tradeId?: string;
}

export interface BotStrategyConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  breakoutLookback: number;
}

export interface BotConfig {
  intervalMs: number;
  autoExecute: boolean;
  riskPerTrade: number;
  stopLossPct: number;
  takeProfitPct: number;
  strategy: BotStrategyConfig;
}

export interface BotState {
  running: boolean;
  startedAt: number | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  config: BotConfig;
}

export interface BotStats {
  totalDecisions: number;
  counts: Record<BotSignal, number>;
  executed: number;
  avgConfidence: number;
  lastRunAt: number | null;
  running: boolean;
}

export interface AssetIndicators {
  asset: Asset;
  signal: BotSignal;
  indicators: IndicatorSnapshot | null;
}

export interface Position {
  id: string;
  symbol: Asset;
  side: "LONG" | "SHORT";
  size: number;
  entry: number;
  mark: number;
  unrealized: number;
  pnlPct: number;
  sl: number;
  tps: number[];
  entryTime: number;
  reason: string;
  rMultiple: number;
  execution?: {
    venue: "SIMULATED" | "DELTA";
    status: string;
    orderId?: string;
    contracts?: number;
    avgFillPrice?: number;
    requestedPrice?: number;
    priceShift?: number;
    error?: string;
  };
}

export interface NewsBlackout {
  active: boolean;
  minutes: number;
  event?: { title: string; eventTime: string; minutesAway: number };
}

export interface TradeStats {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number;
  /** After exchange fees, GST and TDS. */
  netPnlUsd: number;
  grossPnlUsd: number;
  chargesUsd: number;
  avgRMultiple: number;
  profitFactor: number | null;
}

export interface BalanceInfo {
  equity: number;
  walletBalance?: number;
  availableBalance?: number;
  unrealizedPnl?: number;
  positionMargin?: number;
  assetSymbol?: string;
  fetchedAt?: number;
  source: "delta_exchange" | "simulated";
  deltaConfigured: boolean;
  error?: string;
}

export interface EngineRole {
  instanceId: string;
  leaderId: string;
  isLeader: boolean;
  mongoConnected: boolean;
}

/** Why orders are or are not reaching Delta. Empty `blockers` means they are. */
export interface LiveTradingStatus {
  enabled: boolean;
  liveTradingFlag: boolean;
  credentialsConfigured: boolean;
  mode: "LIVE" | "SIMULATED";
  entryOrderType: "LIMIT" | "MARKET";
  limitOrderTimeoutMs: number | null;
  blockers: string[];
  note: string;
}

/** Something ongoing that makes switching the engine off unsafe. */
export interface StopBlocker {
  kind: "OPEN_TRADE" | "CLOSE_FAILED" | "UNMANAGED_POSITION";
  detail: string;
}

/** Ledger health. `pendingSync > 0` means rows exist here but not yet in MongoDB. */
export interface LedgerHealth {
  trades: number;
  remoteTrades: number | null;
  mongoConnected: boolean;
  file: string;
  lastPersistError: string | null;
  error: string | null;
  pendingSync: number | null;
}

export interface SideCharges {
  notionalUsd: number;
  feeUsd: number;
  gstUsd: number;
  tdsUsd: number;
  totalUsd: number;
  liquidity: "taker" | "maker";
  fromExchange: boolean;
}

export interface TradeCharges {
  entry: SideCharges;
  exit: SideCharges;
  totalUsd: number;
  totalInr: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  incomeTaxProvisionUsd: number;
  afterTaxPnlUsd: number;
  rates: {
    takerFeeRate: number;
    makerFeeRate: number;
    gstRate: number;
    tdsRate: number;
    incomeTaxRate: number;
    cessRate: number;
    effectiveIncomeTaxRate: number;
    usdInr: number;
  };
  estimated: boolean;
}

export interface AnalyticsSummary {
  performance: {
    totalTrades: number;
    openTrades: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    netPnlUsd: number;
    grossPnlUsd: number;
    totalChargesUsd: number;
    avgWinUsd: number;
    avgLossUsd: number;
    bestTradeUsd: number;
    worstTradeUsd: number;
    profitFactor: number | null;
    avgRMultiple: number;
    expectancyUsd: number;
    todayNetUsd: number;
    monthNetUsd: number;
    unrealizedNetUsd: number;
  };
  openPositions: { id: string; asset: Asset; unrealizedNetUsd: number; mark: number | null }[];
  ledger: LedgerHealth;
}

export interface DailyPnl {
  days: {
    date: string;
    netUsd: number;
    grossUsd: number;
    chargesUsd: number;
    trades: number;
    wins: number;
    losses: number;
    cumulativeUsd: number;
  }[];
  bestDayUsd: number;
  worstDayUsd: number;
  profitableDays: number;
  losingDays: number;
}

export interface DecisionMix {
  windowDays: number;
  mix: { label: string; value: number; tone: string }[];
  totals: {
    scans: number;
    opportunities: number;
    open: number;
    watch: number;
    veto: number;
    noSetup: number;
    long: number;
    short: number;
  };
  blockedBy: { reason: string; count: number }[];
  byArchetype: { archetype: string; found: number; open: number }[];
  byAsset: { asset: string; count: number }[];
}

export interface OrderRow {
  id: string;
  asset: Asset;
  direction: Direction;
  archetype: string;
  regime: string;
  openedAt: number;
  closedAt: number | null;
  entryPrice: number;
  exitPrice: number | null;
  lots: number | null;
  quantity: number;
  notionalUsd: number;
  status: "OPEN" | "CLOSED";
  venue: "SIMULATED" | "DELTA";
  executionStatus: string;
  reason: string;
  exitReason: string | null;
  grossPnlUsd: number;
  chargesUsd: number;
  netPnlUsd: number | null;
  pnlPct: number | null;
  rMultiple: number | null;
  cumulativeNetUsd: number;
  charges: TradeCharges;
}

export interface OrderHistory {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rows: OrderRow[];
}

export interface TrainingMonitor {
  strategyPnlUsd: number;
  executionPnlUsd: number;
  chargeCostUsd: number;
  slippageUsd: number;
  executionGapUsd: number;
  decisionWinRate: number;
  predictedWinRate: number;
  calibrationGap: number;
  scoredTrades: number;
  unscoredTrades: number;
  liveTrades: number;
  simulatedTrades: number;
  blockedLast30d: { reason: string; count: number }[];
  recentClosed: {
    id: string;
    asset: Asset;
    direction: Direction;
    closedAt: number | null;
    entryPrice: number;
    exitPrice: number | null;
    grossPnlUsd: number;
    chargesUsd: number;
    netPnlUsd: number;
    slippage: number | null;
    exitReason: string | null;
  }[];
}

export interface TaxPosition {
  financialYear: string;
  availableYears: string[];
  winningTrades: number;
  losingTrades: number;
  totalGainUsd: number;
  totalLossUsd: number;
  netPnlUsd: number;
  taxableGainUsd: number;
  estimatedTaxUsd: number;
  estimatedTaxInr: number;
  afterTaxUsd: number;
  effectiveRate: number;
  note: string;
  charges: { tradingFeeUsd: number; gstUsd: number; tdsUsd: number; totalUsd: number };
  rates: TradeCharges["rates"];
  /** Where each rate came from — a live feed, or the configured fallback. */
  provenance?: {
    usdInr: { value: number; source: string; fetchedAt: number | null; error: string | null };
    fees: { source: string; fetchedAt: number | null; error: string | null };
    statutory: { source: string; note: string };
  };
  estimated: boolean;
}

async function mutate<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as any).ok === false) {
    throw new Error((body as any).error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  status: () =>
    fetch("/api/status").then((r) =>
      json<{
        engine: EngineState;
        role?: EngineRole;
        assets: Asset[];
        interval: string;
        scans: ScanInfo[];
        live?: LiveTradingStatus;
        ledger?: LedgerHealth;
        stopBlockers?: StopBlocker[];
      }>(r)
    ),
  analyticsSummary: () => fetch("/api/analytics/summary").then((r) => json<AnalyticsSummary>(r)),
  analyticsDaily: (days = 60) => fetch("/api/analytics/daily?days=" + days).then((r) => json<DailyPnl>(r)),
  decisionMix: (days = 30) => fetch("/api/analytics/decision-mix?days=" + days).then((r) => json<DecisionMix>(r)),
  orderHistory: (page = 1, pageSize = 10, params: Record<string, string> = {}) =>
    fetch("/api/analytics/orders?" + new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...params })).then(
      (r) => json<OrderHistory>(r)
    ),
  trainingMonitor: () => fetch("/api/analytics/training").then((r) => json<TrainingMonitor>(r)),
  taxPosition: (fy?: string) =>
    fetch("/api/analytics/tax" + (fy ? "?fy=" + fy : "")).then((r) => json<TaxPosition>(r)),
  startEngine: () => fetch("/api/engine/start", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  stopEngine: () => fetch("/api/engine/stop", { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  candles: (asset: Asset) => fetch(`/api/candles/${asset}`).then((r) => json<Candle[]>(r)),
  trades: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`/api/trades${qs ? `?${qs}` : ""}`).then((r) => json<Trade[]>(r));
  },
  equityCurve: () => fetch("/api/equity-curve").then((r) => json<PnlPoint[]>(r)),
  balance: () => fetch("/api/balance").then((r) => json<BalanceInfo>(r)),
  positions: () =>
    fetch("/api/positions").then((r) => json<{ positions: Position[]; totalUnrealized: number }>(r)),
  closePosition: (id: string) =>
    fetch("/api/positions/" + id + "/close", { method: "POST" }).then((r) => mutate<{ ok: boolean }>(r)),
  updateStop: (id: string, stopPrice: number) =>
    fetch("/api/positions/" + id + "/stop", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopPrice }),
    }).then((r) => mutate<{ ok: boolean }>(r)),
  newsBlackout: () => fetch("/api/news-calendar/blackout").then((r) => json<NewsBlackout>(r)),
  marketCandles: (asset: Asset, resolution: string, limit = 500) =>
    fetch("/api/market/candles/" + asset + "?resolution=" + resolution + "&limit=" + limit).then((r) =>
      json<{ asset: Asset; resolution: string; source: string; warning?: string; candles: Candle[] }>(r)
    ),
  marketTicker: () => fetch("/api/market/ticker").then((r) => json<{ tickers: any[] }>(r)),
  tradeStats: () => fetch("/api/trades/stats").then((r) => json<TradeStats>(r)),
  botStatus: () => fetch("/api/bot/status").then((r) => json<{ bot: BotState; stats: BotStats }>(r)),
  botStart: () => fetch("/api/bot/start", { method: "POST" }).then((r) => json<{ bot: BotState }>(r)),
  botStop: () => fetch("/api/bot/stop", { method: "POST" }).then((r) => json<{ bot: BotState }>(r)),
  botRunNow: () => fetch("/api/bot/run-now", { method: "POST" }).then((r) => json<{ decisions: BotDecision[] }>(r)),
  botDecisions: (limit = 50) =>
    fetch("/api/bot/decisions?limit=" + limit).then((r) => json<{ decisions: BotDecision[] }>(r)),
  botIndicators: () => fetch("/api/bot/indicators").then((r) => json<{ indicators: AssetIndicators[] }>(r)),
  botConfig: (patch: Partial<BotConfig>) =>
    fetch("/api/bot/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ config: BotConfig }>(r)),
  opportunities: () => fetch("/api/opportunities").then((r) => json<Opportunity[]>(r)),
  activity: (days = 90) => fetch("/api/activity?days=" + days).then((r) => json<ActivityData>(r)),
  activityDay: (date: string) => fetch("/api/activity/day?date=" + date).then((r) => json<DayDetail>(r)),
  regime: (asset: Asset) =>
    fetch(`/api/regime/${asset}`).then((r) => json<{ asset: Asset; regime: RegimeSnapshot; fundingRate: number }>(r)),
  forceTrade: (asset: Asset, direction: Direction) =>
    fetch("/api/engine/force-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset, direction }),
    }).then(async (r) => {
      const body = (await r.json()) as { ok: boolean; trade?: Trade; error?: string };
      if (!r.ok || !body.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
      return body.trade!;
    }),
};
